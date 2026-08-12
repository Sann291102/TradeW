import { type NextRequest, NextResponse } from 'next/server';
import { currentOperatorAssertion } from '@/lib/operatorSession';
import { isAllowedAdminRoute } from '@/lib/adminProxyRoutes';

/**
 * Deny-by-default proxy — forwards an ALLOWLISTED set of GET/POST routes to
 * services/api/admin/*. Anything not in `adminProxyRoutes.ts` is refused here,
 * before any credential is attached (see that file for why a wildcard was the
 * wrong default).
 *
 * Why a proxy instead of calling services/api directly from client components:
 *
 *  1. The operator token lives in process.env (server-side only) and must
 *     never be sent to the browser. Client components cannot read it.
 *  2. The session cookie proves the browser authenticated; these Route
 *     Handlers are the server-side leg that actually holds the credentials.
 *
 * TWO credentials are attached here, both server-side, and neither is ever
 * visible to the browser:
 *   · x-admin-token         — ADMIN_API_TOKEN from env; proves this PROCESS is
 *                             the admin deployment (the first factor).
 *   · x-operator-assertion  — the operator assertion, decrypted from the sealed
 *                             session cookie; proves WHICH PERSON is driving it
 *                             (the second factor).
 * services/api's `AdminAccessGuard` requires both. Presenting the assertion is
 * also what selects the operator path over the product-admin (JWT) path, which
 * this app has no session for. See admin-access.guard.ts and operatorSession.ts.
 *
 * URL mapping:  /api/proxy/overview  →  services/api/admin/overview
 *               /api/proxy/ai/calls  →  services/api/admin/ai/calls
 */

const API_URL = process.env.ADMIN_API_URL ?? 'http://localhost:4000';
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN ?? '';

async function proxy(request: NextRequest, path: string[]): Promise<NextResponse> {
  // One read does both jobs: a null assertion means the sealed session is
  // absent, tampered or expired — i.e. not authenticated — and a non-null one
  // is the second factor to forward. No separate hasValidSession() round-trip.
  // Auth is checked BEFORE the allowlist so an unauthenticated prober learns
  // nothing about which routes exist.
  const assertion = await currentOperatorAssertion();
  if (!assertion) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  // Deny by default. A path the console does not have an explicit rule for is
  // never forwarded — even to an authenticated operator, and even though the
  // operator token would satisfy the upstream. New admin endpoints stay
  // unreachable through this console until added to the allowlist.
  if (!isAllowedAdminRoute(request.method, path)) {
    console.warn(`[admin-proxy] denied ${request.method} /admin/${path.join('/')} — not in allowlist`);
    return NextResponse.json({ message: 'Not a proxied admin route' }, { status: 404 });
  }

  if (!ADMIN_TOKEN) {
    return NextResponse.json({ message: 'ADMIN_API_TOKEN not configured' }, { status: 500 });
  }

  const upstream = `${API_URL}/admin/${path.join('/')}${request.nextUrl.search}`;

  const body = request.method !== 'GET' && request.method !== 'HEAD'
    ? await request.text()
    : undefined;

  const res = await fetch(upstream, {
    method: request.method,
    headers: {
      'content-type': 'application/json',
      'x-admin-token': ADMIN_TOKEN,
      'x-operator-assertion': assertion,
    },
    body,
    cache: 'no-store',
  }).catch((err) => {
    throw new Error(`services/api unreachable: ${err instanceof Error ? err.message : String(err)}`);
  });

  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

// Only GET and POST are exported: the admin surface has no DELETE/PATCH routes,
// so handlers for those methods would be dead weight that the allowlist would
// reject anyway. A method the console does not use is simply not implemented.
export async function GET(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(request, params.path);
}
export async function POST(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(request, params.path);
}
