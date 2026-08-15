import { describe, expect, it } from 'vitest';
import { isAllowedAdminRoute } from './adminProxyRoutes';

/**
 * The proxy allowlist is the console's outer boundary: it decides which
 * `services/api/admin/*` routes the operator token is ever attached to. These
 * tests pin two things — every route the client actually calls is permitted
 * (so hardening did not silently break a page), and everything else is refused
 * (so the wildcard default is really gone).
 */

/** Turn a client path like '/cognition/episodes/abc?x=1' into the segment array
 *  the Route Handler receives (Next splits on '/', query is separate). */
function seg(path: string): string[] {
  return path.replace(/^\//, '').split('?')[0].split('/');
}

describe('isAllowedAdminRoute — the real client surface is allowed', () => {
  const GET = [
    '/overview', '/health',
    '/api-calls', '/api-calls/timeseries', '/api-calls/routes', '/api-calls/pulse',
    '/ai/calls', '/ai/by-agent', '/ai/by-model', '/ai/timeseries',
    '/agents/states', '/agents/runs', '/agents/runs/run_123',
    '/orders', '/orders/stats', '/trades', '/users', '/audit',
    '/cognition/overview', '/cognition/perceptors', '/cognition/domains', '/cognition/episodes',
    '/cognition/episodes/ep_42', '/cognition/percepts', '/cognition/synapses',
    '/cognition/proposals',
    '/knowledge/tree', '/knowledge/file', '/knowledge/recent',
    '/knowledge/search', '/knowledge/graph', '/knowledge/activity',
  ];
  const POST = [
    '/users/set-admin',
    '/cognition/perceptors/error-rate/enabled',
    '/cognition/proposals/pr_9/resolve',
    '/cognition/run',
  ];

  for (const p of GET) it(`allows GET ${p}`, () => expect(isAllowedAdminRoute('GET', seg(p))).toBe(true));
  for (const p of POST) it(`allows POST ${p}`, () => expect(isAllowedAdminRoute('POST', seg(p))).toBe(true));
});

describe('isAllowedAdminRoute — everything else is denied', () => {
  it('denies an unknown route', () => {
    expect(isAllowedAdminRoute('GET', seg('/secrets'))).toBe(false);
    expect(isAllowedAdminRoute('GET', seg('/users/export-everything'))).toBe(false);
  });

  it('denies the right path under the wrong method', () => {
    // overview is GET-only; users/set-admin is POST-only.
    expect(isAllowedAdminRoute('POST', seg('/overview'))).toBe(false);
    expect(isAllowedAdminRoute('GET', seg('/users/set-admin'))).toBe(false);
  });

  it('denies methods the surface does not use at all', () => {
    expect(isAllowedAdminRoute('DELETE', seg('/users'))).toBe(false);
    expect(isAllowedAdminRoute('PATCH', seg('/cognition/run'))).toBe(false);
  });

  it('does not let a wildcard segment swallow extra path depth', () => {
    // agents/runs/* matches exactly one id segment, not a deeper path.
    expect(isAllowedAdminRoute('GET', seg('/agents/runs/a/b'))).toBe(false);
    expect(isAllowedAdminRoute('GET', seg('/cognition/episodes/a/b'))).toBe(false);
  });

  it('rejects traversal tokens and empty segments', () => {
    expect(isAllowedAdminRoute('GET', ['cognition', '..', 'users'])).toBe(false);
    expect(isAllowedAdminRoute('GET', ['knowledge', '', 'tree'])).toBe(false);
    expect(isAllowedAdminRoute('GET', ['.'])).toBe(false);
  });

  it('denies an empty path', () => {
    expect(isAllowedAdminRoute('GET', [])).toBe(false);
  });

  it('denies the SSE stream routes — they belong to /api/stream, not the proxy', () => {
    expect(isAllowedAdminRoute('GET', seg('/stream'))).toBe(false);
    expect(isAllowedAdminRoute('GET', seg('/knowledge/stream'))).toBe(false);
  });
});
