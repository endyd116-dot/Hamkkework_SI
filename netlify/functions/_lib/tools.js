/**
 * AI Function Calling 도구 카탈로그
 *
 * 도메인별 CRUD 도구를 정의합니다. Gemini Native Function Calling API에
 * tool declaration으로 전달되어 AI가 직접 호출할 수 있습니다.
 *
 * 설계 원칙:
 *  - 응답은 최소 필드만 반환 (토큰 절약)
 *  - 긴 텍스트는 80자 truncate
 *  - 목록은 메타데이터(total, returned) + 행 분리
 *  - 어드민/공개 도구 구분 (isAdmin 체크)
 *
 * 데이터 소스: Netlify Blobs ('hamkkework' 스토어)
 *  - sync.js와 동일 스토어를 공유하므로 어드민/고객 모든 브라우저 동기화 데이터에 접근 가능
 */

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'hamkkework';
const MAX_TEXT = 80;          // 긴 문자열 truncate 길이
const MAX_LIST_DEFAULT = 10;  // list 도구 기본 반환 갯수
const MAX_LIST_HARD = 30;     // list 도구 최대 반환 갯수

/* ============================================================
   💰 옵션 4: 도구 결과 LRU 캐시 (5분 TTL)
   - 운영자가 같은 질문 반복 (예: "신규 리드", "통화 요청") 시 캐시 hit
   - Write 계열 도구(update)는 캐시 안 함 (mutation은 항상 실행)
   - Function instance가 warm 상태에서만 유효 (cold start 시 리셋)
   ============================================================ */
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
const TOOL_CACHE_MAX = 100;
const toolCache = new Map();

// 읽기 전용 도구만 캐시 — mutation은 항상 실행
const READ_ONLY_TOOLS = new Set([
  'leads_find', 'leads_list', 'leads_stats',
  'tasks_list',
  'chatlogs_search', 'chatlogs_get',
  'cases_find', 'cases_list',
  'faqs_find',
  'quotes_list',
  'analyze_chat_patterns', // 분석은 read-only, 5분 캐시 OK
  'daily_briefing',        // 일간 요약 read-only
  'revenue_forecast',      // 매출 예측 read-only
  'frozen_response_suggest', // Frozen 후보 분석 read-only
  'calendar_events_list',    // 캘린더 이벤트 조회 read-only
  // update_bot_instruction은 mutation이라 캐시 안 함, get은 매번 최신값 받게 캐시 제외
]);

function makeToolCacheKey(name, args) {
  // args를 정렬해서 같은 인자는 같은 키
  const sorted = Object.keys(args || {}).sort().reduce((o, k) => { o[k] = args[k]; return o; }, {});
  return `${name}::${JSON.stringify(sorted)}`;
}

function toolCacheGet(key) {
  const e = toolCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > TOOL_CACHE_TTL_MS) {
    toolCache.delete(key);
    return null;
  }
  // LRU: 최근 접근을 뒤로
  toolCache.delete(key);
  toolCache.set(key, e);
  return e.data;
}

function toolCacheSet(key, data) {
  if (toolCache.size >= TOOL_CACHE_MAX) {
    const oldest = toolCache.keys().next().value;
    if (oldest) toolCache.delete(oldest);
  }
  toolCache.set(key, { at: Date.now(), data });
}

// 🔄 mutation 도구 → 관련 read-only 도구 캐시 prefix 무효화
function toolCacheInvalidate(prefixes) {
  if (!Array.isArray(prefixes) || !prefixes.length) return;
  for (const k of [...toolCache.keys()]) {
    for (const p of prefixes) {
      if (k.startsWith(p + '::')) { toolCache.delete(k); break; }
    }
  }
}

const TOOL_INVALIDATES = {
  leads_update:           ['leads_find', 'leads_list', 'leads_stats'],
  tasks_update:           ['tasks_list', 'daily_briefing'],
  tasks_delete:           ['tasks_list', 'daily_briefing'],
  create_quote:           ['quotes_list', 'revenue_forecast'],
  add_calendar_note:      ['calendar_events_list'],
  mark_email_sent:        [],
  send_email:             [],
  frozen_response_create: ['frozen_response_suggest'],
  update_bot_instruction: ['get_bot_instruction'],
};

function getBlobsStore() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

async function readCollection(key) {
  try {
    const store = getBlobsStore();
    const data = await store.get(key, { type: 'json' });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn(`[tools] read ${key} failed`, e?.message);
    return [];
  }
}

async function writeCollection(key, data) {
  const store = getBlobsStore();
  await store.setJSON(key, data);
}

async function readChatConfig() {
  try {
    const store = getBlobsStore();
    const data = await store.get('chatConfig', { type: 'json' });
    return (data && typeof data === 'object') ? data : {};
  } catch (e) {
    console.error('[chatConfig:read]', e);
    return {};
  }
}

async function writeChatConfig(cfg) {
  const store = getBlobsStore();
  await store.setJSON('chatConfig', cfg);
}

/** chat.js에서 호출 — 매 응답마다 최신 행동 지침을 Blobs에서 직접 가져옴
 *  (클라이언트 polling 30초 지연을 우회해 update 직후 즉시 적용)
 */
export async function readChatConfigForServer() {
  return readChatConfig();
}

function truncate(s, n = MAX_TEXT) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function withinDays(iso, days) {
  if (!iso || !days) return true;
  return Date.now() - new Date(iso).getTime() < days * 86400000;
}

function parseSince(since) {
  if (!since) return null;
  const m = String(since).match(/^(\d+)(d|w|m)$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    return unit === 'd' ? n : unit === 'w' ? n * 7 : n * 30;
  }
  if (since === 'today') return 1;
  if (since === 'week') return 7;
  if (since === 'month') return 30;
  return null;
}

/* ============================================================
   도구 정의 — declaration + handler 쌍
   ============================================================ */

