import { NextRequest, NextResponse } from 'next/server';
import { loginOperator } from '@/lib/operatorAuth';
import { ADMIN_SESSION_COOKIE_NAME, ADMIN_SESSION_MAX_AGE_SECONDS, sealSession } from '@/lib/operatorSession';

/**
 * POST /api/auth/login — operator sign-in for the standalone console.
 *
 * The whole credential exchange happens server-side:
 *   browser (email + password)
 *     → here
 *       → services/api /admin/operator/login   (x-admin-token as first factor)
 *         → operator assertion
 *     ← sealed into an httpOnly session cookie
 *   browser receives only the cookie — never the assertion, never the token.
 *
 * See lib/operatorSession.ts for why the cookie is safe to hand to the browser.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) {
    return NextResponse.json({ message: 'Email and password are required' }, { status: 400 });
  }

  const outcome = await loginOperator(email, password);
  if (!outcome.ok) {
    // Pass the upstream status through (401 for bad credentials, 502/500 for
    // infrastructure) but never any credential material — the message is
    // already the generic one the API chose.
    return NextResponse.json({ message: outcome.message }, { status: outcome.status });
  }

  let cookieValue: string;
  try {
    cookieValue = await sealSession(outcome.assertion, outcome.operator);
  } catch {
    // The only throw path is an unconfigured ADMIN_SESSION_SECRET. Fail closed:
    // a login that cannot be sealed must not appear to succeed.
    return NextResponse.json({ message: 'Session sealing is not configured on the admin server' }, { status: 500 });
  }

  const response = NextResponse.json({ ok: true, operator: outcome.operator });
  response.cookies.set(ADMIN_SESSION_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
