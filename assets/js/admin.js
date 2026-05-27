/**
 * Admin app shell — auth gate, sidebar router, view loader.
 */

import { store, ensureSeed, verifyPassword } from './store.js';
import { $, $$, toast, escapeHtml } from './admin-ui.js';
import * as Views from './admin-views.js';
import { initAdminNotifications, requestNotifyPermission, notifyPermissionState } from './admin-notify.js';

await ensureSeed();

/* ============================================================
   허브 SSO(SP) — 세션 게이트 + 3단 권한 (SI 자체 정의)
   - 진입은 허브 카드 → /api/sso/enter 가 SI 세션 쿠키(httpOnly)를 발급.
   - 이 페이지는 부팅 시 /api/sso/session 으로 세션을 확인한다.
   - 권한은 SI 세션 role 로만 분기한다 (허브 권한 DB 미조회 — 결합 금지).
   ============================================================ */
const HUB_ADMIN_URL = 'https://tbfa.co.kr/admin-hub.html';

// 등급 서열 — 상위 등급은 하위 권한을 포함
const ROLE_RANK = { operator: 1, admin: 2, super_admin: 3 };

// 메뉴별 최소 접근 등급 (SI 기능→등급 매핑)
//   operator   = 조회·접수처리  → 대시보드·리드(접수처리)·캘린더·KPI·AI분석
//   admin      = 일반관리       → + 견적·프로젝트·결제·케이스·블로그·FAQ·챗봇·지식·자동화·답변생성·포털
//   super_admin= 삭제·설정       → + 설정 + 전체 백업
const VIEW_MIN_ROLE = {
  dashboard: 'operator', leads: 'operator', calendar: 'operator',
  kpi: 'operator', analytics: 'operator',
  quotes: 'admin', projects: 'admin', invoices: 'admin',
  cases: 'admin', blog: 'admin', faqs: 'admin',
  chatbot: 'admin', knowledge: 'admin', automation: 'admin',
  quoteResponder: 'admin', portal: 'admin',
  settings: 'super_admin',
};

const roleRank = (r) => ROLE_RANK[r] || 0;
const isSsoRole = (r) => !!ROLE_RANK[r];
const canView = (view, role) => roleRank(role) >= roleRank(VIEW_MIN_ROLE[view] || 'admin');

// 뷰/액션 단위 권한 확인용 — admin-views 등에서 window.siCan('super_admin') 형태로 사용
window.siRole = () => store.auth.get()?.role || '';
window.siCan = (minRole) => {
  const r = window.siRole();
  return isSsoRole(r) ? roleRank(r) >= roleRank(minRole) : true; // 비-SSO(로컬) 세션은 전체 허용
};

function isLocalhost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local');
}

