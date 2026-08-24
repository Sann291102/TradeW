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
    '/graph/meta', '/graph/overview', '/graph/nodes', '/graph/neighborhood',
    '/graph/search', '/graph/node', '/graph/clusters', '/graph/path', '/graph/events',
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

  /**
   * The system graph is a READ surface. It names every route this API serves,
   * which of them are unguarded and which execution profiles are armed — and
   * it is a projection, never a store. A write rule appearing here would mean
   * the console could alter a map of the platform, or erase a historical
   * relationship, through a path whose whole purpose is to display one.
   */
  it('forwards no write on the system graph', () => {
    for (const path of ['/graph/nodes', '/graph/node', '/graph/meta', '/graph/neighborhood', '/graph/clusters']) {
      expect(isAllowedAdminRoute('POST', seg(path))).toBe(false);
    }
  });

  it('denies the SSE stream routes — they belong to /api/stream, not the proxy', () => {
    expect(isAllowedAdminRoute('GET', seg('/stream'))).toBe(false);
    expect(isAllowedAdminRoute('GET', seg('/knowledge/stream'))).toBe(false);
    expect(isAllowedAdminRoute('GET', seg('/graph/stream'))).toBe(false);
  });

  describe('Sentinel paper execution', () => {
    it('allows the execution reads the console renders', () => {
      expect(isAllowedAdminRoute('GET', seg('/execution/profiles'))).toBe(true);
      expect(isAllowedAdminRoute('GET', seg('/execution/intents'))).toBe(true);
      expect(isAllowedAdminRoute('GET', seg('/execution/stats'))).toBe(true);
      expect(isAllowedAdminRoute('GET', seg('/execution/status'))).toBe(true);
      expect(isAllowedAdminRoute('GET', seg('/execution/rejections'))).toBe(true);
      expect(isAllowedAdminRoute('GET', seg('/execution/trace/some-intent-id'))).toBe(true);
      expect(isAllowedAdminRoute('GET', seg('/execution/trace-by-order/some-order-id'))).toBe(true);
    });

    it('allows the arm and run writes, and only as POST', () => {
      expect(isAllowedAdminRoute('POST', seg('/execution/profiles/abc/enabled'))).toBe(true);
      expect(isAllowedAdminRoute('POST', seg('/execution/profiles/abc/run'))).toBe(true);
      // Arming a profile decides whether an autonomous agent may place orders.
      // It must never be reachable as a read, and the reads must never be
      // reachable as writes.
      expect(isAllowedAdminRoute('GET', seg('/execution/profiles/abc/enabled'))).toBe(false);
      // The two liveness reads are reads. Nothing on this console may start or
      // stop the loop — that is the env flag's job, on the API process.
      expect(isAllowedAdminRoute('POST', seg('/execution/status'))).toBe(false);
      expect(isAllowedAdminRoute('POST', seg('/execution/rejections'))).toBe(false);
      expect(isAllowedAdminRoute('GET', seg('/execution/profiles/abc/run'))).toBe(false);
      // `POST /execution/intents` stays denied: an intent is produced by a
      // Sentinel decision, never posted by an operator. (`POST
      // /execution/profiles` WAS denied here too until account binding landed
      // on 2026-08-18 — it is now the profile create/rebind route and is
      // asserted allowed in the account-binding test below.)
      expect(isAllowedAdminRoute('POST', seg('/execution/intents'))).toBe(false);
      expect(isAllowedAdminRoute('POST', seg('/execution/stats'))).toBe(false);
    });

    it('allows the account-binding reads and writes', () => {
      expect(isAllowedAdminRoute('GET', seg('/execution/accounts'))).toBe(true);
      expect(isAllowedAdminRoute('GET', seg('/execution/profiles/abc/authorization'))).toBe(true);
      expect(isAllowedAdminRoute('POST', seg('/execution/accounts/user-id/agent-trading'))).toBe(true);
      expect(isAllowedAdminRoute('POST', seg('/execution/profiles'))).toBe(true);
    });

    it('will not let the consent grant be reached as a read, or listed as a write', () => {
      // Granting a user's account to an autonomous agent is a write and only a
      // write; and the account LIST must never be a POST target.
      expect(isAllowedAdminRoute('GET', seg('/execution/accounts/user-id/agent-trading'))).toBe(false);
      expect(isAllowedAdminRoute('POST', seg('/execution/accounts'))).toBe(false);
      expect(isAllowedAdminRoute('POST', seg('/execution/profiles/abc/authorization'))).toBe(false);
    });

    it('does not forward an execution route the console has no rule for', () => {
      // Deny-by-default has to hold for this namespace too — a future admin
      // endpoint under /execution must stay unreachable until listed.
      expect(isAllowedAdminRoute('GET', seg('/execution'))).toBe(false);
      expect(isAllowedAdminRoute('POST', seg('/execution/run-all'))).toBe(false);
      expect(isAllowedAdminRoute('GET', seg('/execution/profiles/abc'))).toBe(false);
      // The wildcard is one segment, not a path.
      expect(isAllowedAdminRoute('GET', seg('/execution/trace/a/b'))).toBe(false);
      expect(isAllowedAdminRoute('POST', seg('/execution/profiles/a/b/enabled'))).toBe(false);
    });
  });
});
