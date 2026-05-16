/**
 * Main page orchestration:
 * - dot-nav with section observer
 * - top progress bar
 * - auto-tour mode (8s/section)
 * - dark mode toggle
 * - cases carousel (rendered from store)
 * - FAQ rendering + search
 * - lead form submission → store.leads.add()
 * - toast notifications
 */

import { store, utils, ensureSeed, fireAutomation } from './store.js';

await ensureSeed();

/* ============================================================
   Toast
   ============================================================ */
const toastContainer = document.getElementById('toastContainer');
window.showToast = function (msg, type = '') {
  if (!toastContainer) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${msg}</span>`;
  toastContainer.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(-8px)';
    t.style.transition = 'all 280ms ease';
    setTimeout(() => t.remove(), 300);
  }, 3200);
};

/* ============================================================
   Theme toggle
   ============================================================ */
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');

function applyTheme(t) {
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  if (themeIcon) {
    themeIcon.innerHTML =
      t === 'dark'
        ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
        : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>';
  }
}
applyTheme(store.theme.get());
themeToggle?.addEventListener('click', () => {
  const next = store.theme.get() === 'dark' ? 'light' : 'dark';
  store.theme.set(next);
  applyTheme(next);
});

/* ============================================================
   Top progress bar
   ============================================================ */
const progressBar = document.getElementById('progressBar');
function updateProgress() {
  const h = document.documentElement.scrollHeight - window.innerHeight;
  const pct = h > 0 ? (window.scrollY / h) * 100 : 0;
  if (progressBar) progressBar.style.width = `${pct}%`;
}
window.addEventListener('scroll', updateProgress, { passive: true });
updateProgress();

/* ============================================================
   Dot navigation + active section tracking
   ============================================================ */
const dotNav = document.getElementById('dotNav');
const sections = Array.from(document.querySelectorAll('section[data-section]'));

dotNav?.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.target;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

const sectionObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = entry.target.id;
      dotNav?.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b.dataset.target === id);
      });
    }
  },
  { threshold: 0.35 }
);
sections.forEach((s) => sectionObserver.observe(s));

/* ============================================================
   Auto-tour mode
   ============================================================ */
let autoTourTimer = null;
let autoTourPlaying = false;
const autoTourBtn = document.getElementById('autoTour');
const autoTourLabel = document.getElementById('autoTourLabel');

function startAutoTour() {
  autoTourPlaying = true;
  autoTourBtn?.classList.add('playing');
  if (autoTourLabel) autoTourLabel.textContent = 'Tour 진행중';
  const step = () => {
    const active = sections.findIndex((s) => {
      const r = s.getBoundingClientRect();
      return r.top >= -50 && r.top < window.innerHeight * 0.5;
    });
    const next = sections[Math.min(active + 1, sections.length - 1)];
    if (!next || active === sections.length - 1) {
      stopAutoTour();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    next.scrollIntoView({ behavior: 'smooth' });
  };
  autoTourTimer = setInterval(step, 8000);
  step();
}
function stopAutoTour() {
  autoTourPlaying = false;
  autoTourBtn?.classList.remove('playing');
  if (autoTourLabel) autoTourLabel.textContent = 'Auto Tour';
  if (autoTourTimer) clearInterval(autoTourTimer);
  autoTourTimer = null;
}
autoTourBtn?.addEventListener('click', () => {
  if (autoTourPlaying) stopAutoTour();
  else startAutoTour();
});
// Stop on user scroll (manual override)
let lastScrollY = window.scrollY;
window.addEventListener('wheel', () => autoTourPlaying && stopAutoTour(), { passive: true });
window.addEventListener('touchmove', () => autoTourPlaying && stopAutoTour(), { passive: true });

/* ============================================================
   Cases carousel (rendered from store)
   ============================================================ */
const casesTrack = document.getElementById('casesTrack');
const casesDots = document.getElementById('casesDots');
const casesPrev = document.getElementById('casesPrev');
const casesNext = document.getElementById('casesNext');

function renderCases() {
  const cases = store.cases.all().filter((c) => c.published !== false);
  if (!casesTrack) return;
  casesTrack.innerHTML = cases
    .map(
      (c) => `
    <article class="case-card">
      <div class="case-img">${escapeHtml(c.label || 'Case')}</div>
      <div class="case-body">
        <div class="case-client">${escapeHtml(c.client || '')}</div>
        <div class="case-title">${escapeHtml(c.title || '')}</div>
        <div class="case-desc">${escapeHtml(c.description || '')}</div>
        <div class="case-tags">${(c.tags || [])
          .map((t) => `<span class="case-tag">${escapeHtml(t)}</span>`)
          .join('')}</div>
        <div class="case-meta">
          <span class="case-amount">${escapeHtml(c.amount || '')}</span>
          <span class="case-tag-status">${escapeHtml(c.status || '')}</span>
        </div>
      </div>
    </article>
  `
    )
    .join('');

  if (casesDots) {
    const pageCount = Math.max(1, Math.ceil(cases.length / 3));
    casesDots.innerHTML = '';
    for (let i = 0; i < pageCount; i++) {
      const s = document.createElement('span');
      if (i === 0) s.classList.add('on');
      s.addEventListener('click', () => scrollCasesTo(i));
      casesDots.appendChild(s);
    }
  }
}
function scrollCasesTo(i) {
  if (!casesTrack) return;
  const w = casesTrack.clientWidth;
  casesTrack.scrollTo({ left: i * w, behavior: 'smooth' });
}
casesPrev?.addEventListener('click', () => {
  casesTrack.scrollBy({ left: -casesTrack.clientWidth, behavior: 'smooth' });
});
casesNext?.addEventListener('click', () => {
  casesTrack.scrollBy({ left: casesTrack.clientWidth, behavior: 'smooth' });
});

casesTrack?.addEventListener('scroll', () => {
  if (!casesDots) return;
  const w = casesTrack.clientWidth;
  const i = Math.round(casesTrack.scrollLeft / w);
  casesDots.querySelectorAll('span').forEach((s, idx) => {
    s.classList.toggle('on', idx === i);
  });
});

// auto-slide cases (6s)
let casesAutoTimer = setInterval(() => {
  if (!casesTrack) return;
  const total = casesTrack.scrollWidth - casesTrack.clientWidth;
  if (casesTrack.scrollLeft >= total - 4) {
    casesTrack.scrollTo({ left: 0, behavior: 'smooth' });
  } else {
    casesTrack.scrollBy({ left: casesTrack.clientWidth, behavior: 'smooth' });
  }
}, 6500);

// pause auto-slide on hover
casesTrack?.addEventListener('mouseenter', () => {
  clearInterval(casesAutoTimer);
});

/* ============================================================
   FAQ render + search
   ============================================================ */
const faqGrid = document.getElementById('faqGrid');
const faqSearch = document.getElementById('faqSearch');

function renderFaq(filter = '') {
  if (!faqGrid) return;
  const faqs = store.faqs.all();
  const f = filter.trim().toLowerCase();
  const filtered = !f
    ? faqs
    : faqs.filter(
        (x) =>
          x.q.toLowerCase().includes(f) ||
          x.a.toLowerCase().includes(f) ||
          (x.tags || []).some((t) => t.toLowerCase().includes(f))
      );
  if (filtered.length === 0) {
    faqGrid.innerHTML = `<div style="padding:32px;text-align:center;color:var(--steel)">"${escapeHtml(filter)}"에 대한 결과가 없습니다.</div>`;
    return;
  }
  faqGrid.innerHTML = filtered
    .map(
      (x) => `
    <details class="faq-item">
      <summary class="faq-q">${escapeHtml(x.q)}</summary>
      <div class="faq-a">${escapeHtml(x.a)}</div>
    </details>
  `
    )
    .join('');
}
faqSearch?.addEventListener('input', (e) => renderFaq(e.target.value));

/* ============================================================
   Lead form submission
   ============================================================ */
const leadForm = document.getElementById('leadForm');
const lfSubmit = document.getElementById('lfSubmit');

leadForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  lfSubmit.disabled = true;
  lfSubmit.textContent = '전송 중…';

  const data = Object.fromEntries(new FormData(leadForm).entries());
  let quote = null;
  try {
    quote = data.quote ? JSON.parse(data.quote) : null;
  } catch {}

  // 1. Persist locally to admin store
  const lead = store.leads.add({
    name: data.name,
    company: data.company,
    email: data.email,
    phone: data.phone,
    type: data.type,
    budget: data.budget,
    message: data.message,
    quote,
    status: 'new',
    source: 'website',
  });

  // 1-1. 🤖 자동화 — lead.new 룰 발화 → emailDrafts에 draft 생성
  try { fireAutomation('lead.new', { name: lead.name, email: lead.email, phone: lead.phone, leadId: lead.id }); } catch {}

  // 2. Try Netlify Function (production), fallback to mailto in dev
  let serverOk = false;
  try {
    const res = await fetch('/api/send-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead),
    });
    serverOk = res.ok;
  } catch {
    serverOk = false;
  }

  lfSubmit.disabled = false;
  lfSubmit.textContent = '상담 요청 보내기';

  if (serverOk) {
    window.showToast('상담 요청이 전송되었습니다. 24시간 이내 회신드릴게요.', 'success');
    leadForm.reset();
  } else {
    window.showToast('로컬에 저장되었습니다. (서버 미배포)', 'warning');
    // Open user mail client as fallback
    const subj = `[함께워크_SI 상담요청] ${data.name} / ${data.type}`;
    const body = `이름: ${data.name}\n회사: ${data.company}\n이메일: ${data.email}\n연락처: ${data.phone}\n\n필요한 일: ${data.type}\n예상 예산: ${data.budget}\n\n설명:\n${data.message}\n\n견적: ${data.quote || '(없음)'}\n\n— 함께워크_SI 메인페이지`;
    setTimeout(() => {
      window.location.href = `mailto:endyd116@gmail.com?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
    }, 800);
  }
});

/* ============================================================
   Helpers
   ============================================================ */
function escapeHtml(s) {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================
   Boot
   ============================================================ */
renderCases();
renderFaq();

// re-render when admin edits data in another tab
window.addEventListener('storage', (e) => {
  if (e.key?.includes('cases')) renderCases();
  if (e.key?.includes('faqs')) renderFaq(faqSearch?.value || '');
});
