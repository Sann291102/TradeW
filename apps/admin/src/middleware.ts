import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_SESSION_COOKIE_NAME, isValidSessionValue } from '@/lib/operatorSession';

/**
 * Gate every page except /login and the auth API itself.
 *
 * Runs in the Edge runtime, so it can only decrypt-and-validate the sealed
 * cookie (Web Crypto, no Node-only APIs) — it cannot call `services/api`. That
 * is sufficient here: a forged, tampered or expired cookie fails to decrypt and
 * the operator is redirected to /login, while the actual data calls are
 * re-authorized per-request anyway by the Route Handlers, which attach the real
 * operator token AND assertion server-side. A cookie that decrypts here is not
 * treated as sufficient authorization on its own — it only decides page access.
 */
export async function middleware(request: NextRequest) {
  const session = request.cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value;
  if (await isValidSessionValue(session)) return NextResponse.next();

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('from', request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *  - /login (the page that lets you get a session)
     *  - /api/auth (login/logout itself — must be reachable unauthenticated)
     *  - Next internals and static assets
     */
    '/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)',
  ],
};
