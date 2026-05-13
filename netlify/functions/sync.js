/**
 * GET  /api/sync?key=<collection>     → return data from Netlify Blobs (or null)
 * POST /api/sync?key=<collection>     → replace data (body: { data: ... })
 *
 * 브라우저/기기 간 데이터 동기화용 영구 저장소.
 * 무료 (Netlify Blobs 100GB 한도). 별도 가입/설정 없음.
 *
 * Collection 화이트리스트 — auth/theme/meta는 의도적으로 제외 (브라우저별 로컬 유지)
 */

import { getStore } from '@netlify/blobs';

const ALLOWED_KEYS = new Set([
  'cases', 'faqs', 'posts', 'leads', 'quotes', 'projects',
  'invoices', 'clients', 'automations', 'chatLogs', 'chatConfig',
  'settings', 'pricing', 'scheduledTasks', 'usageLog', 'frozenResponses',
  'adminCredentials', // 어드민 계정 (이메일, 이름, 휴대폰, role, passwordHash, salt)
  'emailDrafts',      // AI/PM 작성 이메일 (draft/sent/failed)
]);

const STORE_NAME = 'hamkkework';

export default async (req) => {
  const method = req.method;
  if (method !== 'GET' && method !== 'POST') {
    return json(405, { error: 'method not allowed' });
  }

  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key) return json(400, { error: 'key parameter required' });
  if (!ALLOWED_KEYS.has(key)) return json(400, { error: 'invalid key', key });

  let store;
  try {
    store = getStore({ name: STORE_NAME, consistency: 'strong' });
  } catch (e) {
    return json(500, { error: 'Blobs unavailable', detail: String(e?.message || e) });
  }

  try {
    if (method === 'GET') {
      const data = await store.get(key, { type: 'json' });
      return json(200, { key, data: data ?? null });
    }

    // POST
    let body;
    try { body = await req.json(); }
    catch { return json(400, { error: 'invalid JSON body' }); }

    if (body.data === undefined) {
      return json(400, { error: 'body.data required (use null to clear)' });
    }
    await store.setJSON(key, body.data);
    return json(200, { key, ok: true });
  } catch (e) {
    console.error('[sync]', key, method, e);
    return json(500, { error: String(e?.message || e) });
  }
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
