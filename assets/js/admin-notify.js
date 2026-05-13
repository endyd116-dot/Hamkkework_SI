/**
 * Admin Web Push Notifications
 *
 * 어드민 페이지 열려있는 PM에게 새 콜백/리드 발생 시 브라우저 알림.
 * 외부 인프라 X — 브라우저 Notification API + store:change 이벤트.
 *
 * 다른 기기/브라우저에서 등록된 항목만 알림 (source='sync' 필터).
 */

import { store } from './store.js';

const LAST_KEY = 'hamkkework.notify.lastAt';
const LAST_LEAD_KEY = 'hamkkework.notify.lastLeadAt';

function isAdmin() {
  return !!(store.auth.get()?.email);
}

function getLast(key, fallback = Date.now()) {
  return Number(localStorage.getItem(key)) || fallback;
}
function setLast(key, ts) {
  localStorage.setItem(key, String(ts));
}

export async function requestNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const r = await Notification.requestPermission();
    return r === 'granted';
  } catch {
    return false;
  }
}

export function notifyPermissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

function notify(title, body, { tag, urgent = false } = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
      body,
      icon: '/assets/images/logo.jpg',
      badge: '/assets/images/logo.jpg',
      tag,
      requireInteraction: urgent,
    });
    n.onclick = () => {
      window.focus();
      n.close();
      // 콜백/리드 페이지로 이동
      if (tag?.includes('callback')) window.navTo?.('dashboard');
      else if (tag?.includes('lead')) window.navTo?.('leads');
    };
  } catch (e) {
    console.warn('[notify]', e?.message);
  }
}

function checkAndNotifyCallbacks() {
  if (!isAdmin()) return;
  const since = getLast(LAST_KEY);
  const tasks = store.scheduledTasks.all();
  const newOnes = tasks.filter((t) =>
    t.type === 'callback_request' &&
    t.status === 'pending' &&
    new Date(t.createdAt || t.scheduledAt || 0).getTime() > since
  );
  if (newOnes.length === 0) return;

  const urgent = newOnes.filter((t) => t.urgency === 'urgent');
  if (urgent.length > 0) {
    const first = urgent[0];
    notify(`🚨 긴급 콜백 ${urgent.length}건`, `${first.leadName || '고객'} · ${first.contact || ''} · ${first.preferredTime || ''}`, { tag: 'urgent-callback', urgent: true });
  } else {
    const first = newOnes[0];
    notify(`📞 새 콜백 요청 ${newOnes.length}건`, `${first.leadName || '고객'} · ${first.contact || ''}`, { tag: 'new-callback' });
  }
  setLast(LAST_KEY, Date.now());
}

function checkAndNotifyLeads() {
  if (!isAdmin()) return;
  const since = getLast(LAST_LEAD_KEY);
  const leads = store.leads.all();
  const newOnes = leads.filter((l) =>
    new Date(l.createdAt || 0).getTime() > since && l.status === 'new'
  );
  if (newOnes.length === 0) return;
  const first = newOnes[0];
  notify(`✨ 신규 리드 ${newOnes.length}건`, `${first.name || '신규 고객'} · ${first.company || ''} · ${first.type || ''}`, { tag: 'new-lead' });
  setLast(LAST_LEAD_KEY, Date.now());
}

// 어드민 페이지 boot 시 init
export function initAdminNotifications() {
  if (!isAdmin()) return;
  // 초기값 — 지금 시점 이후의 sync만 알림 (과거 항목 폭주 방지)
  if (!localStorage.getItem(LAST_KEY)) setLast(LAST_KEY, Date.now());
  if (!localStorage.getItem(LAST_LEAD_KEY)) setLast(LAST_LEAD_KEY, Date.now());

  window.addEventListener('store:change', (e) => {
    if (e.detail?.source !== 'sync') return; // 같은 기기 등록은 알림 X
    const key = e.detail?.key || '';
    if (key.endsWith('.scheduledTasks')) checkAndNotifyCallbacks();
    else if (key.endsWith('.leads')) checkAndNotifyLeads();
  });

  console.log('[admin-notify] initialized — permission=', notifyPermissionState());
}
