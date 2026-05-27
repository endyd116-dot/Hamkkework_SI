/**
 * GET /api/sso/logout — SI 세션 만료 처리(로그아웃)
 *
 * SI 세션 쿠키를 즉시 만료시키고 허브 관리자 페이지로 되돌린다.
 * (허브 세션 자체는 SI 가 건드리지 않는다 — 격리)
 */
import { buildClearCookie, redirect, HUB_FALLBACK_URL } from './_lib/sso.js';

export default async () =>
  redirect(HUB_FALLBACK_URL, { 'Set-Cookie': buildClearCookie() });
