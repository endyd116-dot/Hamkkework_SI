/**
 * Admin app shell — auth gate, sidebar router, view loader.
 */

import { store, ensureSeed, verifyPassword } from './store.js';
import { $, $$, toast, escapeHtml } from './admin-ui.js';
import * as Views from './admin-views.js';

await ensureSeed();

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
  kpi: { render: Views.renderKpi, mount: Views.mountKpi },
  analytics: { render: Views.renderAnalytics, mount: Views.mountAnalytics },
  knowledge: { render: Views.renderKnowledge, mount: Views.mountKnowledge },
  portal: { render: Views.renderPortal, mount: Views.mountPortal },
  settings: { render: Views.renderSettings, mount: Views.mountSettings },
};

let currentView = 'dashboard';

function navTo(view) {
  if (!VIEW_FNS[view]) view = 'dashboard';
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
    chatConfig: store.chatConfig.get(),
    pricing: store.pricing.get(),
    settings: store.settings.get(),
    exportedAt: new Date().toISOString(),
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
   Boot
   ============================================================ */
if (isAuthed()) {
  showAdmin();
  const initial = (location.hash || '#dashboard').slice(1);
  navTo(initial);
} else {
  showLogin();
}
