/**
 * POST /api/webhook — Netlify Functions v2 (Web standard)
 *
 * Generic webhook receiver. Wire up:
 *  - PG payment notifications (NHN KCP, Toss Payments)
 *  - GitHub Actions / CI events
 *  - Slack slash commands
 *  - External form services (Tally, Formspree fallback)
 *
 * Always validate signatures in production!
 */

export default async (req) => {
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  // Example: verify signature header
  // const sig = req.headers.get('x-signature');
  // if (sig !== expectedSig) return json(401, { error: 'Unauthorized' });

  let payload = {};
  try { payload = await req.json(); } catch {}

  console.log('[webhook]', new Date().toISOString(), payload);

  return json(200, { ok: true, received: Object.keys(payload).length });
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
