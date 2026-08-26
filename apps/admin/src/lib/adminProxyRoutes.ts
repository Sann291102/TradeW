/**
 * The explicit allowlist of `services/api/admin/*` routes the standalone console
 * proxy will forward.
 *
 * WHY AN ALLOWLIST INSTEAD OF `/admin/:path*`
 *
 * The same lesson `apps/web/feed-proxy-routes.mjs` records for the Dhan bridge.
 * The catch-all proxy holds the operator token and forwards it to EVERY
 * `/admin/*` route — every route that exists today and every route anyone adds
 * later. A wildcard means the blast radius of the proxy is "the entire admin
 * surface, forever", and a new admin endpoint becomes reachable through this
 * console with no change here and no review step that would notice.
 *
 * Inverting the default fixes that: a new admin route is unreachable through the
 * proxy until someone adds it to this file — a deliberate act in a module whose
 * whole subject is what the console may call. Adding a route here is not "a page
 * needs it"; it is "an authenticated operator is allowed to invoke this".
 *
 * This list mirrors `lib/api.ts` (the client) and `lib/knowledge.ts`. The SSE
 * streams (`/admin/stream`, `/admin/knowledge/stream`) are deliberately absent:
 * they are served by dedicated Route Handlers under `/api/stream`, not this
 * proxy, so they never reach here.
 *
 * Kept as its own module, not inlined in the Route Handler, so it can be
 * unit-tested — see adminProxyRoutes.test.ts.
 */

type Method = 'GET' | 'POST';

/** One allowed route. `segments` is matched against the path AFTER the
 *  `/admin/` prefix that the proxy adds; `'*'` matches exactly one path segment
 *  (an id), never a slash and never nothing. */
interface RouteRule {
  method: Method;
  segments: (string | '*')[];
}

