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
  frozenResponses: `${NS}.frozenResponses`,  // #4 Top-N 사전 응답 캐시
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
    // 🔄 Cloud sync — push to /api/sync if this is a synced collection
    const sk = syncKeyFromLocal(k);
    if (sk) schedulePush(sk, v);
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
   🔄 Cloud Sync — Netlify Blobs를 통한 브라우저/기기 간 데이터 공유
   - 어느 브라우저/기기에서든 자동으로 같은 데이터 보장
   - auth/theme은 의도적으로 동기화 X (브라우저별 세션·환경 유지)
   - 충돌 해결: last-write-wins (마지막 쓴 사람이 이김)
   ============================================================ */
const SYNCED_KEYS = [
  'cases', 'faqs', 'posts', 'leads', 'quotes', 'projects',
  'invoices', 'clients', 'automations', 'chatLogs', 'chatConfig',
  'settings', 'pricing', 'scheduledTasks', 'usageLog', 'frozenResponses',
];
const SYNC_DEBOUNCE_MS = 800;
const SYNC_POLL_MS = 30_000;
const pendingPushes = new Map();
let serverWarned = false;

function syncKeyFromLocal(localKey) {
  if (!localKey.startsWith(`${NS}.`)) return null;
  const k = localKey.slice(NS.length + 1);
  return SYNCED_KEYS.includes(k) ? k : null;
}

async function syncPull(syncKey) {
  try {
    const r = await fetch(`/api/sync?key=${syncKey}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j.data ?? null;
  } catch (e) {
    if (!serverWarned) {
      serverWarned = true;
      console.warn('[sync] 서버 미접속 — 오프라인 모드 (이 브라우저 데이터만 표시)', e?.message);
    }
    return null;
  }
}

async function syncPush(syncKey, data) {
  try {
    const r = await fetch(`/api/sync?key=${syncKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    if (!r.ok) console.warn('[sync] push', syncKey, r.status);
  } catch (e) {
    console.warn('[sync] push error', syncKey, e?.message);
  }
}

function schedulePush(syncKey, data) {
  const existing = pendingPushes.get(syncKey);
  if (existing) clearTimeout(existing);
  const tid = setTimeout(() => {
    pendingPushes.delete(syncKey);
    syncPush(syncKey, data);
  }, SYNC_DEBOUNCE_MS);
  pendingPushes.set(syncKey, tid);
}

/** 페이지 닫을 때 대기 중인 push를 즉시 flush (sendBeacon으로 신뢰성↑) */
function flushPendingPushes() {
  for (const [syncKey, tid] of pendingPushes) {
    clearTimeout(tid);
    const fullKey = KEYS[syncKey];
    if (!fullKey) continue;
    const val = read(fullKey);
    try {
      const blob = new Blob(
        [JSON.stringify({ data: val })],
        { type: 'application/json' }
      );
      navigator.sendBeacon?.(`/api/sync?key=${syncKey}`, blob);
    } catch {}
  }
  pendingPushes.clear();
}
window.addEventListener('beforeunload', flushPendingPushes);
window.addEventListener('pagehide', flushPendingPushes);

/** 모든 동기화 키를 서버에서 pull. 변경 있으면 store:change 발행. */
async function syncPullAll({ pushIfEmpty = false } = {}) {
  let anyChanged = false;
  await Promise.all(SYNCED_KEYS.map(async (syncKey) => {
    const fullKey = KEYS[syncKey];
    if (!fullKey) return;

    const remote = await syncPull(syncKey);
    if (remote != null) {
      const localRaw = localStorage.getItem(fullKey) || 'null';
      const remoteRaw = JSON.stringify(remote);
      if (localRaw !== remoteRaw) {
        // pull한 데이터를 localStorage에 반영. write() 호출하면 다시 push되므로 직접 setItem.
        localStorage.setItem(fullKey, remoteRaw);
        window.dispatchEvent(new CustomEvent('store:change', { detail: { key: fullKey, source: 'sync' } }));
        anyChanged = true;
      }
    } else if (pushIfEmpty) {
      // 서버에 데이터 없음 → 이 브라우저의 로컬 데이터를 마이그레이션 push
      const local = read(fullKey);
      if (local !== null && local !== undefined) {
        syncPush(syncKey, local);
      }
    }
  }));
  return anyChanged;
}

/** 외부에 노출 — 어드민이 명시적으로 새로고침할 때 사용 가능 */
export async function syncNow() {
  const changed = await syncPullAll();
  if (changed) window.rerenderView?.();
  return changed;
}

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
  frozenResponses: collection(KEYS.frozenResponses),  // #4

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

// Theme application — runs immediately so flicker is minimized (sync 전)
(function applyTheme() {
  const t = store.theme.get();
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();

// Boot: seed → 서버 sync → 주기 poll 시작
(async function boot() {
  await ensureSeed();
  // 첫 sync: 서버에 데이터 있으면 가져오고, 없으면 로컬 데이터를 서버에 push (마이그레이션)
  const initialChanged = await syncPullAll({ pushIfEmpty: true });
  // 초기 sync로 데이터가 바뀌었으면 화면 다시 그리기 (어드민이 마운트된 후일 경우)
  if (initialChanged) {
    setTimeout(() => window.rerenderView?.(), 500);
  }
  // 30초마다 서버 변경 사항 자동 반영 (다른 기기/브라우저에서 들어온 변경)
  setInterval(async () => {
    const changed = await syncPullAll();
    if (changed && typeof window.rerenderView === 'function') {
      window.rerenderView();
    }
  }, SYNC_POLL_MS);
})();
