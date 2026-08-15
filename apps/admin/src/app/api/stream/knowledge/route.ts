import { type NextRequest, NextResponse } from 'next/server';
import { currentOperatorAssertion } from '@/lib/operatorSession';

const API_URL = process.env.ADMIN_API_URL ?? 'http://localhost:4000';
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN ?? '';

/** GET /api/stream/knowledge — SSE proxy for the knowledge vault change stream.
 *  Forwards both factors server-side; see api/stream/route.ts for the reasoning. */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const assertion = await currentOperatorAssertion();
  if (!assertion) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }
  if (!ADMIN_TOKEN) {
    return NextResponse.json({ message: 'ADMIN_API_TOKEN not configured' }, { status: 500 });
  }

  const upstream = await fetch(`${API_URL}/admin/knowledge/stream`, {
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
