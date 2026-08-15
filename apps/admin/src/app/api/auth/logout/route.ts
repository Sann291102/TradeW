import { NextResponse } from 'next/server';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/operatorSession';

/**
 * POST /api/auth/logout — sign out by clearing the session cookie.
 *
 * POST rather than GET so a stray link or prefetch cannot log an operator out.
 * There is no server-side session state to tear down — the sealed cookie IS the
 * session — so clearing it is the whole operation. The upstream operator
 * assertion keeps its own 12h expiry; if hard revocation is needed, disable the
 * OperatorAccount (`npm run operator:create -- <email> --disable`), which denies
 * on the next request regardless of any live cookie.
 */
export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_SESSION_COOKIE_NAME, '', { path: '/', maxAge: 0 });
  return response;
}
