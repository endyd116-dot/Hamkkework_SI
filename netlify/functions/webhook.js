/**
 * POST /api/webhook
 *
 * Generic webhook receiver. Wire up:
 *  - PG payment notifications (NHN KCP, Toss Payments)
 *  - GitHub Actions / CI events
 *  - Slack slash commands
 *  - External form services (Tally, Formspree fallback)
 *
 * Always validate signatures in production!
 */

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Example: verify signature header
  // const sig = event.headers['x-signature'];
  // if (sig !== expectedSig) return { statusCode: 401, body: 'Unauthorized' };

  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } catch {}

  console.log('[webhook]', new Date().toISOString(), payload);

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, received: Object.keys(payload).length }),
  };
};
