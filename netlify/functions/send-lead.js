/**
 * POST /api/send-lead
 *
 * Receives a lead form submission and:
 *  1. Validates payload
 *  2. Forwards via email (SMTP/Resend/SendGrid — wire your provider here)
 *  3. Optionally forwards to Slack/Discord webhook
 *  4. Returns success
 *
 * Production wiring:
 *  - Set NETLIFY_SMTP_HOST / EMAIL_TO env vars in Netlify UI
 *  - Or set RESEND_API_KEY and use https://resend.com
 *  - Or set SLACK_WEBHOOK_URL for instant notifications
 */

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { name, email, phone, company, type, budget, message, quote } = payload;
  if (!name || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: name, email' }) };
  }

  // Compose plain-text body
  const lines = [
    `[함께워크_SI] 신규 상담 요청`,
    ``,
    `이름: ${name}`,
    `회사: ${company || '-'}`,
    `이메일: ${email}`,
    `연락처: ${phone || '-'}`,
    ``,
    `필요한 일: ${type || '-'}`,
    `예상 예산: ${budget || '-'}`,
    ``,
    `메시지:`,
    message || '-',
    ``,
    `견적 계산:`,
    quote ? JSON.stringify(quote, null, 2) : '(없음)',
    ``,
    `— 메인페이지 자동 발송 (${new Date().toISOString()})`,
  ].join('\n');

  const channels = { resend: 'skipped', slack: 'skipped' };
  const errors = [];

  // Option A: Resend
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

  // Option B: Slack webhook
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

  // 항상 로그 출력 (Netlify 대시보드에서 추적용)
  console.log('[send-lead]', JSON.stringify({ name, email, type, channels, errors }));

  // 메시지를 채널 상태에 따라 정확하게
  const anySent = channels.resend === 'sent' || channels.slack === 'sent';
  const anyConfigured = !!(process.env.RESEND_API_KEY || process.env.SLACK_WEBHOOK_URL);
  const message = anySent
    ? '상담 요청이 접수되었습니다. 24시간 이내 회신드릴게요.'
    : anyConfigured
      ? '상담 요청이 접수되었습니다 (알림 채널 일부 실패 — 서버 로그 확인 필요). 24시간 이내 회신드릴게요.'
      : '상담 요청이 접수되었습니다 (알림 채널 미설정 — 어드민 [리드 관리]에서 확인). 24시간 이내 회신드릴게요.';

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      message,
      channels,
      received: { name, email, type },
    }),
  };
};
