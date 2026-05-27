/**
 * SSO(SP) + SI 세션 공통 유틸
 *
 * 허브(IdP, SIREN/tbfa.co.kr)가 발급한 단일로그인 토큰을 검증(SP)하고,
 * SI 자체 세션 토큰을 발급/검증한다.
 *
 * ⚠ 이 프로젝트는 빌드/패키지 설치 단계가 없으므로 외부 라이브러리(jsonwebtoken 등)를
 *   추가하지 않고 Node 내장 crypto 만으로 HS256 JWT 를 처리한다.
 *   (HS256 는 라이브러리 무관한 표준 와이어 포맷 — 허브가 어떤 라이브러리로 서명하든 호환)
 *
 *  - 허브 SSO 토큰   : env SIAX_SSO_SECRET 로 서명 검증 (허브와 동일 값, 절대 변경 금지)
 *  - SI 세션 토큰    : SI 자체 키로 서명 (허브 키와 분리 — 격리)
 */
import crypto from 'node:crypto';

/* ── 허브 SSO 계약 상수 (허브가 보내는 형식 — 절대 변경 금지) ───────────── */
export const SSO_ISS = 'siren-hub';
export const SSO_AUD = 'hamkkework-siax';
export const HUB_FALLBACK_URL = 'https://tbfa.co.kr/admin-hub.html';
export const ROLES = ['super_admin', 'admin', 'operator'];

/* ── SI 세션 설정 (SI 자체 정의) ─────────────────────────────────────── */
export const SESSION_COOKIE = 'siax_session';
export const SESSION_ISS = 'siax-session';
export const SESSION_TTL_SEC = 2 * 60 * 60; // 2시간
const EXP_LEEWAY_SEC = 5;                    // 시계 오차 허용

/* ── base64url ──────────────────────────────────────────────────────── */
const b64uEncode = (buf) => Buffer.from(buf).toString('base64url');
const b64uDecode = (str) => Buffer.from(str, 'base64url');

const hmac = (secret, data) =>
  crypto.createHmac('sha256', secret).update(data).digest();

function safeEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/**
 * HS256 JWT 검증.
 * @returns {{valid:true, payload:object} | {valid:false, reason:string}}
 */
export function verifyJwtHs256(token, secret, { iss, aud } = {}) {
  if (!token || typeof token !== 'string') return { valid: false, reason: 'missing-token' };
  if (!secret) return { valid: false, reason: 'no-secret' };

  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [h, p, s] = parts;

  let header;
  try { header = JSON.parse(b64uDecode(h).toString('utf8')); }
  catch { return { valid: false, reason: 'bad-header' }; }
  if (!header || header.alg !== 'HS256') return { valid: false, reason: 'bad-alg' };

  // 서명 검증 (timing-safe)
  const expected = hmac(secret, `${h}.${p}`);
  let given;
  try { given = b64uDecode(s); } catch { return { valid: false, reason: 'bad-sig-encoding' }; }
  if (!safeEqual(expected, given)) return { valid: false, reason: 'bad-signature' };

  let payload;
  try { payload = JSON.parse(b64uDecode(p).toString('utf8')); }
  catch { return { valid: false, reason: 'bad-payload' }; }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || now > payload.exp + EXP_LEEWAY_SEC) {
    return { valid: false, reason: 'expired' };
  }
  if (typeof payload.nbf === 'number' && now + EXP_LEEWAY_SEC < payload.nbf) {
    return { valid: false, reason: 'not-yet-valid' };
  }
  if (iss && payload.iss !== iss) return { valid: false, reason: 'bad-iss' };
  if (aud && payload.aud !== aud) return { valid: false, reason: 'bad-aud' };

  return { valid: true, payload };
}

/** HS256 JWT 발급. iat/exp 는 자동 부여. */
export function signJwtHs256(claims, secret, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + ttlSec, ...claims };
  const h = b64uEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64uEncode(Buffer.from(JSON.stringify(body)));
  const s = b64uEncode(hmac(secret, `${h}.${p}`));
  return `${h}.${p}.${s}`;
}

/** 허브 SSO 서명키 (허브와 동일 값). */
export const ssoSecret = () => process.env.SIAX_SSO_SECRET || '';

/**
 * SI 세션 서명키 — 허브 키와 분리.
 *  - SIAX_SESSION_SECRET 이 있으면 그 값을 사용 (완전 독립 키, 권장).
 *  - 없으면 SSO 키에서 단방향 파생 → 별도 등록 없이도 허브 키와 다른 값이 됨.
 */
export function sessionSecret() {
  if (process.env.SIAX_SESSION_SECRET) return process.env.SIAX_SESSION_SECRET;
  const base = process.env.SIAX_SSO_SECRET || '';
  if (!base) return '';
  return crypto.createHash('sha256').update('siax-session::' + base).digest('hex');
}

/**
 * SI 세션 Set-Cookie 문자열.
 *  - HttpOnly       : JS 접근 불가 (XSS 토큰 탈취 방지)
 *  - Secure         : HTTPS 전용
 *  - SameSite=Lax   : 최상위 내비게이션 허용 + CSRF 완화
 *  - Domain 미지정  : host-only → siax.tbfa.co.kr 한정 (허브·타 서브도메인과 격리)
 */
export function buildSessionCookie(token, { maxAge = SESSION_TTL_SEC } = {}) {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

/** SI 세션 즉시 만료(로그아웃)용 Set-Cookie. */
export function buildClearCookie() {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

/** 요청 Cookie 헤더에서 SI 세션 토큰 추출. */
export function readSessionToken(req) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i) === SESSION_COOKIE) return part.slice(i + 1);
  }
  return '';
}

/** 302 리다이렉트 Response (no-store). */
export function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', ...extraHeaders },
  });
}
