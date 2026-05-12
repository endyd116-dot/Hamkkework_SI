/**
 * Unified data store
 * - Backend-agnostic abstraction over localStorage
 * - All admin/main pages share this layer
 * - Swap to Supabase/Firebase by replacing the implementation below
 */

const NS = 'hamkkework';
const VERSION = 1;

const KEYS = {
  meta: `${NS}.meta`,
  seed: `${NS}.seedLoaded`,
  cases: `${NS}.cases`,
  faqs: `${NS}.faqs`,
  posts: `${NS}.posts`,
  leads: `${NS}.leads`,
  quotes: `${NS}.quotes`,
  projects: `${NS}.projects`,
  invoices: `${NS}.invoices`,
  clients: `${NS}.clients`,
  automations: `${NS}.automations`,
  chatLogs: `${NS}.chatLogs`,
  chatConfig: `${NS}.chatConfig`,
  settings: `${NS}.settings`,
  pricing: `${NS}.pricing`,
  scheduledTasks: `${NS}.scheduledTasks`,
  usageLog: `${NS}.usageLog`,
  auth: `${NS}.auth`,
  theme: `${NS}.theme`,
};

const read = (k, fb = null) => {
  try {
    const raw = localStorage.getItem(k);
    return raw == null ? fb : JSON.parse(raw);
  } catch {
    return fb;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    // emit change event for live updates across components
    window.dispatchEvent(new CustomEvent('store:change', { detail: { key: k } }));
    return true;
  } catch (e) {
    console.error('[store] write failed', e);
    return false;
  }
};

const uid = (prefix = '') =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const nowIso = () => new Date().toISOString();

/* ============================================================
   Seed loader — runs once
   ============================================================ */
export async function ensureSeed() {
  const meta = read(KEYS.meta);
  if (meta && meta.v >= VERSION && read(KEYS.cases)?.length) return;

  try {
    const res = await fetch('/assets/data/seed.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('seed fetch failed');
    const seed = await res.json();

    if (!read(KEYS.cases)) write(KEYS.cases, seed.cases || []);
    if (!read(KEYS.faqs)) write(KEYS.faqs, seed.faqs || []);
    if (!read(KEYS.posts)) write(KEYS.posts, seed.blog_posts || []);
    if (!read(KEYS.pricing)) write(KEYS.pricing, seed.pricing_rates || {});
    if (!read(KEYS.chatConfig)) {
      write(KEYS.chatConfig, {
        greeting: '안녕하세요! 함께워크_SI AI 상담입니다. 가격·레퍼런스·AI 도입 등 무엇이든 물어보세요.',
        intents: seed.chat_intents || [],
        fallback: 'Gemini 응답을 받지 못했네요. 30분 무료 상담을 통해 직접 답변드릴게요. 페이지 하단의 [상담 요청]을 이용해 주세요.',
        systemPromptExtra: '',
      });
    }
    if (!read(KEYS.settings)) {
      write(KEYS.settings, {
        brand: '함께워크_SI',
        email: 'endy116@naver.com',
        phone: '010-2807-5242',
        pm: '박두용',
        dev: '장석주',
        invoice_terms: '30 / 40 / 30',
        warranty_months: 6,
      });
    }
    if (!read(KEYS.automations)) {
      write(KEYS.automations, [
        { id: uid('a'), trigger: 'lead.new', name: '신규 리드 자동 회신', enabled: true, template: '안녕하세요 {{name}}님, 함께워크_SI입니다. 24시간 이내 회신드리겠습니다.' },
        { id: uid('a'), trigger: 'quote.sent', name: '견적 발송 7일 후 리마인드', enabled: true, template: '{{name}}님, 보내드린 견적 검토 중 궁금한 점 있으신가요?' },
        { id: uid('a'), trigger: 'project.weekly', name: '주간 진행보고 자동 발송', enabled: true, template: '{{client}}님, 이번 주 진행 상황을 공유드립니다.' },
      ]);
    }

    write(KEYS.meta, { v: VERSION, seededAt: nowIso() });
  } catch (e) {
    console.warn('[store] seed load failed — using empty defaults', e);
    write(KEYS.meta, { v: VERSION, seededAt: nowIso() });
  }
}

/* ============================================================
   Generic CRUD helpers
   ============================================================ */
const collection = (key) => ({
  all: () => read(key, []),
  byId: (id) => read(key, []).find((x) => x.id === id),
  add: (item) => {
    const list = read(key, []);
    const next = { id: item.id || uid(), createdAt: nowIso(), ...item };
    write(key, [next, ...list]);
    return next;
  },
  update: (id, patch) => {
    const list = read(key, []);
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    list[idx] = { ...list[idx], ...patch, updatedAt: nowIso() };
    write(key, list);
    return list[idx];
  },
  remove: (id) => {
    const list = read(key, []);
    write(key, list.filter((x) => x.id !== id));
  },
  setAll: (list) => write(key, list),
});

/* ============================================================
   Public API
   ============================================================ */
export const store = {
  cases: collection(KEYS.cases),
  faqs: collection(KEYS.faqs),
  posts: collection(KEYS.posts),
  leads: collection(KEYS.leads),
  quotes: collection(KEYS.quotes),
  projects: collection(KEYS.projects),
  invoices: collection(KEYS.invoices),
  clients: collection(KEYS.clients),
  automations: collection(KEYS.automations),
  chatLogs: collection(KEYS.chatLogs),
  scheduledTasks: collection(KEYS.scheduledTasks),
  usageLog: collection(KEYS.usageLog),

  pricing: {
    get: () => read(KEYS.pricing, {}),
    set: (v) => write(KEYS.pricing, v),
  },
  chatConfig: {
    get: () => read(KEYS.chatConfig, {}),
    set: (v) => write(KEYS.chatConfig, v),
  },
  settings: {
    get: () => read(KEYS.settings, {}),
    set: (v) => write(KEYS.settings, v),
  },
  auth: {
    get: () => read(KEYS.auth, null),
    set: (v) => write(KEYS.auth, v),
    clear: () => localStorage.removeItem(KEYS.auth),
  },
  theme: {
    get: () => read(KEYS.theme, 'light'),
    set: (v) => write(KEYS.theme, v),
  },
};

export const utils = { uid, nowIso };

// Boot on import
ensureSeed();

// Theme application — runs immediately so flicker is minimized
(function applyTheme() {
  const t = store.theme.get();
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();
