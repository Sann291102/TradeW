import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_SESSION_COOKIE_NAME, isValidSessionValue } from '@/lib/session';

/**
 * Gate every page except /login and the session API itself.
 *
 * Runs in the Edge runtime, so it can only check the cookie's signature (pure
 * `crypto`, no Node-only APIs) — it cannot call `services/api`. That is
 * sufficient here: a forged or expired cookie fails the signature check
 * exactly the way `AdminTokenGuard` fails a wrong `x-admin-token`, and the
 * actual data calls are re-authorized per-request anyway by the Route
 * Handlers, which attach the real operator token server-side.
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
     *  - /api/session (login/logout itself)
     *  - Next internals and static assets
     */
    '/((?!login|api/session|_next/static|_next/image|favicon.ico).*)',
  ],
};
