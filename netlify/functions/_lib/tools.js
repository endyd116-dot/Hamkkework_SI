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