export const TOOL_CATALOG = {
  // ─────────────────────────────────────────────────────────
  // 리드 (leads) — 4개 도구
  // ─────────────────────────────────────────────────────────
  leads_find: {
    adminOnly: true,
    declaration: {
      name: 'leads_find',
      description: 'Find one lead by name/email/phone.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
        },
      },
    },
    async handler({ name, email, phone }) {
      const leads = await readCollection('leads');
      const match = leads.find((l) => {
        if (name && (l.name || '').includes(name)) return true;
        if (email && (l.email || '').toLowerCase() === String(email).toLowerCase()) return true;
        if (phone && (l.phone || '').replace(/\D/g, '').includes(String(phone).replace(/\D/g, ''))) return true;
        return false;
      });
      if (!match) return { found: false };
      return {
        found: true,
        lead: {
          id: match.id,
          name: match.name,
          email: match.email,
          phone: match.phone,
          company: match.company,
          type: match.type,
          budget: match.budget,
          status: match.status,
          source: match.source,
          message: truncate(match.message),
          createdAt: match.createdAt,
        },
      };
    },
  },

  leads_list: {
    adminOnly: true,
    declaration: {
      name: 'leads_list',
      description: 'List leads, filtered.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'new|consult|quote|contract|won|lost' },
          since: { type: 'string', description: '7d|30d|today|week|month' },
          source: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
    async handler({ status, since, source, limit }) {
      let leads = await readCollection('leads');
      if (status) leads = leads.filter((l) => l.status === status);
      if (source) leads = leads.filter((l) => l.source === source);
      const days = parseSince(since);
      if (days) leads = leads.filter((l) => withinDays(l.createdAt, days));
      const total = leads.length;
      const n = Math.min(Number(limit) || MAX_LIST_DEFAULT, MAX_LIST_HARD);
      const items = leads
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .slice(0, n)
        .map((l) => ({
          id: l.id,
          name: l.name,
          email: l.email,
          type: l.type,
          status: l.status,
          createdAt: l.createdAt,
        }));
      return { total, returned: items.length, items };
    },
  },

  leads_update: {
    adminOnly: true,
    declaration: {
      name: 'leads_update',
      description: 'Update a lead (status/type/budget/note).',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', description: 'new|consult|quote|contract|won|lost' },
          type: { type: 'string' },
          budget: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    async handler({ id, status, type, budget, note }) {
      const leads = await readCollection('leads');
      const idx = leads.findIndex((l) => l.id === id);
      if (idx < 0) return { error: 'lead_not_found', id };
      const patch = {};
      if (status) patch.status = status;
      if (type) patch.type = type;
      if (budget) patch.budget = budget;
      if (note) patch.message = (leads[idx].message || '') + `\n[운영자 메모 ${new Date().toISOString().slice(0,10)}] ${note}`;
      patch.updatedAt = new Date().toISOString();
      leads[idx] = { ...leads[idx], ...patch };
      await writeCollection('leads', leads);
      return { ok: true, lead: { id, ...patch, name: leads[idx].name } };
    },
  },

  leads_stats: {
    adminOnly: true,
    declaration: {
      name: 'leads_stats',
      description: 'Lead counts by status/source.',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'string', description: '7d|30d|month' },
        },
      },
    },
    async handler({ since }) {
      let leads = await readCollection('leads');
      const days = parseSince(since);
      if (days) leads = leads.filter((l) => withinDays(l.createdAt, days));
      const byStatus = {};
      const bySource = {};
      leads.forEach((l) => {
        byStatus[l.status || 'unknown'] = (byStatus[l.status || 'unknown'] || 0) + 1;
        bySource[l.source || 'website'] = (bySource[l.source || 'website'] || 0) + 1;
      });
      return {
        total: leads.length,
        byStatus,
        bySource,
        period: since || 'all-time',
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 작업 큐 (scheduledTasks) — 2개 도구
  // ─────────────────────────────────────────────────────────
  tasks_list: {
    adminOnly: true,
    declaration: {
      name: 'tasks_list',
      description: 'List scheduled tasks (callbacks/followups).',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'callback_request|followup_email' },
          status: { type: 'string', description: 'pending|done|cancelled' },
          urgency: { type: 'string', description: 'urgent|normal' },
          limit: { type: 'number' },
        },
      },
    },
    async handler({ type, status, urgency, limit }) {
      let tasks = await readCollection('scheduledTasks');
      tasks = tasks.filter((t) => t.status === (status || 'pending'));
      if (type) tasks = tasks.filter((t) => t.type === type);
      if (urgency) tasks = tasks.filter((t) => t.urgency === urgency);
      const total = tasks.length;
      const n = Math.min(Number(limit) || MAX_LIST_DEFAULT, MAX_LIST_HARD);
      const items = tasks
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .slice(0, n)
        .map((t) => ({
          id: t.id,
          type: t.type,
          leadName: t.leadName,
          leadEmail: t.leadEmail,
          contact: t.contact,
          method: t.method,
          topic: truncate(t.topic, 40),
          subject: truncate(t.subject, 40),
          urgency: t.urgency,
          scheduledAt: t.scheduledAt,
          createdAt: t.createdAt,
        }));
      return { total, returned: items.length, items };
    },
  },

  tasks_update: {
    adminOnly: true,
    declaration: {
      name: 'tasks_update',
      description: 'Update task status.',
      parameters: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', description: 'done|cancelled|pending' },
          note: { type: 'string' },
        },
      },
    },
    async handler({ id, status, note }) {
      const tasks = await readCollection('scheduledTasks');
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx < 0) return { error: 'task_not_found', id };
      const patch = {
        status,
        updatedAt: new Date().toISOString(),
      };
      if (status === 'done') patch.resolvedAt = patch.updatedAt;
      if (note) patch.resolveNote = note;
      tasks[idx] = { ...tasks[idx], ...patch };
      await writeCollection('scheduledTasks', tasks);
      return { ok: true, task: { id, status, leadName: tasks[idx].leadName } };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 챗봇 대화 (chatLogs) — 2개 도구
  // ─────────────────────────────────────────────────────────
  chatlogs_search: {
    adminOnly: true,
    declaration: {
      name: 'chatlogs_search',
      description: 'Search chat sessions by keyword.',
      parameters: {
        type: 'object',
        required: ['keyword'],
        properties: {
          keyword: { type: 'string' },
          since: { type: 'string', description: '7d|30d' },
          limit: { type: 'number' },
        },
      },
    },
    async handler({ keyword, since, limit }) {
      const logs = await readCollection('chatLogs');
      const days = parseSince(since) || 30;
      const kw = String(keyword).toLowerCase();
      const matches = logs.filter((l) => {
        if (!withinDays(l.updatedAt, days)) return false;
        return (l.messages || []).some((m) => (m.text || '').toLowerCase().includes(kw));
      });
      const n = Math.min(Number(limit) || MAX_LIST_DEFAULT, MAX_LIST_HARD);
      const items = matches
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, n)
        .map((l) => ({
          sessionId: l.sessionId,
          messageCount: (l.messages || []).length,
          variant: l.variant,
          updatedAt: l.updatedAt,
          firstUserMessage: truncate(((l.messages || []).find((m) => m.role === 'user') || {}).text, 60),
        }));
      return { total: matches.length, returned: items.length, items };
    },
  },

  chatlogs_get: {
    adminOnly: true,
    declaration: {
      name: 'chatlogs_get',
      description: 'Get full chat session by ID.',
      parameters: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
        },
      },
    },
    async handler({ sessionId }) {
      const logs = await readCollection('chatLogs');
      const log = logs.find((l) => l.sessionId === sessionId);
      if (!log) return { error: 'session_not_found', sessionId };
      return {
        sessionId,
        variant: log.variant,
        updatedAt: log.updatedAt,
        messages: (log.messages || []).map((m) => ({
          role: m.role,
          text: truncate(m.text, 200),
          at: m.at,
        })),
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 케이스/레퍼런스 (cases) — 2개 도구 (고객+운영자 공용)
  // ─────────────────────────────────────────────────────────
  cases_find: {
    adminOnly: false,
    declaration: {
      name: 'cases_find',
      description: 'Search reference cases by keyword/tag.',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          tag: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
    async handler({ keyword, tag, limit }) {
      const cases = await readCollection('cases');
      const published = cases.filter((c) => c.published !== false);
      let matches = published;
      if (keyword) {
        const kw = String(keyword).toLowerCase();
        matches = matches.filter((c) => {
          const hay = [c.label, c.client, c.title, c.description, ...(c.tags || []), ...(c.features || [])]
            .filter(Boolean).join(' ').toLowerCase();
          return hay.includes(kw);
        });
      }
      if (tag) {
        const t = String(tag).toLowerCase();
        matches = matches.filter((c) => (c.tags || []).some((x) => String(x).toLowerCase().includes(t)));
      }
      const n = Math.min(Number(limit) || 3, 5);
      const items = matches.slice(0, n).map((c) => ({
        id: c.id,
        label: c.label,
        client: c.client,
        title: c.title,
        amount: c.amount,
        year: c.year,
        tags: c.tags,
        description: truncate(c.description, 120),
      }));
      return { total: matches.length, returned: items.length, items };
    },
  },

  cases_list: {
    adminOnly: true,
    declaration: {
      name: 'cases_list',
      description: 'List all cases (incl. private).',
      parameters: {
        type: 'object',
        properties: {
          published: { type: 'boolean' },
          limit: { type: 'number' },
        },
      },
    },
    async handler({ published, limit }) {
      let cases = await readCollection('cases');
      if (typeof published === 'boolean') {
        cases = cases.filter((c) => (c.published !== false) === published);
      }
      const total = cases.length;
      const n = Math.min(Number(limit) || MAX_LIST_DEFAULT, MAX_LIST_HARD);
      const items = cases.slice(0, n).map((c) => ({
        id: c.id,
        label: c.label,
        client: c.client,
        title: c.title,
        amount: c.amount,
        published: c.published !== false,
        aiDraft: !!c.aiDraft,
      }));
      return { total, returned: items.length, items };
    },
  },

  // ─────────────────────────────────────────────────────────
  // FAQ — 1개 도구 (고객 공용)
  // ─────────────────────────────────────────────────────────
  faqs_find: {
    adminOnly: false,
    declaration: {
      name: 'faqs_find',
      description: 'Find FAQ entries by keyword.',
      parameters: {
        type: 'object',
        required: ['keyword'],
        properties: {
          keyword: { type: 'string' },
        },
      },
    },
    async handler({ keyword }) {
      const faqs = await readCollection('faqs');
      const kw = String(keyword).toLowerCase();
      const ranked = faqs
        .map((f) => {
          const text = `${f.q || ''} ${f.a || ''}`.toLowerCase();
          let score = 0;
          if (text.includes(kw)) score += 10;
          kw.split(/\s+/).forEach((w) => { if (w.length > 1 && text.includes(w)) score += 1; });
          return { f, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      return {
        total: ranked.length,
        items: ranked.map((x) => ({ q: x.f.q, a: truncate(x.f.a, 200) })),
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 견적 (quotes) — 1개 도구 (운영자)
  // ─────────────────────────────────────────────────────────
  quotes_list: {
    adminOnly: true,
    declaration: {
      name: 'quotes_list',
      description: 'List quotes.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'ai-draft|reviewed|sent|accepted|rejected' },
          since: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
    async handler({ status, since, limit }) {
      let quotes = await readCollection('quotes');
      if (status) quotes = quotes.filter((q) => q.status === status);
      const days = parseSince(since);
      if (days) quotes = quotes.filter((q) => withinDays(q.createdAt, days));
      const n = Math.min(Number(limit) || MAX_LIST_DEFAULT, MAX_LIST_HARD);
      const total = quotes.length;
      const items = quotes
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .slice(0, n)
        .map((q) => ({
          id: q.id,
          title: q.title,
          clientName: q.clientName,
          total: q.total,
          status: q.status,
          itemCount: (q.items || []).length,
          createdAt: q.createdAt,
        }));
      return { total, returned: items.length, items };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 캘린더 이벤트 조회 (calendar_events_list)
  // 어드민 챗봇: "내일 일정", "이번주 콜백", "5월 15일 뭐 있어"
  // ─────────────────────────────────────────────────────────
  calendar_events_list: {
    adminOnly: true,
    declaration: {
      name: 'calendar_events_list',
      description: 'List calendar events for a date or range. Returns callbacks, project milestones, quotes, leads, invoices, notes. Use when admin asks "오늘 일정"/"내일 뭐 있어"/"이번주 콜백"/"5월 15일 일정". Auto-resolve relative dates using today\'s date from system context.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD (특정 날짜)' },
          start_date: { type: 'string', description: 'YYYY-MM-DD (범위 시작)' },
          end_date: { type: 'string', description: 'YYYY-MM-DD (범위 끝)' },
          types: { type: 'array', description: 'callback|project|quote|lead|invoice|note 필터 (생략 시 모두)', items: { type: 'string' } },
        },
      },
    },
    async handler({ date, start_date, end_date, types }) {
      let from, to;
      const today = new Date().toISOString().slice(0, 10);
      if (date) from = to = date;
      else if (start_date && end_date) { from = start_date; to = end_date; }
      else { from = to = today; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return { error: 'invalid_date_format', expected: 'YYYY-MM-DD', from, to };
      }
      const filterTypes = Array.isArray(types) ? new Set(types) : null;
      const include = (t) => !filterTypes || filterTypes.size === 0 || filterTypes.has(t);

      const [tasks, projects, quotes, leads, invoices, notes] = await Promise.all([
        readCollection('scheduledTasks'),
        readCollection('projects'),
        readCollection('quotes'),
        readCollection('leads'),
        readCollection('invoices'),
        readCollection('calendarNotes'),
      ]);

      const events = [];
      const inRange = (iso) => {
        if (!iso) return false;
        const d = String(iso).slice(0, 10);
        return d >= from && d <= to;
      };

      if (include('callback')) {
        for (const t of tasks) {
          if (t.type !== 'callback_request') continue;
          const dateIso = t.scheduledAt || t.createdAt;
          if (!inRange(dateIso)) continue;
          events.push({
            type: 'callback',
            date: String(dateIso).slice(0, 10),
            title: `${t.leadName || '고객'} 콜백`,
            urgent: t.urgency === 'urgent',
            contact: t.contact,
            method: t.method,
            preferredTime: t.preferredTime,
            status: t.status,
            id: t.id,
          });
        }
      }
      if (include('project')) {
        for (const p of projects) {
          if (inRange(p.startDate)) events.push({ type: 'project_start', date: String(p.startDate).slice(0, 10), title: p.title || p.clientName, clientName: p.clientName, id: p.id });
          const due = p.deadline || p.endDate;
          if (inRange(due)) events.push({ type: 'project_due', date: String(due).slice(0, 10), title: p.title || p.clientName, clientName: p.clientName, id: p.id });
        }
      }
      if (include('quote')) {
        for (const q of quotes) {
          if (inRange(q.createdAt)) events.push({ type: 'quote', date: String(q.createdAt).slice(0, 10), title: q.title, clientName: q.clientName, total: q.total, status: q.status, id: q.id });
        }
      }
      if (include('lead')) {
        for (const l of leads) {
          if (inRange(l.createdAt)) events.push({ type: 'lead', date: String(l.createdAt).slice(0, 10), title: l.name, company: l.company, status: l.status, id: l.id });
        }
      }
      if (include('invoice')) {
        for (const inv of invoices) {
          if (inRange(inv.dueDate)) events.push({ type: 'invoice_due', date: String(inv.dueDate).slice(0, 10), title: inv.clientName, amount: inv.amount, status: inv.status, id: inv.id });
        }
      }
      if (include('note')) {
        for (const n of notes) {
          if (n.date >= from && n.date <= to) events.push({ type: 'note', date: n.date, title: n.text, color: n.color, id: n.id });
        }
      }

      return {
        range: { from, to },
        today,
        count: events.length,
        events: events.sort((a, b) => a.date.localeCompare(b.date) || (a.preferredTime || '').localeCompare(b.preferredTime || '')),
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 캘린더 개인 메모 추가 (add_calendar_note)
  // 어드민 챗봇: "내일 9시 임원회의 메모 추가해줘"
  // ─────────────────────────────────────────────────────────
  add_calendar_note: {
    adminOnly: true,
    declaration: {
      name: 'add_calendar_note',
      description: 'Add a personal note to the admin calendar on a specific date. Use when admin says "내일 ○○ 메모 추가해줘"/"5월 15일에 ○○ 일정 적어줘". Date format YYYY-MM-DD (resolve from today\'s context).',
      parameters: {
        type: 'object',
        required: ['date', 'text'],
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD (절대 형식)' },
          text: { type: 'string', description: '메모 내용 (간결하게)' },
          color: { type: 'string', description: '색상 hex: #10b981(녹)/#0866ff(파)/#f59e0b(노)/#dc2626(빨)/#7c3aed(보) — 기본 녹색' },
        },
      },
    },
    async handler({ date, text, color }) {
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'invalid_date', expected: 'YYYY-MM-DD', got: date };
      if (!text || !String(text).trim()) return { error: 'text_required' };
      const valid = ['#10b981', '#0866ff', '#f59e0b', '#dc2626', '#7c3aed'];
      const col = valid.includes(color) ? color : '#10b981';
      const notes = await readCollection('calendarNotes');
      const newNote = {
        id: 'note_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        date,
        text: String(text).trim(),
        color: col,
        createdAt: new Date().toISOString(),
        createdBy: 'ai',
      };
      notes.unshift(newNote);
      await writeCollection('calendarNotes', notes);
      return {
        ok: true,
        id: newNote.id,
        date: newNote.date,
        text: newNote.text,
        note: '어드민 캘린더에 메모가 추가되었습니다.',
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 견적서 생성 (create_quote) — 자연어로 견적서 quotes 컬렉션에 추가
  // ─────────────────────────────────────────────────────────
  create_quote: {
    adminOnly: true,
    declaration: {
      name: 'create_quote',
      description: 'Create a quote record in quotes collection. Use when admin says "정수민 견적서 만들어줘", "○○ 프로젝트 견적 등록해줘". Required: clientName, items[], total. Optional: leadId, title, notes.',
      parameters: {
        type: 'object',
        required: ['clientName', 'items', 'total'],
        properties: {
          clientName: { type: 'string', description: '클라이언트(고객) 이름' },
          title: { type: 'string', description: '프로젝트 제목 (예: 학원 인원관리 시스템 MVP)' },
          items: {
            type: 'array',
            description: '견적 라인 항목 배열',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: '항목명 (예: 페이지 단순 10개)' },
                amount: { type: 'number', description: '만원 단위 금액' },
              },
            },
          },
          total: { type: 'number', description: '총 합계 (만원 단위, 오버헤드 포함)' },
          overhead: { type: 'number', description: '오버헤드 비율 % (default 25)' },
          tier: { type: 'string', description: 'mvp|small|medium|large' },
          notes: { type: 'string', description: '특이사항·가정' },
          leadId: { type: 'string', description: '관련 리드 id (선택)' },
          status: { type: 'string', description: 'ai-draft|reviewed|sent|accepted|rejected (default ai-draft)' },
        },
      },
    },
    async handler({ clientName, title, items, total, overhead, tier, notes, leadId, status }) {
      if (!clientName || !clientName.trim()) return { error: 'clientName_required' };
      if (!Array.isArray(items) || items.length === 0) return { error: 'items_required' };
      if (typeof total !== 'number' || total <= 0) return { error: 'total_invalid' };
      const quotes = await readCollection('quotes');
      const newQuote = {
        id: 'quote_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        clientName: String(clientName).trim(),
        title: (title || `${clientName}님 견적`).trim(),
        items: items.map((it) => ({
          label: String(it.label || '').trim(),
          amount: Number(it.amount) || 0,
        })).filter((it) => it.label),
        total: Math.round(Number(total)),
        overhead: Number(overhead) || 25,
        tier: tier || null,
        notes: (notes || '').trim(),
        leadId: leadId || null,
        status: status || 'ai-draft',
        createdAt: new Date().toISOString(),
        createdBy: 'ai',
      };
      quotes.unshift(newQuote);
      await writeCollection('quotes', quotes);
      return {
        ok: true,
        id: newQuote.id,
        title: newQuote.title,
        total: newQuote.total,
        itemCount: newQuote.items.length,
        note: '어드민 페이지 > 견적서 메뉴에서 검토 후 PDF 출력·메일 발송 가능합니다.',
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 이메일 드래프트 발송 완료 표시 (mark_email_sent)
  // PM이 mailto로 직접 보낸 후 챗봇에 알릴 때 사용
  // ─────────────────────────────────────────────────────────
  mark_email_sent: {
    adminOnly: true,
    declaration: {
      name: 'mark_email_sent',
      description: 'Mark an email draft as sent. Use when admin says "방금 메일 보냈어, 발송 완료 표시해줘" / "○○ 메일 발송됨".',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'emailDrafts.id' },
          note: { type: 'string', description: '발송 메모 (선택)' },
        },
      },
    },
    async handler({ id, note }) {
      if (!id) return { error: 'id_required' };
      const drafts = await readCollection('emailDrafts');
      const idx = drafts.findIndex((d) => d.id === id);
      if (idx < 0) return { error: 'draft_not_found', id };
      drafts[idx] = {
        ...drafts[idx],
        status: 'sent',
        sentAt: new Date().toISOString(),
        sentBy: 'pm-via-bot',
        sentNote: note || '',
      };
      await writeCollection('emailDrafts', drafts);
      return {
        ok: true,
        id,
        to: drafts[idx].to,
        subject: drafts[idx].subject,
        note: '발송 완료로 표시했습니다.',
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 작업 삭제 (tasks_delete) — 콜백/팔로업 취소
  // ─────────────────────────────────────────────────────────
  tasks_delete: {
    adminOnly: true,
    declaration: {
      name: 'tasks_delete',
      description: 'Delete a task from scheduledTasks. Use for cancellation. Differs from tasks_update which marks status; this removes entirely. Use when admin says "○○ 콜백 취소"/"삭제해줘". For multiple deletions, call once per id.',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'scheduledTasks.id' },
          reason: { type: 'string', description: '취소 사유 (선택, 로그용)' },
        },
      },
    },
    async handler({ id, reason }) {
      if (!id) return { error: 'id_required' };
      const tasks = await readCollection('scheduledTasks');
      const target = tasks.find((t) => t.id === id);
      if (!target) return { error: 'task_not_found', id };
      const remaining = tasks.filter((t) => t.id !== id);
      await writeCollection('scheduledTasks', remaining);
      console.log(`[delete_task] removed ${id} (${target.leadName}) reason=${reason || ''}`);
      return {
        ok: true,
        deleted: { id, leadName: target.leadName, type: target.type },
        reason: reason || null,
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 이메일 발송 — Resend 연동 (없으면 drafts에 저장 → PM 수동 발송)
  // ─────────────────────────────────────────────────────────
  send_email: {
    adminOnly: true,
    declaration: {
      name: 'send_email',
      description: 'Send or draft an email. If RESEND_API_KEY is set, sends immediately; otherwise saves as draft in emailDrafts for PM to send manually. Use for callback confirmations, quote sending, follow-ups, etc.',
      parameters: {
        type: 'object',
        required: ['to', 'subject', 'body'],
        properties: {
          to: { type: 'string', description: '수신자 이메일 (또는 콤마 구분 다수)' },
          subject: { type: 'string', description: '제목 (간결하게)' },
          body: { type: 'string', description: '본문 (한국어, 평문 또는 간단 마크다운). 인사+본문+서명 포함.' },
          leadName: { type: 'string', description: '관련 리드/고객 이름 (어드민 식별용, 선택)' },
          leadId: { type: 'string', description: '관련 lead id (선택)' },
          purpose: { type: 'string', description: 'callback_confirm | quote_send | followup | general' },
        },
      },
    },
    async handler({ to, subject, body, leadName, leadId, purpose }) {
      if (!to || !/.+@.+\..+/.test(String(to).trim())) return { error: 'invalid_to_email', to };
      if (!subject || !subject.trim()) return { error: 'subject_required' };
      if (!body || !body.trim()) return { error: 'body_required' };

      const settings = await readChatConfig().catch(() => ({}));
      const draft = {
        id: 'mail_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        to: String(to).trim(),
        subject: String(subject).trim(),
        body: String(body).trim(),
        leadName: leadName || null,
        leadId: leadId || null,
        purpose: purpose || 'general',
        status: 'draft',
        createdAt: new Date().toISOString(),
        createdBy: 'ai',
      };

      const apiKey = process.env.RESEND_API_KEY;
      const fromAddr = process.env.RESEND_FROM || 'onboarding@resend.dev';
      if (apiKey) {
        try {
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: fromAddr,
              to: [draft.to],
              subject: draft.subject,
              text: draft.body,
            }),
          });
          if (r.ok) {
            const json = await r.json().catch(() => ({}));
            draft.status = 'sent';
            draft.sentAt = new Date().toISOString();
            draft.providerId = json.id || null;
          } else {
            const errText = await r.text().catch(() => '');
            draft.status = 'failed';
            draft.error = `Resend ${r.status}: ${errText.slice(0, 200)}`;
          }
        } catch (e) {
          draft.status = 'failed';
          draft.error = String(e?.message || e);
        }
      } else {
        draft.note = 'RESEND_API_KEY 미설정 — drafts에 저장됨. 어드민 페이지에서 검토·수동 발송 가능.';
      }

      // emailDrafts에 push
      const drafts = await readCollection('emailDrafts');
      drafts.unshift(draft);
      await writeCollection('emailDrafts', drafts);

      return {
        ok: true,
        id: draft.id,
        status: draft.status,
        to: draft.to,
        subject: draft.subject,
        autoSent: draft.status === 'sent',
        note: draft.note || (draft.status === 'sent'
          ? '발송 완료'
          : draft.status === 'failed'
            ? `발송 실패: ${draft.error?.slice(0, 100)}`
            : '드래프트로 저장됨'),
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // Frozen Response 제안 + 채택 (Q&A 자동 캐싱으로 AI 비용 절감)
  // ─────────────────────────────────────────────────────────
  frozen_response_suggest: {
    adminOnly: true,
    declaration: {
      name: 'frozen_response_suggest',
      description: 'Suggest frozen response candidates from chat history — frequently asked questions that could be cached for cost savings. Use when admin asks "자주 묻는 질문 캐싱", "AI 비용 줄여줘", "frozen 후보 찾아줘".',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'string', description: '7d|30d|90d (default 30d)' },
          min_count: { type: 'number', description: '최소 반복 횟수 (default 3)' },
        },
      },
    },
    async handler({ since, min_count }) {
      const days = parseSince(since) || 30;
      const minCount = Math.max(2, Number(min_count) || 3);

      const [logs, frozen] = await Promise.all([
        readCollection('chatLogs'),
        readCollection('frozenResponses'),
      ]);

      const existingFrozenKeywords = new Set();
      for (const f of frozen) {
        for (const k of (f.keywords || [])) existingFrozenKeywords.add(String(k).toLowerCase());
      }

      // 최근 N일 사용자 질문 + 그 직후 봇 답변
      const recent = logs.filter((l) => withinDays(l.updatedAt, days));
      const pairs = [];
      for (const log of recent) {
        const msgs = log.messages || [];
        for (let i = 0; i < msgs.length - 1; i++) {
          if (msgs[i].role !== 'user' || !msgs[i].text) continue;
          const next = msgs[i + 1];
          if (next?.role === 'bot' && next.text) {
            pairs.push({ q: msgs[i].text.trim(), a: next.text.trim() });
          }
        }
      }

      // 질문 정규화 (조사·문장부호 제거, 짧은 키워드만)
      const normalize = (s) => s
        .toLowerCase()
        .replace(/[?!.,~"'`]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const STOPWORDS = new Set(['있어', '있나요', '뭐예요', '인가요', '입니까', '있나', '되나요', '뭐가']);

      // 질문 패턴 빈도 — 정규화된 첫 6단어
      const patternCounts = new Map();
      for (const p of pairs) {
        const norm = normalize(p.q);
        const words = norm.split(' ').filter((w) => w.length >= 2 && !STOPWORDS.has(w));
        if (words.length < 1) continue;
        const key = words.slice(0, 6).join(' ');
        if (key.length < 5) continue;
        if (!patternCounts.has(key)) patternCounts.set(key, { count: 0, samples: [] });
        const entry = patternCounts.get(key);
        entry.count++;
        if (entry.samples.length < 3) entry.samples.push({ q: p.q, a: p.a.slice(0, 200) });
      }

      // minCount 이상 + 기존 frozen에 없는 것
      const candidates = [...patternCounts.entries()]
        .filter(([key, v]) => v.count >= minCount)
        .filter(([key]) => {
          const firstWord = key.split(' ')[0];
          return !existingFrozenKeywords.has(firstWord);
        })
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 8)
        .map(([key, v]) => ({
          pattern_key: key,
          frequency: v.count,
          sample_question: v.samples[0]?.q,
          sample_answer_excerpt: v.samples[0]?.a,
          suggested_keywords: key.split(' ').slice(0, 4),
        }));

      return {
        period_days: days,
        total_pairs_analyzed: pairs.length,
        existing_frozen: frozen.length,
        candidates,
        cost_saving_hint: candidates.length > 0
          ? `${candidates.reduce((s, c) => s + c.frequency, 0)}회 호출 절감 가능 (대략 $${(candidates.reduce((s, c) => s + c.frequency, 0) * 0.0003).toFixed(3)} / 이 기간 기준)`
          : '신규 후보 없음',
        hint: 'AI가 후보들을 정리해 PM에게 제시 + PM 동의 시 frozen_response_create로 채택. 자동 채택 금지.',
      };
    },
  },

  frozen_response_create: {
    adminOnly: true,
    declaration: {
      name: 'frozen_response_create',
      description: 'Create a frozen response from a suggested pattern. Call ONLY after admin explicit consent.',
      parameters: {
        type: 'object',
        required: ['keywords', 'answer'],
        properties: {
          keywords: { type: 'array', description: '매칭할 키워드 배열 (소문자, 부분 일치)', items: { type: 'string' } },
          answer: { type: 'string', description: '캐싱할 답변 (한국어, 자연스럽게)' },
          label: { type: 'string', description: '관리용 라벨 (예: "환불 정책 설명")' },
        },
      },
    },
    async handler({ keywords, answer, label }) {
      if (!Array.isArray(keywords) || keywords.length === 0) return { error: 'keywords_required' };
      if (!answer || !answer.trim()) return { error: 'answer_required' };

      const frozen = await readCollection('frozenResponses');
      const newFr = {
        id: 'fr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        label: label || keywords.slice(0, 2).join(' '),
        keywords: keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean),
        answer: answer.trim(),
        createdAt: new Date().toISOString(),
        createdBy: 'ai-suggest',
        hits: 0,
      };
      frozen.unshift(newFr);
      await writeCollection('frozenResponses', frozen);
      return {
        ok: true,
        id: newFr.id,
        keywords: newFr.keywords,
        note: '다음 사용자 질문부터 매칭 시 AI 호출 없이 즉시 답변 (비용 절감).',
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 매출 예측 (revenue_forecast)
  // 파이프라인 단계별 전환율 + 평균 견적가로 예상 매출 산출
  // ─────────────────────────────────────────────────────────
  revenue_forecast: {
    adminOnly: true,
    declaration: {
      name: 'revenue_forecast',
      description: 'Forecast revenue from current pipeline. Analyzes lead stages, conversion rates, and quote averages. Use when admin asks "예상 매출" / "파이프라인 분석" / "이번달 매출 예측" / "수주 예상".',
      parameters: {
        type: 'object',
        properties: {
          horizon: { type: 'string', description: 'month | quarter (default: month)' },
        },
      },
    },
    async handler({ horizon }) {
      const h = (horizon || 'month').toLowerCase();
      const [leads, quotes] = await Promise.all([
        readCollection('leads'),
        readCollection('quotes'),
      ]);

      // 단계 카운트
      const stages = ['new', 'consult', 'quote', 'contract', 'won', 'lost'];
      const counts = {};
      for (const s of stages) counts[s] = leads.filter((l) => l.status === s).length;

      // 전환율 — 단순 (현재 단계 수 / 이전 단계 + 현재 단계)
      // 더 정확하려면 history 추적 필요. 일단 간단한 누적 비율.
      const won = counts.won || 0;
      const lost = counts.lost || 0;
      const total = leads.length;
      const closed = won + lost;
      const winRate = closed > 0 ? won / closed : 0;

      // 평균 수주 금액 (won + 견적 있는 리드)
      const wonLeads = leads.filter((l) => l.status === 'won');
      const validAmounts = [];
      for (const q of quotes) {
        if (Number(q.total) > 0) validAmounts.push(Number(q.total));
      }
      // 견적이 없으면 budget 문자열 추정 (대략)
      if (validAmounts.length === 0) {
        const BUDGET_MID = { '~1천만': 700, '1천~3천': 2000, '3천~1억': 6500, '1억~5억': 30000, '5억+': 70000 };
        for (const l of leads) {
          const mid = BUDGET_MID[l.budget];
          if (mid) validAmounts.push(mid);
        }
      }
      const avgQuote = validAmounts.length > 0
        ? validAmounts.reduce((s, n) => s + n, 0) / validAmounts.length
        : 0;

      // 파이프라인 단계별 예상 수주 (단계가 뒤로 갈수록 win 확률 높음)
      // 단순 가중치: new=0.1, consult=0.25, quote=0.5, contract=0.85
      const stageWinProb = { new: 0.1, consult: 0.25, quote: 0.5, contract: 0.85 };
      let pipelineExpected = 0;
      const pipelineBreakdown = {};
      for (const stage of ['new', 'consult', 'quote', 'contract']) {
        const n = counts[stage] || 0;
        const expected = n * (stageWinProb[stage] || 0) * avgQuote;
        pipelineExpected += expected;
        pipelineBreakdown[stage] = {
          leads: n,
          win_prob: stageWinProb[stage],
          expected_revenue_manwon: Math.round(expected),
        };
      }

      // 신뢰 구간 (±20%)
      const lo = Math.round(pipelineExpected * 0.8);
      const hi = Math.round(pipelineExpected * 1.2);

      return {
        horizon: h,
        pipeline_counts: counts,
        total_leads: total,
        closed_leads: closed,
        win_rate_pct: Math.round(winRate * 100),
        avg_quote_manwon: Math.round(avgQuote),
        avg_quote_source: validAmounts.length > 0 && quotes.length > 0 ? 'quotes' : 'budget_estimate',
        pipeline_breakdown: pipelineBreakdown,
        expected_revenue_manwon: Math.round(pipelineExpected),
        expected_range: { low: lo, high: hi },
        note: validAmounts.length === 0
          ? '견적 데이터 부족 — budget 필드 중간값으로 추정. 견적 등록 후 더 정확'
          : `${validAmounts.length}개 견적/리드 평균 기반`,
        hint: 'AI가 단계별 깔때기 + 예상 매출 + 가정·제약 자연어로 정리. 단순 숫자 나열 X',
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 일간 운영 요약 (daily_briefing)
  // 운영자 모드 또는 cron이 호출 → 어제·오늘 핵심 지표 한눈에
  // ─────────────────────────────────────────────────────────
  daily_briefing: {
    adminOnly: true,
    declaration: {
      name: 'daily_briefing',
      description: 'Generate a daily operations briefing — yesterday/today metrics: new leads, callback requests, quotes sent, fallback rate, AI cost. Use when admin says "오늘 요약" / "일간 보고" / "어제 어땠어" / "운영 현황".',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD (default: today). 특정 날짜 요약' },
        },
      },
    },
    async handler({ date }) {
      const target = date ? new Date(date) : new Date();
      target.setHours(0, 0, 0, 0);
      const targetEnd = new Date(target); targetEnd.setHours(23, 59, 59, 999);
      const yesterday = new Date(target); yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayEnd = new Date(yesterday); yesterdayEnd.setHours(23, 59, 59, 999);

      const inRange = (iso, start, end) => {
        if (!iso) return false;
        const t = new Date(iso).getTime();
        return t >= start.getTime() && t <= end.getTime();
      };

      const [leads, tasks, logs, quotes, usage] = await Promise.all([
        readCollection('leads'),
        readCollection('scheduledTasks'),
        readCollection('chatLogs'),
        readCollection('quotes'),
        readCollection('usageLog'),
      ]);

      // 오늘
      const todayNewLeads = leads.filter((l) => inRange(l.createdAt, target, targetEnd)).length;
      const todayCallbacks = tasks.filter((t) => t.type === 'callback_request' && inRange(t.createdAt || t.scheduledAt, target, targetEnd));
      const todayCallbacksUrgent = todayCallbacks.filter((t) => t.urgency === 'urgent').length;
      const todayChats = logs.filter((l) => inRange(l.updatedAt, target, targetEnd)).length;
      const todayQuotes = quotes.filter((q) => inRange(q.createdAt, target, targetEnd)).length;
      const todayCost = usage.filter((u) => inRange(u.createdAt, target, targetEnd))
        .reduce((s, u) => s + (u.cost_usd || 0), 0);

      // 어제 대비
      const yLeads = leads.filter((l) => inRange(l.createdAt, yesterday, yesterdayEnd)).length;
      const yChats = logs.filter((l) => inRange(l.updatedAt, yesterday, yesterdayEnd)).length;
      const yCost = usage.filter((u) => inRange(u.createdAt, yesterday, yesterdayEnd))
        .reduce((s, u) => s + (u.cost_usd || 0), 0);

      // 처리 대기 (누적)
      const pendingCallbacks = tasks.filter((t) => t.type === 'callback_request' && t.status === 'pending').length;
      const pendingFollowups = tasks.filter((t) => t.type === 'followup_email' && t.status === 'pending').length;

      const dateStr = target.toISOString().slice(0, 10);
      const delta = (cur, prev) => prev === 0 ? (cur > 0 ? '+' + cur : '0') : `${cur > prev ? '+' : ''}${Math.round(((cur - prev) / prev) * 100)}%`;

      return {
        date: dateStr,
        today: {
          new_leads: todayNewLeads,
          callbacks_requested: todayCallbacks.length,
          callbacks_urgent: todayCallbacksUrgent,
          chats: todayChats,
          quotes_created: todayQuotes,
          ai_cost_usd: Number(todayCost.toFixed(5)),
        },
        delta_vs_yesterday: {
          leads: delta(todayNewLeads, yLeads),
          chats: delta(todayChats, yChats),
          cost: delta(todayCost, yCost),
        },
        pending: {
          callbacks: pendingCallbacks,
          followups: pendingFollowups,
        },
        hint: 'AI가 결과를 사람 친화적 한국어 요약 + 시급한 처리 사항(긴급 콜백 등) 강조해 답변',
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 챗봇 학습 사이클 — 자주 묻는 패턴 + 약한 응답 분석
  // 운영자가 "분석해줘"/"개선할 부분"/"자주 묻는 질문" 등 요청 시 호출
  // ─────────────────────────────────────────────────────────
  analyze_chat_patterns: {
    adminOnly: true,
    declaration: {
      name: 'analyze_chat_patterns',
      description: 'Analyze recent chatLogs to find frequent topics, weak AI responses, and suggest new bot rules. Use when admin asks "분석해줘" / "개선할 부분" / "자주 묻는 질문" / "패턴 찾아줘".',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'string', description: '7d|30d|90d (default 7d)' },
          min_count: { type: 'number', description: '키워드 최소 빈도 (default 2)' },
        },
      },
    },
    async handler({ since, min_count }) {
      const days = parseSince(since) || 7;
      const minCount = Math.max(1, Number(min_count) || 2);
      const logs = await readCollection('chatLogs');
      const recent = logs.filter((l) => withinDays(l.updatedAt, days));

      // 1) 사용자 메시지 + 직후 봇 답변 페어 수집
      const pairs = [];
      const userMessages = [];
      for (const log of recent) {
        const msgs = log.messages || [];
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          if (m.role !== 'user' || !m.text) continue;
          userMessages.push(m.text.trim());
          const next = msgs[i + 1];
          if (next && next.role === 'bot' && next.text) {
            pairs.push({ q: m.text.trim(), a: next.text.trim(), sessionId: log.sessionId });
          }
        }
      }

      if (userMessages.length === 0) {
        return {
          period_days: days,
          total_sessions: recent.length,
          total_questions: 0,
          message: '분석할 대화가 없습니다.',
        };
      }

      // 2) 키워드 빈도 분석 (단순 어절 기반 + 흔한 stopword 제거)
      const STOPWORDS = new Set([
        '있어', '있나', '하면', '하나', '있는', '되나', '있어요', '하나요', '인가요', '인가',
        '입니다', '있을까요', '하는', '있고', '됩니다', '있는데', '있습니다', '드릴', '주세요',
        '같은', '같이', '정도', '하고', '있는지', '대해', '뭐가', '저는', '제가',
        'the', 'and', 'for', 'are', 'is', 'be', 'to', 'of', 'a', 'an',
      ]);
      const wordCounts = new Map();
      for (const text of userMessages) {
        const words = (text.toLowerCase().match(/[가-힣a-z0-9]{2,}/g) || []);
        const uniq = new Set(words);
        for (const w of uniq) {
          if (STOPWORDS.has(w) || w.length > 12) continue;
          wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
        }
      }
      const topKeywords = [...wordCounts.entries()]
        .filter(([, c]) => c >= minCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([word, count]) => ({ word, count, pct: Math.round((count / userMessages.length) * 100) }));

      // 3) 약한 응답 케이스 — fallback 텍스트 / 너무 짧음 / 회피성
      const fallbackPatterns = /응답이 잠시 어려운|미연결|받지 못했|좀더 구체적|구체적으로 말씀해|죄송합니다.*응답을 생성|모르겠/;
      const avoidPatterns = /상담을 통해|미팅을 통해|상담에서 안내/;
      const weakSamples = [];
      for (const pair of pairs) {
        const isFallback = fallbackPatterns.test(pair.a);
        const isTooShort = pair.a.length < 25;
        const isAvoidance = avoidPatterns.test(pair.a) && pair.a.length < 100;
        if (!isFallback && !isTooShort && !isAvoidance) continue;
        weakSamples.push({
          q: truncate(pair.q, 80),
          a_excerpt: truncate(pair.a, 60),
          issue: isFallback ? 'fallback' : isTooShort ? 'too_short' : 'avoidance',
          sessionId: pair.sessionId,
        });
        if (weakSamples.length >= 6) break;
      }

      return {
        period_days: days,
        total_sessions: recent.length,
        total_questions: userMessages.length,
        top_keywords: topKeywords,
        weak_response_count: weakSamples.length,
        weak_samples: weakSamples,
        hint: 'AI가 결과를 PM에게 자연어로 요약 + 1-3개 새 행동 지침을 제안하고, PM 동의 시 update_bot_instruction을 호출하세요.',
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // 챗봇 행동 지침 (chatConfig.botRules[]) — 2개 도구
  // 운영자가 자연어로 "다음부터 ㅇㅇ해줘" 하면 botRules에 영구 저장 →
  // 다음 사용자 채팅부터 자동 적용. 어드민 페이지에서 PM이 CRUD 가능.
  // ─────────────────────────────────────────────────────────
  get_bot_instruction: {
    adminOnly: true,
    declaration: {
      name: 'get_bot_instruction',
      description: 'List all current bot behavior rules. Each rule has id, text, source(ai/pm), createdAt. Use when admin asks what the bot is currently set to do.',
      parameters: { type: 'object', properties: {} },
    },
    async handler() {
      const cfg = await readChatConfig();
      const rules = getEffectiveBotRules(cfg);
      if (!rules.length) return { rules: [], count: 0, summary: '현재 추가 행동 지침 없음' };
      return {
        count: rules.length,
        rules: rules.map((r) => ({ id: r.id, text: truncate(r.text, 200), source: r.source, createdAt: r.createdAt })),
      };
    },
  },

  update_bot_instruction: {
    adminOnly: true,
    declaration: {
      name: 'update_bot_instruction',
      description: 'Add a new bot behavior rule. Affects ALL future customer conversations. Use when admin says "from now on bot should X" / "다음부터 ㅇㅇ해줘" / "고객한테 ㅇㅇ 받으라고 해" 등. Stored in botRules with source="ai" so PM can edit/delete it later in admin UI.',
      parameters: {
        type: 'object',
        required: ['instruction'],
        properties: {
          instruction: { type: 'string', description: '새 지침 텍스트 (한국어 OK). 짧고 명확하게. 한 규칙 = 한 줄.' },
          mode: { type: 'string', description: 'append (기본, 새 규칙 추가) | replace_all (기존 모든 규칙 삭제 후 이것만 남김)' },
        },
      },
    },
    async handler({ instruction, mode }) {
      if (!instruction || !String(instruction).trim()) {
        return { error: 'instruction_required' };
      }
      const cfg = await readChatConfig();
      const existing = getEffectiveBotRules(cfg);
      const m = (mode || 'append').toLowerCase();
      const now = new Date().toISOString();
      const newRule = {
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text: String(instruction).trim().replace(/^[-•*]\s*/, ''), // bullet 마커 제거
        source: 'ai',
        createdAt: now,
        updatedAt: now,
      };
      const nextRules = m === 'replace_all' ? [newRule] : [...existing, newRule];
      await writeChatConfig({
        ...cfg,
        botRules: nextRules,
        // legacy systemPromptExtra도 함께 갱신 (마이그레이션 안 한 클라 호환)
        systemPromptExtra: nextRules.map((r) => `- ${r.text}`).join('\n'),
      });
      return {
        ok: true,
        mode: m,
        rule_id: newRule.id,
        added_text: newRule.text.slice(0, 100),
        total_rules: nextRules.length,
        note: '다음 사용자 응답부터 즉시 적용. 어드민 페이지 > 챗봇 설정 > 행동 지침에서 편집·삭제 가능.',
      };
    },
  },
};

/** chatConfig에서 유효한 botRules 추출 — 마이그레이션 자동 처리
 *  - botRules 배열 있으면 그것 사용
 *  - 없고 legacy systemPromptExtra 있으면 한 줄씩 split해서 변환 (mem only, 저장은 다음 write 때)
 */
function getEffectiveBotRules(cfg) {
  if (Array.isArray(cfg.botRules) && cfg.botRules.length > 0) return cfg.botRules;
  if (Array.isArray(cfg.botRules)) return []; // 빈 배열 의도적
  const legacy = (cfg.systemPromptExtra || '').trim();
  if (!legacy) return [];
  return legacy.split('\n')
    .map((line) => line.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean)
    .map((text, i) => ({
      id: 'legacy_' + i,
      text,
      source: 'pm',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }));
}

/* ============================================================
   외부 노출 헬퍼
   ============================================================ */

/** Gemini API의 tools 필드에 들어갈 functionDeclarations 목록을 반환 */
export function getToolDeclarations({ isAdmin }) {
  return Object.values(TOOL_CATALOG)
    .filter((t) => !t.adminOnly || isAdmin)
    .map((t) => t.declaration);
}

/** 도구 이름 → 실행 결과 (서버 측). 인증 검증 + 5분 LRU 캐시 + 핸들러 실행. */
export async function executeServerTool(name, args, { isAdmin }) {
  const tool = TOOL_CATALOG[name];
  if (!tool) return { error: 'unknown_tool', name };
  if (tool.adminOnly && !isAdmin) return { error: 'permission_denied', name };

  // 💰 캐시 조회 (read-only 도구만)
  const cacheKey = READ_ONLY_TOOLS.has(name) ? makeToolCacheKey(name, args) : null;
  if (cacheKey) {
    const cached = toolCacheGet(cacheKey);
    if (cached) {
      return { ...cached, _cached: true };
    }
  }

  try {
    const result = await tool.handler(args || {});
    if (cacheKey && !result?.error) {
      toolCacheSet(cacheKey, result);
    }
    // 🔄 mutation 후 관련 read 도구 캐시 무효화 (다음 list/find가 stale 안 받게)
    const invalidatePrefixes = TOOL_INVALIDATES[name];
    if (invalidatePrefixes && !result?.error) {
      toolCacheInvalidate(invalidatePrefixes);
    }
    return result;
  } catch (e) {
    console.error(`[tool ${name}] failed`, e);
    return { error: 'tool_execution_failed', detail: String(e?.message || e) };
  }
}

/** 짧은 도구 설명 (시스템 프롬프트에 들어가는 도움말) */
export function getToolSummary({ isAdmin }) {
  const tools = Object.entries(TOOL_CATALOG)
    .filter(([, t]) => !t.adminOnly || isAdmin)
    .map(([name, t]) => `- ${name}: ${t.declaration.description}`)
    .join('\n');
  return tools;
}
