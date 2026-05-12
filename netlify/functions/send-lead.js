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

  // === Provider integration (uncomment when ready) ===
  // Option A: Resend
  // if (process.env.RESEND_API_KEY) {
  //   await fetch('https://api.resend.com/emails', {
  //     method: 'POST',
  //     headers: {
  //       Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
  //       'Content-Type': 'application/json',
  //     },
  //     body: JSON.stringify({
  //       from: 'noreply@hamkkework.com',
  //       to: process.env.EMAIL_TO || 'endyd116@gmail.com',
  //       subject: `[함께워크_SI] 신규 상담 - ${name} / ${type}`,
  //       text: lines,
  //     }),
  //   });
  // }

  // Option B: Slack webhook
  // if (process.env.SLACK_WEBHOOK_URL) {
  //   await fetch(process.env.SLACK_WEBHOOK_URL, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ text: lines }),
  //   });
  // }

  // For now: log to function output (visible in Netlify dashboard)
  console.log('[send-lead]', lines);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      message: '리드가 접수되었습니다. 24시간 이내 회신드릴게요.',
      received: { name, email, type },
    }),
  };
};
