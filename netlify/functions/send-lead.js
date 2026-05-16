/**
 * POST /api/send-lead — Netlify Functions v2 (Web standard)
 *
 * 받은 리드 폼을:
 *  1) Resend 또는 Slack로 전송 (env 키 있으면)
 *  2) 함수 로그에 항상 기록
 *  3) 응답 메시지는 채널 상태에 따라 정확하게
 *
 * Production wiring:
 *  - RESEND_API_KEY + EMAIL_TO (+ RESEND_FROM 선택) — 메일 발송
 *  - SLACK_WEBHOOK_URL — 슬랙 알림
 */

export default async (req) => {
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let payload;
  try { payload = await req.json(); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { name, email, phone, company, type, budget, message, quote } = payload || {};
  if (!name || !email) {
    return json(400, { error: 'Missing required fields: name, email' });
  }

  const lines = [
    '[함께워크_SI] 신규 상담 요청',
    '',
    `이름: ${name}`,
    `회사: ${company || '-'}`,
    `이메일: ${email}`,
    `연락처: ${phone || '-'}`,
    '',
    `필요한 일: ${type || '-'}`,
    `예상 예산: ${budget || '-'}`,
    '',
    '메시지:',
    message || '-',
    '',
    '견적 계산:',
    quote ? JSON.stringify(quote, null, 2) : '(없음)',
    '',
    `— 메인페이지 자동 발송 (${new Date().toISOString()})`,
  ].join('\n');

  const channels = { resend: 'skipped', slack: 'skipped' };
  const errors = [];

  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'onboarding@resend.dev',
          to: process.env.EMAIL_TO || 'endyd116@gmail.com',
          reply_to: email,
          subject: `[함께워크_SI] 신규 상담 - ${name}${type ? ' / ' + type : ''}`,
          text: lines,
        }),
      });
      if (r.ok) channels.resend = 'sent';
      else {
        channels.resend = `error_${r.status}`;
        errors.push(`resend ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      }
    } catch (e) {
      channels.resend = 'exception';
      errors.push('resend exception: ' + String(e?.message || e));
    }
  }

  if (process.env.SLACK_WEBHOOK_URL) {
    try {
      const r = await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: lines }),
      });
      channels.slack = r.ok ? 'sent' : `error_${r.status}`;
      if (!r.ok) errors.push(`slack ${r.status}`);
    } catch (e) {
      channels.slack = 'exception';
      errors.push('slack exception: ' + String(e?.message || e));
    }
  }

  console.log('[send-lead]', JSON.stringify({ name, email, type, channels, errors }));

  const anySent = channels.resend === 'sent' || channels.slack === 'sent';
  const anyConfigured = !!(process.env.RESEND_API_KEY || process.env.SLACK_WEBHOOK_URL);
  const message_out = anySent
    ? '상담 요청이 접수되었습니다. 24시간 이내 회신드릴게요.'
    : anyConfigured
      ? '상담 요청이 접수되었습니다 (알림 채널 일부 실패 — 서버 로그 확인 필요). 24시간 이내 회신드릴게요.'
      : '상담 요청이 접수되었습니다 (알림 채널 미설정 — 어드민 [리드 관리]에서 확인). 24시간 이내 회신드릴게요.';

  return json(200, {
    ok: true,
    message: message_out,
    channels,
    received: { name, email, type },
  });
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
