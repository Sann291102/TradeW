import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_SESSION_COOKIE_NAME, ADMIN_SESSION_MAX_AGE_SECONDS, issueSessionCookieValue } from '@/lib/session';

/**
 * POST /api/session — log in.
 *
 * Validates the submitted token against a real `AdminTokenGuard`-gated
 * endpoint on `services/api` (`GET /broker/dhan/admin/credentials`, chosen
 * because it is read-only and already exists — no new endpoint was added just
 * to authenticate this app) rather than comparing locally. A local-only
 * comparison would pass even if admin's `ADMIN_API_TOKEN` had silently
 * drifted from the value `services/api` actually enforces, which is exactly
 * the failure mode that makes an operator console dangerous to trust.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token) {
    return NextResponse.json({ message: 'token is required' }, { status: 400 });
  }

  const apiUrl = process.env.ADMIN_API_URL || 'http://localhost:4000';
  const verify = await fetch(`${apiUrl}/broker/dhan/admin/credentials`, {
    headers: { 'x-admin-token': token },
    cache: 'no-store',
  }).catch(() => null);

  if (!verify || !verify.ok) {
    return NextResponse.json({ message: 'Invalid admin token' }, { status: 401 });
  }

  // The token that unlocked the session is validated, but never stored — see
  // src/lib/session.ts for why. Route Handlers read the operator secret from
  // their own server env, not from anything the browser sends after login.
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_SESSION_COOKIE_NAME, await issueSessionCookieValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}

/** POST /api/session with method DELETE — sign out by clearing the cookie. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_SESSION_COOKIE_NAME, '', { path: '/', maxAge: 0 });
  return response;
}
