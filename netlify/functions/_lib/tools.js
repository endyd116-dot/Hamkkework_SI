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
      description: '이름·이메일·전화번호로 리드 1건을 찾는다. 운영자가 특정 고객 정보를 물어볼 때 사용.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '리드 이름 (부분 매칭 OK)' },
          email: { type: 'string', description: '이메일' },
          phone: { type: 'string', description: '전화번호' },
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
      description: '조건에 맞는 리드 목록을 가져온다. 단계·기간·소스 필터 가능.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'new|consult|quote|contract|won|lost' },
          since: { type: 'string', description: '7d, 30d, today, week, month (예: "7d" = 최근 7일)' },
          source: { type: 'string', description: 'chatbot-ai, website, etc' },
          limit: { type: 'number', description: '최대 30, 기본 10' },
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
      description: '리드의 단계(status)·예산·메모를 수정한다. 운영자만 사용.',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: '리드 ID' },
          status: { type: 'string', description: 'new|consult|quote|contract|won|lost' },
          type: { type: 'string' },
          budget: { type: 'string' },
          note: { type: 'string', description: '메모 추가 (기존 message 뒤에 누적)' },
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
      description: '리드 단계별 카운트와 기간 합계 등 통계 숫자만 빠르게 가져온다.',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'string', description: '7d, 30d, month (생략 시 전체)' },
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
      description: '예약된 작업(통화 요청·follow-up 메일)을 조회한다.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'callback_request | followup_email | (전체 생략)' },
          status: { type: 'string', description: 'pending | done | cancelled (기본 pending)' },
          urgency: { type: 'string', description: 'urgent | normal' },
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
      description: '작업 상태를 변경한다 (처리 완료, 취소 등).',
      parameters: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', description: 'done | cancelled | pending' },
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
      description: '챗봇 대화에서 키워드를 검색한다. 매칭된 세션 ID 목록을 반환.',
      parameters: {
        type: 'object',
        required: ['keyword'],
        properties: {
          keyword: { type: 'string' },
          since: { type: 'string', description: '7d, 30d (기본 30d)' },
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
      description: '특정 세션의 챗봇 대화 전체를 가져온다.',
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
      description: '키워드/태그로 레퍼런스 케이스를 검색해 가장 관련 있는 1~3건을 반환. 고객이 "○○ 사례 있어요?" 같은 질문할 때 사용.',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '검색 키워드 (제목/클라이언트/설명에서 매칭)' },
          tag: { type: 'string', description: '태그 (예: 이커머스, AI, 금융권)' },
          limit: { type: 'number', description: '최대 5, 기본 3' },
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
      description: '(운영자용) 비공개 포함 모든 케이스 목록.',
      parameters: {
        type: 'object',
        properties: {
          published: { type: 'boolean', description: 'true=공개만, false=비공개만, 생략=전체' },
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
      description: 'FAQ에서 질문 키워드로 가장 관련 있는 답변을 찾는다.',
      parameters: {
        type: 'object',
        required: ['keyword'],
        properties: {
          keyword: { type: 'string', description: '질문 키워드' },
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
      description: '견적서 목록 (AI 초안/검토 중/발송 등 상태별).',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'ai-draft | reviewed | sent | accepted | rejected' },
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
};

/* ============================================================
   외부 노출 헬퍼
   ============================================================ */

/** Gemini API의 tools 필드에 들어갈 functionDeclarations 목록을 반환 */
export function getToolDeclarations({ isAdmin }) {
  return Object.values(TOOL_CATALOG)
    .filter((t) => !t.adminOnly || isAdmin)
    .map((t) => t.declaration);
}

/** 도구 이름 → 실행 결과 (서버 측). 인증 검증 후 핸들러 실행. */
export async function executeServerTool(name, args, { isAdmin }) {
  const tool = TOOL_CATALOG[name];
  if (!tool) return { error: 'unknown_tool', name };
  if (tool.adminOnly && !isAdmin) return { error: 'permission_denied', name };
  try {
    return await tool.handler(args || {});
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