export const ADMIN_PROXY_ROUTES: RouteRule[] = [
  // --- Overview / health -----------------------------------------------------
  { method: 'GET', segments: ['overview'] },
  { method: 'GET', segments: ['health'] },

  // --- API telemetry ---------------------------------------------------------
  { method: 'GET', segments: ['api-calls'] },
  { method: 'GET', segments: ['api-calls', 'timeseries'] },
  { method: 'GET', segments: ['api-calls', 'routes'] },
  { method: 'GET', segments: ['api-calls', 'pulse'] },

  // --- AI telemetry ----------------------------------------------------------
  { method: 'GET', segments: ['ai', 'calls'] },
  { method: 'GET', segments: ['ai', 'by-agent'] },
  { method: 'GET', segments: ['ai', 'by-model'] },
  { method: 'GET', segments: ['ai', 'timeseries'] },

  // --- Agents ----------------------------------------------------------------
  { method: 'GET', segments: ['agents', 'states'] },
  { method: 'GET', segments: ['agents', 'runs'] },
  { method: 'GET', segments: ['agents', 'runs', '*'] },

  // --- Orders / trades / users / audit --------------------------------------
  { method: 'GET', segments: ['orders'] },
  { method: 'GET', segments: ['orders', 'stats'] },
  { method: 'GET', segments: ['trades'] },
  { method: 'GET', segments: ['users'] },
  { method: 'GET', segments: ['audit'] },
  // The one privileged write on this surface — grant/revoke admin. Attributed
  // to the operator by AdminAccessGuard's req.user.sub.
  { method: 'POST', segments: ['users', 'set-admin'] },

  // --- Cognition network -----------------------------------------------------
  { method: 'GET', segments: ['cognition', 'overview'] },
  { method: 'GET', segments: ['cognition', 'perceptors'] },
  { method: 'GET', segments: ['cognition', 'domains'] },
  { method: 'GET', segments: ['cognition', 'episodes'] },
  { method: 'GET', segments: ['cognition', 'episodes', '*'] },
  { method: 'GET', segments: ['cognition', 'percepts'] },
  { method: 'GET', segments: ['cognition', 'synapses'] },
  { method: 'GET', segments: ['cognition', 'proposals'] },
  { method: 'POST', segments: ['cognition', 'perceptors', '*', 'enabled'] },
  { method: 'POST', segments: ['cognition', 'proposals', '*', 'resolve'] },
  { method: 'POST', segments: ['cognition', 'run'] },

  // --- Sentinel paper execution ---------------------------------------------
  // Reads for the Orders & OMS execution views and the per-order trace.
  { method: 'GET', segments: ['execution', 'profiles'] },
  { method: 'GET', segments: ['execution', 'intents'] },
  { method: 'GET', segments: ['execution', 'stats'] },
  // Is the loop ticking, and why did today's decisions not become orders. Both
  // are reads of state the console cannot derive: the first is the API
  // process's own liveness, the second a grouping the browser would otherwise
  // do over every intent it could fetch.
  { method: 'GET', segments: ['execution', 'status'] },
  { method: 'GET', segments: ['execution', 'rejections'] },
  { method: 'GET', segments: ['execution', 'trace', '*'] },
  { method: 'GET', segments: ['execution', 'trace-by-order', '*'] },
  // The two writes. Arming a profile is the switch that decides whether an
  // autonomous agent may place orders, so it is listed here individually and
  // audited upstream (`execution.profile.enabled`) — never reachable through a
  // wildcard. Neither route can place an order directly; there is no such route.
  { method: 'POST', segments: ['execution', 'profiles', '*', 'enabled'] },
  { method: 'POST', segments: ['execution', 'profiles', '*', 'run'] },
  // Account binding. `accounts` returns TradeW accounts a USER_PAPER profile
  // may target and carries no credential field — the upstream handler does not
  // even select passwordHash/googleId. The two writes are the consent grant and
  // the profile binding itself; both are audited upstream with the acting
  // operator, and neither can place an order.
  { method: 'GET', segments: ['execution', 'accounts'] },
  { method: 'GET', segments: ['execution', 'profiles', '*', 'authorization'] },
  { method: 'POST', segments: ['execution', 'accounts', '*', 'agent-trading'] },
  { method: 'POST', segments: ['execution', 'profiles'] },

  // --- The execution state machine (2026-08-24) ------------------------------
  //
  // `state` is the single write that arms, disarms, pauses, resumes and — with
  // ARM_LIVE — authorizes real broker orders. It is listed as ONE rule because
  // upstream it is one endpoint taking an action, and the action is validated
  // against `OPERATOR_ACTIONS` there. Listing it here does NOT widen what an
  // operator may do: ARM_LIVE is still refused unless the profile is
  // PAPER_QUALIFIED with a passing snapshot, and no value in this request body
  // can waive that.
  { method: 'POST', segments: ['execution', 'profiles', '*', 'state'] },
  { method: 'GET', segments: ['execution', 'profiles', '*', 'state-history'] },
  // Paper qualification. The GET is a pure read; the POST re-measures and may
  // promote PAPER_RUNNING → PAPER_QUALIFIED. Neither can reach a live state —
  // that is ARM_LIVE above, and the transition table refuses it from anywhere
  // else.
  { method: 'GET', segments: ['execution', 'profiles', '*', 'qualification'] },
  { method: 'POST', segments: ['execution', 'profiles', '*', 'qualification', 'evaluate'] },
  // Per-pass telemetry, including the passes that decided nothing.
  { method: 'GET', segments: ['execution', 'runs'] },
  { method: 'GET', segments: ['execution', 'profiles', '*', 'runs'] },
  // "Would this user see AutoTrade, and why not." A read of the same decision
  // the user's own endpoint returns. There is deliberately NO console route
  // that switches a user's AutoTrade on — that is the account holder's act and
  // an operator must not be able to perform it for them.
  { method: 'GET', segments: ['execution', 'autotrade', '*'] },

  // --- System graph (read-only projection of the whole platform) ------------
  // Every rule here is a GET. There is deliberately no write on this surface:
  // the visualisation is never the source of truth, so the console has no way
  // to pin, hide or delete a node, and no way to erase a historical
  // relationship. The SSE stream is absent for the same reason the other two
  // are — it is served by a dedicated Route Handler at /api/stream/graph.
  { method: 'GET', segments: ['graph', 'meta'] },
  { method: 'GET', segments: ['graph', 'overview'] },
  { method: 'GET', segments: ['graph', 'nodes'] },
  { method: 'GET', segments: ['graph', 'neighborhood'] },
  { method: 'GET', segments: ['graph', 'search'] },
  { method: 'GET', segments: ['graph', 'node'] },
  { method: 'GET', segments: ['graph', 'clusters'] },
  { method: 'GET', segments: ['graph', 'path'] },
  { method: 'GET', segments: ['graph', 'events'] },

  // --- Knowledge workspace (read-only vault) --------------------------------
  { method: 'GET', segments: ['knowledge', 'tree'] },
  { method: 'GET', segments: ['knowledge', 'file'] },
  { method: 'GET', segments: ['knowledge', 'recent'] },
  { method: 'GET', segments: ['knowledge', 'search'] },
  { method: 'GET', segments: ['knowledge', 'graph'] },
  { method: 'GET', segments: ['knowledge', 'activity'] },
];

/**
 * Is (method, path) an allowed forward? `path` is the segment array the proxy
 * received (Next.js has already split on `/` and percent-decoded each part).
 *
 * A `'*'` in a rule matches exactly one concrete segment. Any segment that is
 * empty or a `.`/`..` traversal token fails the whole match, so a crafted
 * `cognition/../users` (were it ever to arrive un-normalised) cannot slip
 * through against the `cognition/*` rules.
 */
export function isAllowedAdminRoute(method: string, path: string[]): boolean {
  const upper = method.toUpperCase();
  if (upper !== 'GET' && upper !== 'POST') return false;
  if (path.length === 0) return false;
  if (path.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;

  return ADMIN_PROXY_ROUTES.some((rule) => {
    if (rule.method !== upper) return false;
    if (rule.segments.length !== path.length) return false;
    return rule.segments.every((seg, i) => seg === '*' || seg === path[i]);
  });
}