async function fetchSsoSession() {
  try {
    const r = await fetch('/api/sso/session', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.ok ? d : null;
  } catch {
    return null; // 네트워크 오류는 세션 없음으로 취급
  }
}

// 권한 등급에 따라 사이드바·백업 버튼 노출 조정 (디자인 유지 — 항목만 비표시)
function applyRoleGating(role) {
  document.body.setAttribute('data-role', role);
  $$('.sidebar-link[data-view]').forEach((a) => {
    a.style.display = canView(a.dataset.view, role) ? '' : 'none';
  });
  const exp = $('#exportBtn'); // 전체 데이터 백업 = 최고관리자만
  if (exp) exp.style.display = roleRank(role) >= roleRank('super_admin') ? '' : 'none';
}

/* ============================================================
   Auth — adminCredentials store에서 계정 읽어 SHA-256 hash 검증
   - 시드 직후엔 DEMO_ACCOUNT (endyd116@gmail.com / hamkke2026)
   - 어드민 페이지에서 비밀번호·이름·이메일 변경 가능
   ============================================================ */
function isAuthed() {
  const a = store.auth.get();
  return !!a?.email;
}

function showLogin() {
  $('#loginShell').style.display = 'grid';
  $('#adminShell').style.display = 'none';
}
function showAdmin() {
  $('#loginShell').style.display = 'none';
  $('#adminShell').style.display = 'grid';
  const a = store.auth.get();
  if (a) {
    $('#userEmail').textContent = a.email;
    $('#userName').textContent = a.name || '관리자';
    $('#userAvatar').textContent = (a.name || a.email).charAt(0).toUpperCase();
  }
  // 🔔 브라우저 알림 초기화 (어드민 로그인 시)
  initAdminNotifications();
  maybeOfferNotifyPermission();
}

// 첫 로그인 후 알림 권한 안 받았으면 토스트 + 버튼으로 권한 요청
function maybeOfferNotifyPermission() {
  const state = notifyPermissionState();
  if (state !== 'default') return; // 이미 허용/거부
  if (sessionStorage.getItem('notifyOffered')) return; // 세션당 1회만
  sessionStorage.setItem('notifyOffered', '1');
  setTimeout(() => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;bottom:80px;right:24px;background:#fff;border:1.5px solid var(--cobalt,#0866ff);border-radius:12px;padding:14px 16px;box-shadow:0 12px 32px rgba(0,0,0,.15);z-index:9999;max-width:300px;font-size:13px;line-height:1.5';
    wrap.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">🔔 알림 켜기</div>
      <div style="color:#555;margin-bottom:10px">새 콜백·긴급 요청 발생 시 브라우저 알림으로 받으시겠어요?</div>
      <div style="display:flex;gap:8px">
        <button id="notifyYes" style="flex:1;background:var(--cobalt,#0866ff);color:#fff;border:none;padding:8px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px">허용</button>
        <button id="notifyNo" style="flex:1;background:#f3f4f6;color:#555;border:none;padding:8px;border-radius:6px;cursor:pointer;font-size:13px">나중에</button>
      </div>
    `;
    document.body.appendChild(wrap);
    wrap.querySelector('#notifyYes').addEventListener('click', async () => {
      const ok = await requestNotifyPermission();
      wrap.remove();
      toast(ok ? '🔔 알림이 켜졌습니다' : '알림 권한이 거부되었습니다', ok ? 'success' : 'error');
    });
    wrap.querySelector('#notifyNo').addEventListener('click', () => wrap.remove());
  }, 2500);
}

$('#loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#loginEmail').value.trim();
  const pwd = $('#loginPwd').value;

  const cred = store.adminCredentials.get();
  if (!cred || !cred.passwordHash || !cred.salt) {
    toast('어드민 계정이 초기화되지 않았습니다. 페이지를 새로고침해 주세요.', 'error');
    return;
  }
  if (email.toLowerCase() !== (cred.email || '').toLowerCase()) {
    toast('이메일 또는 비밀번호가 일치하지 않습니다', 'error');
    return;
  }
  const valid = await verifyPassword(pwd, cred.passwordHash, cred.salt);
  if (!valid) {
    toast('이메일 또는 비밀번호가 일치하지 않습니다', 'error');
    return;
  }
  store.auth.set({
    email: cred.email,
    name: cred.name || '관리자',
    role: cred.role || '',
    at: new Date().toISOString(),
  });
  showAdmin();
  navTo('dashboard');
  toast(`환영합니다, ${cred.name || '관리자'}님.`, 'success');
});

$('#logoutBtn')?.addEventListener('click', () => {
  const a = store.auth.get();
  if (a?.via === 'sso') {
    if (!window.confirm('로그아웃 하시겠습니까? 허브로 이동합니다.')) return;
    store.auth.clear();
    window.location.href = '/api/sso/logout'; // 세션 쿠키 만료 + 허브로 302
    return;
  }
  if (!window.confirm('로그아웃 하시겠습니까?')) return;
  store.auth.clear();
  showLogin();
});

/* ============================================================
   Router
   ============================================================ */
const VIEW_FNS = {
  dashboard: { render: Views.renderDashboard, mount: Views.mountDashboard },
  leads: { render: Views.renderLeads, mount: Views.mountLeads },
  quotes: { render: Views.renderQuotes, mount: Views.mountQuotes },
  projects: { render: Views.renderProjects, mount: Views.mountProjects },
  invoices: { render: Views.renderInvoices, mount: Views.mountInvoices },
  cases: { render: Views.renderCases, mount: Views.mountCases },
  blog: { render: Views.renderBlog, mount: Views.mountBlog },
  faqs: { render: Views.renderFaqs, mount: Views.mountFaqs },
  chatbot: { render: Views.renderChatbot, mount: Views.mountChatbot },
  automation: { render: Views.renderAutomation, mount: Views.mountAutomation },
  quoteResponder: { render: Views.renderQuoteResponder, mount: Views.mountQuoteResponder },
  kpi: { render: Views.renderKpi, mount: Views.mountKpi },
  analytics: { render: Views.renderAnalytics, mount: Views.mountAnalytics },
  knowledge: { render: Views.renderKnowledge, mount: Views.mountKnowledge },
  portal: { render: Views.renderPortal, mount: Views.mountPortal },
  calendar: { render: Views.renderCalendar, mount: Views.mountCalendar },
  settings: { render: Views.renderSettings, mount: Views.mountSettings },
};

let currentView = 'dashboard';

function navTo(view) {
  if (!VIEW_FNS[view]) view = 'dashboard';

  // 3단 권한 게이트 — SSO 세션일 때만 적용(로컬/데모 세션은 전체 접근)
  const role = store.auth.get()?.role;
  if (isSsoRole(role) && !canView(view, role)) {
    toast('이 메뉴에 접근할 권한이 없습니다.', 'error');
    view = 'dashboard';
  }

  currentView = view;

  // update sidebar
  $$('.sidebar-link').forEach((a) => a.classList.remove('active'));
  const link = document.querySelector(`.sidebar-link[data-view="${view}"]`);
  link?.classList.add('active');

  // close mobile sidebar
  $('#sidebar')?.classList.remove('open');

  // topbar
  const meta = Views.VIEWS[view] || { title: view, sub: '' };
  $('#viewTitle').textContent = meta.title;
  $('#viewSub').textContent = meta.sub;

  // render
  const v = VIEW_FNS[view];
  $('#viewRoot').innerHTML = v.render();
  v.mount?.();

  // update URL hash
  if (location.hash !== `#${view}`) {
    history.replaceState(null, '', `#${view}`);
  }

  // refresh sidebar badge count
  const ln = store.leads.all().filter(l => l.status === 'new').length;
  const lc = $('#leadCount');
  if (lc) {
    if (ln > 0) {
      lc.style.display = 'inline-block';
      lc.textContent = ln;
    } else {
      lc.style.display = 'none';
    }
  }
}

// expose for views
window.navTo = navTo;
window.rerenderView = () => navTo(currentView);

// sidebar clicks
$$('.sidebar-link[data-view]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    navTo(a.dataset.view);
  });
});

