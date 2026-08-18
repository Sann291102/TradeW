import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression pin for the ONE defect the paper-order visibility audit found on
 * the console's read path.
 *
 * `services/api` answers every admin read with `Cache-Control: no-store`. The
 * proxy Route Handler rebuilds the response instead of streaming it, and for a
 * while it copied only `content-type` — so what actually reached the browser
 * carried no cache directive and no validator at all. That was measured against
 * the running console, not inferred: `GET /api/proxy/orders` came back with
 * `cache-control: (NONE)` while the upstream `GET /admin/orders` it wrapped came
 * back `no-store`.
 *
 * Why it is worth a test rather than a comment: every page in this console is a
 * `usePolling` loop over these exact URLs (Orders re-reads `/orders` every 8s),
 * and the failure mode of a polled JSON URL served without a directive is not an
 * error anyone would see — it is a console that keeps painting the same rows
 * while the metric cards above them climb. Silent, and indistinguishable from
 * "the backend is not writing orders", which is the far more alarming thing it
 * would be mistaken for.
 *
 * The assertion is on the RESPONSE the browser gets, deliberately. Testing that
 * the handler forwards the upstream header would pass even if upstream stopped
 * sending one; the guarantee this console needs is unconditional.
 */

const ASSERTION = 'operator-assertion-under-test';

vi.mock('@/lib/operatorSession', () => ({
  currentOperatorAssertion: vi.fn(async () => ASSERTION),
}));

async function callProxy(
  path: string,
  upstreamHeaders: Record<string, string>,
): Promise<Response> {
  const { GET } = await import('@/app/api/proxy/[...path]/route');
  const { NextRequest } = await import('next/server');

  const request = new NextRequest(`http://admin.local/api/proxy/${path}?hours=24&limit=200`);
  return GET(request, { params: { path: path.split('/') } });
}

describe('admin proxy — cache directives reaching the browser', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.ADMIN_API_TOKEN = 'a-token-long-enough-to-be-accepted-here';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends no-store even though the handler rebuilds the response', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ id: 'order-1' }]), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      }),
    ) as unknown as typeof fetch;

    const res = await callProxy('orders', {});

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('still sends no-store when upstream omits the directive entirely', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ id: 'order-1' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const res = await callProxy('orders', {});

    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('does not leave the polled stats endpoint cacheable either', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ byStatus: [], bySide: [], trades: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const res = await callProxy('orders/stats', {});

    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
