/**
 * GET /api/sso/session — SI 세션 상태 조회
 *
 * 관리자 페이지가 부팅 시 호출. httpOnly 세션 쿠키를 서버에서 검증해
 * 신원·권한을 JSON 으로 돌려준다. (쿠키 자체는 JS 가 읽지 못하므로 이 확인 엔드포인트가 필요)
 *   - 유효   → 200 { ok:true, sub, name, email, role }
 *   - 무효/없음 → 401 { ok:false }
 */
import { verifyJwtHs256, sessionSecret, readSessionToken, SESSION_ISS } from './_lib/sso.js';

export default async (req) => {
  const token = readSessionToken(req);
  const res = verifyJwtHs256(token, sessionSecret(), { iss: SESSION_ISS });
  if (!res.valid) return json(401, { ok: false });

  const { sub, name = '', email = '', role } = res.payload;
  return json(200, { ok: true, sub, name, email, role });
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
