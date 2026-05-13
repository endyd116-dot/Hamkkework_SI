/**
 * Admin shared UI helpers — toast, drawer, escapeHtml, fmt, dates, etc.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const escapeHtml = (s) =>
  (s ?? '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const fmt = {
  won: (n) => `${Math.round(n).toLocaleString('ko-KR')} 만원`,
  num: (n) => Math.round(n).toLocaleString('ko-KR'),
  pct: (n) => `${(n * 100).toFixed(1)}%`,
  date: (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  },
  dt: (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  },
  rel: (iso) => {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return '방금 전';
    if (m < 60) return `${m}분 전`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}시간 전`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}일 전`;
    return fmt.date(iso);
  },
};

/* ============================================================
   Toast
   ============================================================ */
export function toast(msg, type = '') {
  const c = $('#toastContainer');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(-8px)';
    t.style.transition = 'all 280ms ease';
    setTimeout(() => t.remove(), 300);
  }, 3000);
}

/* ============================================================
   Drawer (single instance, used by all views)
   ============================================================ */
const drawer = $('#drawer');
const overlay = $('#drawerOverlay');
const drawerTitle = $('#drawerTitle');
const drawerBody = $('#drawerBody');
const drawerFooter = $('#drawerFooter');

export function openDrawer({ title, body, footer, onMount }) {
  if (drawerTitle) drawerTitle.textContent = title || '';
  if (drawerBody) drawerBody.innerHTML = body || '';
  if (drawerFooter) drawerFooter.innerHTML = footer || '';
  drawer?.classList.add('open');
  overlay?.classList.add('open');
  if (typeof onMount === 'function') {
    // 다음 tick에 호출 (innerHTML 적용 보장)
    setTimeout(onMount, 0);
  }
}
export function closeDrawer() {
  drawer?.classList.remove('open');
  overlay?.classList.remove('open');
}
$('#drawerClose')?.addEventListener('click', closeDrawer);
overlay?.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawer?.classList.contains('open')) closeDrawer();
});

/* ============================================================
   Confirm modal (lightweight)
   ============================================================ */
export function confirmAction(msg) {
  return new Promise((resolve) => {
    const ok = window.confirm(msg);
    resolve(ok);
  });
}

/* ============================================================
   CSV / JSON export
   ============================================================ */
export function downloadJson(data, filename = 'export.json') {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
export function downloadCsv(rows, filename = 'export.csv') {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(typeof v === 'object' ? JSON.stringify(v) : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv =
    '﻿' + // BOM for Excel
    [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ============================================================
   Empty state
   ============================================================ */
export const emptyState = (icon, msg) => `
  <div class="adm-empty">
    <div class="icon">${icon}</div>
    <div>${escapeHtml(msg)}</div>
  </div>
`;

/* ============================================================
   Markdown render (uses marked from CDN)
   ============================================================ */
export function md(text) {
  if (typeof window.marked !== 'undefined') {
    return window.marked.parse(text || '');
  }
  return escapeHtml(text || '').replace(/\n/g, '<br>');
}
