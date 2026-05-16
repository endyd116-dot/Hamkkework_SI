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
  'calendarNotes',    // 어드민 개인 메모 ({id, date, text, color})
  'kbDocs',           // PPT/PDF 업로드에서 추출한 텍스트 문서
  'qrBrief',          // 회사 브리프 (압축본, kbDocs 포함)
  'qrArchive',        // 고객요청 답변생성 자동 보관함
]);

const STORE_NAME = 'hamkkework';

// 🔐 인증 — ADMIN_API_TOKEN env가 설정된 경우에만 헤더 검증.
// 토큰 미설정 시(=레거시·로컬 개발) 거부 — 운영 배포에는 반드시 설정.
function authOk(req) {
  const required = process.env.ADMIN_API_TOKEN;
  if (!required) return false; // 토큰 미설정이면 무조건 차단 (보안 fail-closed)
  // 우선 헤더, 없으면 쿼리스트링 (sendBeacon은 헤더 첨부 불가하므로 token= 쿼리 허용)
  let provided = req.headers.get('x-admin-token') || '';
  if (!provided) {
    try {
      const url = new URL(req.url);
      provided = url.searchParams.get('token') || '';
    } catch {}
  }
  if (!provided) return false;
  if (provided.length !== required.length) return false;
  let mismatch = 0;
  for (let i = 0; i < required.length; i++) mismatch |= required.charCodeAt(i) ^ provided.charCodeAt(i);
  return mismatch === 0;
}

export default async (req) => {
  const method = req.method;
  if (method !== 'GET' && method !== 'POST') {
    return json(405, { error: 'method not allowed' });
  }

  if (!authOk(req)) {
    return json(401, {
      error: 'unauthorized',
      hint: 'X-Admin-Token 헤더를 ADMIN_API_TOKEN env 값과 동일하게 보내야 합니다. Netlify Site settings → Environment variables 에서 ADMIN_API_TOKEN 설정 필요.',
    });
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
