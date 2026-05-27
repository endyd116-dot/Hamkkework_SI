/**
 * GET /api/sso/enter?t=<JWT> — 허브(IdP) 단일로그인 진입점 (SP)
 *
 * 흐름:
 *   1) 허브 토큰 검증 — 서명 · 만료(exp) · iss=siren-hub · aud=hamkkework-siax
 *      (네 가지 전부 통과해야 함. 하나라도 불일치 → 거부)
 *   2) SI 관리자 upsert — sub(=ssoUserId) 기준, name·email·role 저장 (감사/표시용)
 *   3) SI 세션 쿠키 발급 (SI 자체 키) → SI 관리자 홈으로 이동
 *   검증 실패/만료 → 허브 관리자 페이지로 되돌림
 *
 * ★ 허브 role_permissions DB 는 조회하지 않는다(결합 금지). 권한은 SI 세션 role 로만 판단.
 */
import { getStore } from '@netlify/blobs';
import {
  verifyJwtHs256, signJwtHs256, ssoSecret, sessionSecret, buildSessionCookie,
  redirect, SSO_ISS, SSO_AUD, SESSION_ISS, SESSION_TTL_SEC, HUB_FALLBACK_URL, ROLES,
} from './_lib/sso.js';

const STORE_NAME = 'hamkkework';
const ADMIN_HOME = '/admin#dashboard';

export default async (req) => {
  const token = new URL(req.url).searchParams.get('t') || '';

  const secret = ssoSecret();
  if (!secret) {
    console.error('[sso-enter] SIAX_SSO_SECRET 미설정 — 진입 거부');
    return redirect(HUB_FALLBACK_URL);
  }

  // 1) 허브 토큰 검증 (전부)
  const res = verifyJwtHs256(token, secret, { iss: SSO_ISS, aud: SSO_AUD });
  if (!res.valid) {
    console.warn('[sso-enter] 토큰 검증 실패:', res.reason);
    return redirect(HUB_FALLBACK_URL);
  }

  const { sub, name = '', email = '', role } = res.payload || {};
  if (!sub || !ROLES.includes(role)) {
    console.warn('[sso-enter] payload 불충분:', { hasSub: !!sub, role });
    return redirect(HUB_FALLBACK_URL);
  }

  // 2) SI 관리자 upsert (저장 실패가 진입을 막지 않도록 try/catch — 세션은 자체 완결적)
  try {
    const store = getStore(STORE_NAME);
    const map = (await store.get('ssoAdmins', { type: 'json' })) || {};
    const nowIso = new Date().toISOString();
    const prev = map[sub] || {};
    map[sub] = {
      sub,
      name: name || prev.name || '',
      email: email || prev.email || '',
      role, // 마지막 진입 시점의 허브 권한을 그대로 반영
      firstSeen: prev.firstSeen || nowIso,
      lastSeen: nowIso,
      enterCount: (prev.enterCount || 0) + 1,
    };
    await store.setJSON('ssoAdmins', map);
  } catch (e) {
    console.error('[sso-enter] ssoAdmins upsert 실패(무시):', String(e?.message || e));
  }

  // 3) SI 세션 토큰 발급 (SI 자체 키) → 쿠키 + 관리자 홈 302
  const sessionJwt = signJwtHs256(
    { iss: SESSION_ISS, sub, name, email, role },
    sessionSecret(),
    SESSION_TTL_SEC,
  );

  console.log('[sso-enter] 진입 성공:', JSON.stringify({ sub, role }));
  return redirect(ADMIN_HOME, { 'Set-Cookie': buildSessionCookie(sessionJwt) });
};