// menu toggle (mobile)
$('#menuToggle')?.addEventListener('click', () => {
  $('#sidebar')?.classList.toggle('open');
});

// hash-based deep linking
window.addEventListener('hashchange', () => {
  const v = (location.hash || '#dashboard').slice(1);
  navTo(v);
});

// export all data
$('#exportBtn')?.addEventListener('click', () => {
  // delegate to settings export logic by triggering same flow
  const dump = {
    cases: store.cases.all(),
    faqs: store.faqs.all(),
    posts: store.posts.all(),
    leads: store.leads.all(),
    quotes: store.quotes.all(),
    projects: store.projects.all(),
    invoices: store.invoices.all(),
    clients: store.clients.all(),
    automations: store.automations.all(),
    chatLogs: store.chatLogs.all(),
    chatConfig: store.chatConfig.get(),
    pricing: store.pricing.get(),
    settings: store.settings.get(),
    // 누락 보강 — 시드 외 사용자 데이터까지 모두 백업
    scheduledTasks: store.scheduledTasks.all(),
    usageLog: store.usageLog.all(),
    frozenResponses: store.frozenResponses.all(),
    emailDrafts: store.emailDrafts.all(),
    calendarNotes: store.calendarNotes?.all?.() ?? [],
    kbDocs: store.kbDocs.all(),
    qrBrief: store.qrBrief.get(),
    qrArchive: store.qrArchive.all(),
    exportedAt: new Date().toISOString(),
    schemaVersion: 3,
  };
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hamkkework-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('백업 파일이 다운로드되었습니다', 'success');
});

/* ============================================================
   Boot — 허브 SSO 세션 게이트
     1) /api/sso/session 으로 SI 세션 확인 → 유효하면 권한 적용 후 진입
     2) 세션 없음 + 로컬 개발 → 기존 비밀번호 로그인 유지(개발/테스트용)
     3) 세션 없음 + 운영 → 허브 관리자 페이지로 되돌림
   ============================================================ */
(async function boot() {
  // 허브 토큰(t)이 진입 리다이렉트로 주소창에 남았으면 즉시 제거 (히스토리·로그 노출 방지)
  // — 세션 쿠키는 이미 발급된 상태이므로 토큰은 더 이상 필요 없음
  if (new URLSearchParams(location.search).has('t')) {
    history.replaceState(null, '', location.pathname + location.hash);
  }

  const sess = await fetchSsoSession();

  if (sess) {
    store.auth.set({
      email: sess.email,
      name: sess.name || '관리자',
      role: sess.role,
      sub: sess.sub,
      via: 'sso',
      at: new Date().toISOString(),
    });
    applyRoleGating(sess.role);
    showAdmin();
    let initial = (location.hash || '#dashboard').slice(1);
    if (!canView(initial, sess.role)) initial = 'dashboard';
    navTo(initial);
    return;
  }

  if (isLocalhost()) {
    // 로컬 개발: 허브가 없으므로 기존 데모 로그인 폼 유지
    if (isAuthed()) {
      showAdmin();
      navTo((location.hash || '#dashboard').slice(1));
    } else {
      showLogin();
    }
    return;
  }

  // 운영: SI 세션 없으면 진입 차단 → 허브로 되돌림
  window.location.replace(HUB_ADMIN_URL);
})();
