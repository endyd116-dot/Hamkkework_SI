/**
 * Auto follow-up — 24시간 미응답 콜백 요청에 자동 팔로업 메일 발송
 *
 * 실행: GitHub Actions cron이 매시간 GET /api/auto-followup 호출
 * 동작:
 *  1) scheduledTasks에서 status='pending' AND type='callback_request' AND
 *     createdAt이 24h 이전인 항목 조회
 *  2) 각 항목에 대해 send_email (Resend or drafts) 호출 → emailDrafts에 기록
 *  3) task에 followedUpAt 표시 (중복 발송 방지)
 *
 * 환경: GEMINI_API_KEY 불필요. RESEND_API_KEY 있으면 자동 발송.
 */

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'hamkkework';
const FOLLOWUP_AFTER_HOURS = Number(process.env.FOLLOWUP_AFTER_HOURS || 24);
const FOLLOWUP_MAX_PER_RUN = 5; // 한 번에 발송 최대 5건

function getBlobsStore() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

async function readCollection(key) {
  const store = getBlobsStore();
  const data = await store.get(key, { type: 'json' });
  return Array.isArray(data) ? data : [];
}

async function writeCollection(key, data) {
  const store = getBlobsStore();
  await store.setJSON(key, data);
}

async function readSettings() {
  const store = getBlobsStore();
  const data = await store.get('settings', { type: 'json' });
  return data || { brand: '함께워크_SI', pm: '박두용', email: 'endy116@naver.com', phone: '010-2807-5242' };
}

function buildFollowupEmail(task, settings) {
  const name = task.leadName && task.leadName !== '(이름 미기재)' ? `${task.leadName}님` : '고객님';
  const pm = settings.pm || '박두용';
  const brand = settings.brand || '함께워크_SI';
  const phone = settings.phone || '010-2807-5242';
  const email = settings.email || 'endy116@naver.com';
  const subject = `[${brand}] 콜백 요청 확인 — ${pm} PM 안내`;
  const body = `안녕하세요 ${name},

${brand} ${pm} PM입니다.

${task.preferredTime ? `${task.preferredTime} 연락을 요청해 주셨는데,` : '저희 챗봇을 통해 PM 연락을 요청해 주셨는데,'} 아직 직접 연락드리지 못했습니다. 죄송합니다.

언제 통화가 편하신지 회신 주시면 그 시간에 맞춰 연락드리겠습니다.
긴급하시면 아래 연락처로 직접 연락 부탁드립니다.

📞 ${phone}
📧 ${email}

${task.topic ? `\n[문의 주제] ${task.topic}\n` : ''}
감사합니다.
${pm} PM | ${brand}`;
  return { subject, body };
}

async function sendViaResend({ to, subject, body }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'no_api_key' };
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
    });
    if (r.ok) {
      const json = await r.json().catch(() => ({}));
      return { sent: true, providerId: json.id || null };
    }
    return { sent: false, reason: `Resend ${r.status}`, error: (await r.text().catch(() => '')).slice(0, 200) };
  } catch (e) {
    return { sent: false, reason: 'fetch_error', error: String(e?.message || e) };
  }
}

export default async (req) => {
  // 인증 — Cron secret 또는 어드민 IP만 허용
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') || req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (expected && secret !== expected) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const tasks = await readCollection('scheduledTasks');
  const settings = await readSettings();
  const drafts = await readCollection('emailDrafts');

  const now = Date.now();
  const thresholdMs = FOLLOWUP_AFTER_HOURS * 3600 * 1000;
  const candidates = tasks.filter((t) =>
    t.type === 'callback_request'
    && t.status === 'pending'
    && !t.followedUpAt
    && t.method !== 'phone' // 전화만 가능한 경우는 메일 X (phone-only 콜백은 PM이 직접)
    && t.contact && /@/.test(t.contact)
    && t.createdAt && (now - new Date(t.createdAt).getTime() > thresholdMs)
  ).slice(0, FOLLOWUP_MAX_PER_RUN);

  const results = [];
  for (const task of candidates) {
    const { subject, body } = buildFollowupEmail(task, settings);
    const sendResult = await sendViaResend({ to: task.contact, subject, body });
    const draft = {
      id: 'mail_followup_' + task.id + '_' + Date.now().toString(36),
      to: task.contact,
      subject,
      body,
      leadName: task.leadName || null,
      leadId: task.id,
      purpose: 'followup',
      status: sendResult.sent ? 'sent' : 'draft',
      createdAt: new Date().toISOString(),
      sentAt: sendResult.sent ? new Date().toISOString() : null,
      providerId: sendResult.providerId || null,
      error: sendResult.error || null,
      createdBy: 'auto-followup-cron',
    };
    drafts.unshift(draft);

    // 24h 후 자동 follow-up 표시
    task.followedUpAt = new Date().toISOString();
    task.followupResult = sendResult.sent ? 'sent' : (sendResult.reason || 'drafted');

    results.push({ taskId: task.id, leadName: task.leadName, to: task.contact, sent: sendResult.sent });
  }

  if (results.length > 0) {
    await writeCollection('scheduledTasks', tasks);
    await writeCollection('emailDrafts', drafts);
  }

  return new Response(JSON.stringify({
    ok: true,
    checkedAt: new Date().toISOString(),
    candidates: candidates.length,
    sent: results.filter((r) => r.sent).length,
    drafted: results.filter((r) => !r.sent).length,
    threshold_hours: FOLLOWUP_AFTER_HOURS,
    results,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
