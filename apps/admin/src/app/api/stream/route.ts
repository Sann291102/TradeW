import { type NextRequest, NextResponse } from 'next/server';
import { currentOperatorAssertion } from '@/lib/operatorSession';

const API_URL = process.env.ADMIN_API_URL ?? 'http://localhost:4000';
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN ?? '';

/**
 * GET /api/stream  — SSE proxy for the agent activity stream.
 *
 * EventSource sends cookies automatically for same-origin requests, so the
 * sealed session cookie arrives here without any credentials in the URL. The
 * Route Handler decrypts it, then opens a server-side connection to services/api
 * carrying BOTH factors as headers — the operator token and the operator
 * assertion. Because this leg is a server-side fetch (not the browser's
 * EventSource), headers are available, so the assertion travels as a header and
 * never touches the URL. Neither credential is ever sent to the browser.
 *
 * `request.signal` is forwarded as the upstream AbortSignal so services/api
 * closes its listener when the browser tab disconnects.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const assertion = await currentOperatorAssertion();
  if (!assertion) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }
  if (!ADMIN_TOKEN) {
    return NextResponse.json({ message: 'ADMIN_API_TOKEN not configured' }, { status: 500 });
  }

  const upstream = await fetch(`${API_URL}/admin/stream`, {
    headers: { 'x-admin-token': ADMIN_TOKEN, 'x-operator-assertion': assertion },
    signal: request.signal,
    cache: 'no-store',
  }).catch((err) => {
    throw new Error(`services/api unreachable: ${err instanceof Error ? err.message : String(err)}`);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
