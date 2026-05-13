/**
 * Unified data store
 * - Backend-agnostic abstraction over localStorage
 * - All admin/main pages share this layer
 * - Swap to Supabase/Firebase by replacing the implementation below
 */

const NS = 'hamkkework';
const VERSION = 1;

/* ============================================================
   기본 개발 수준 4단계 (가중치)
   - AI 라인(LLM/RAG/Agent/파인튜닝)은 가중치 미적용
   - 페이지·모듈·외부연동 합계에만 × multiplier 적용
   - 어드민에서 편집 가능 (name, multiplier, description, includes)
   ============================================================ */
export const DEFAULT_QUALITY_TIERS = [
  {
    id: 'mvp',
    name: 'MVP 개발',
    multiplier: 0.5,
    description: '1-2개 핵심 기능만 실작동, 나머지는 목업/더미. 아이디어 검증·투자 데모용.',
    includes: [
      '핵심 플로우 1-2개만 실제 구현',
      '나머지 페이지는 UI 목업 + 더미 데이터',
      '기본 반응형 / 단일 환경 (prod만)',
      '간단 README 외 문서 없음',
      '안정화 1주 (긴급 버그만 대응)',
    ],
  },
  {
    id: 'small',
    name: '소규모 프로젝트',
    multiplier: 0.75,
    description: '전 페이지·전 기능 실작동. 스타트업 초기 서비스 / 사내 도구.',
    includes: [
      '전 페이지·전 기능 실제 작동',
      '핵심 플로우 수동 QA 통과',
      '간단한 운영 가이드 1장',
      '단위 테스트 일부 (핵심 함수만)',
      '안정화 2주',
    ],
  },
  {
    id: 'medium',
    name: '중규모 프로젝트',
    multiplier: 1.0,
    description: '표준 운영 수준. 일반 기업 / B2C 서비스 / 위시켓·크몽 평균.',
    includes: [
      '단위 + 통합 테스트',
      'API 명세 문서 (OpenAPI)',
      '운영 모니터링 기본 (에러 로그, 가동률)',
      '권한·인증 표준 적용',
      '2환경 분리 (staging / prod)',
      '안정화 4주 + 6개월 하자보증',
    ],
  },
  {
    id: 'large',
    name: '대규모 프로젝트',
    multiplier: 2.0,
    description: '중견·대기업·금융권 수준. 컴플라이언스·SLA·감사 대응 필요.',
    includes: [
      '코드리뷰 + PR 워크플로우 (2인 승인)',
      '단위·통합·E2E 테스트 (커버리지 80%+)',
      'APM 모니터링 + 알람 + 가용성 99.9% SLA',
      '이중화·HA 구성 + 무중단 배포',
      '부하 테스트 + 캐파 산정 리포트',
      '보안 감사 (OWASP Top10 + 취약점 진단)',
      '권한 시스템 + 전체 감사 로그',
      '3환경 (dev/staging/prod) + 롤백 절차',
      '안정화 8주 + 12개월 하자보증',
    ],
  },
];

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
    {
      const existingPricing = read(KEYS.pricing);
      const seedPricing = seed.pricing_rates || {};
      if (!existingPricing) {
        write(KEYS.pricing, { ...seedPricing, tiers: DEFAULT_QUALITY_TIERS, activeTier: 'medium' });
      } else if (!existingPricing.tiers) {
        // 기존 사용자 마이그레이션 — 가중치 없으면 기본 4단계 깔아줌
        write(KEYS.pricing, { ...existingPricing, tiers: DEFAULT_QUALITY_TIERS, activeTier: existingPricing.activeTier || 'medium' });
      }
    }
    if (!read(KEYS.chatConfig)) {
      write(KEYS.chatConfig, {
        greeting: '안녕하세요! 함께워크_SI AI 상담입니다. 가격·레퍼런스·AI 도입 등 무엇이든 물어보세요.',
        intents: seed.chat_intents || [],
        fallback: 'AI 응답이 잠시 어려운 상태예요. 잠시 후 다시 질문해주시거나, 페이지 하단 [상담 요청]을 남겨주시면 박두용 PM이 직접 연락드립니다.',
        systemPromptExtra: '',
      });
    } else {
      // 마이그레이션: 옛 fallback 텍스트 사용 중이면 친화 텍스트로 교체 (한 번만)
      const cfg = read(KEYS.chatConfig);
      if (cfg && /Gemini 응답을 받지 못했네요/.test(cfg.fallback || '')) {
        write(KEYS.chatConfig, {
          ...cfg,
          fallback: 'AI 응답이 잠시 어려운 상태예요. 잠시 후 다시 질문해주시거나, 페이지 하단 [상담 요청]을 남겨주시면 박두용 PM이 직접 연락드립니다.',
        });
      }
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

// Boot: 서버 pull 먼저 → 그래도 비어있으면 시드 → push 마이그레이션 → 주기 poll
// (이전 순서는 ensureSeed의 빈 시드값이 서버를 덮어쓰는 race condition 있음)
(async function boot() {
  // 1) 먼저 서버에서 pull — 서버에 데이터 있으면 로컬 갱신, 비어있으면 noop
  //    pushIfEmpty:false → 이 단계에선 절대 서버에 쓰지 않음 (덮어쓰기 방지)
  const pulledChanged = await syncPullAll({ pushIfEmpty: false });
  // 2) 시드 — 로컬에 (서버에서 받은 후에도) 데이터 없으면 기본값 시드
  await ensureSeed();
  // 3) 두 번째 sync — 시드된 데이터가 있고 서버는 여전히 비어있으면 그제서야 push
  const seedChanged = await syncPullAll({ pushIfEmpty: true });
  if (pulledChanged || seedChanged) {
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
