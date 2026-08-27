/**
 * The operator console's navigation, split into two HONEST groups.
 *
 * WHY TWO GROUPS
 *
 * A source-level parity audit (2026-08-12) found that the six working admin
 * surfaces migrated out of `apps/web/src/app/admin` were live and wired, but
 * four of them (`/ai`, `/cognition`, `/orders`, `/system`) had been dropped
 * from the sidebar — reachable only by typing the URL — while the sidebar
 * instead advertised eight not-yet-built modules. That inverted the truth: it
 * hid what works and promised what doesn't.
 *
 * `WORKING_NAV` is the reachable, wired surface. Everything in it renders real
 * data through `/api/proxy/*`. `SCAFFOLDED_NAV` is the planned taxonomy — each
 * route exists but renders `UnavailableState` ("Not built yet", naming the
 * upstream feed it is waiting on). Keeping them as separate lists is
 * deliberate: the sidebar labels the second group as planned, so an operator
 * is never misled into thinking a stub is a feature,
 * and nobody edits this file to "add a module" without seeing which half it
 * belongs in.
 *
 * Do NOT move a route from SCAFFOLDED to WORKING until its page actually reads
 * live data. The placeholder state is the honest signal that the work is not
 * done.
 */
export interface AdminNavItem {
  href: string;
  label: string;
  description: string;
}

/**
 * The wired, working surfaces — migrated verbatim from the old
 * `apps/web/src/app/admin` and reading real data via the standalone proxy.
 * Order is operator-workflow, not alphabetical: overview first, then the AI /
 * cognition surfaces, then knowledge, then the operational (orders) and
 * platform (users/system) views.
 */
export const WORKING_NAV: AdminNavItem[] = [
  { href: '/', label: 'Dashboard', description: 'System overview — traffic, AI network activity, health, top agents.' },
  { href: '/ai', label: 'AI & Sentinel', description: 'AI cost/latency by agent, run history, the live Sentinel agent orbit.' },
  { href: '/cognition', label: 'Perceptors & Neural', description: 'The four-layer cognition network — perceptors, learned weights, proposals.' },
  { href: '/knowledge', label: 'Knowledge Management', description: 'The engineering knowledge vault — tree, graph, recent changes (live).' },
  { href: '/lab', label: 'Agent Lab', description: 'What the agents are observing, why they did or did not act, and whether the Lab may run.' },
  { href: '/orders', label: 'Orders / OMS', description: 'Order flow, fills, rejects and trade stats across all users.' },
  { href: '/system', label: 'Users / System', description: 'Users, admin grants, audit trail, API health and route latency.' },
  { href: '/audit', label: 'Audit & Compliance', description: 'Every authentication event and every privileged operator action.' },
];

/**
 * The planned modules. Each route is scaffolded (routing, auth, nav) but its
 * page renders `UnavailableState` — no data, no sample numbers. These are NOT
 * implemented and must not be made to look like they are.
 */
export const SCAFFOLDED_NAV: AdminNavItem[] = [
  { href: '/health', label: 'Engine Health', description: 'Agent status, queue depth, latency, memory, model usage, errors.' },
  { href: '/agents', label: 'Agent Management', description: 'Enable/disable agents, confidence thresholds, prompts, versions.' },
  { href: '/reasoning', label: 'Reasoning Inspector', description: 'Full reasoning trace — agent votes, confidence, evidence, citations.' },
  { href: '/rules', label: 'TradingView Rule Management', description: 'Learned rules, approval workflow, rollback, version history.' },
  { href: '/learning-platform', label: 'Learning Platform', description: 'Courses, generated content, user progress, AI teacher analytics.' },
  { href: '/observability', label: 'Observability', description: 'API health, Dhan bridge, market-data pipeline, Redis, PostgreSQL, pgvector.' },
];

/**
 * Kept as a single flat export too, for any consumer that just needs "every
 * nav route" (e.g. a link audit). The two grouped lists above are what the
 * sidebar renders.
 */
export const ADMIN_NAV: AdminNavItem[] = [...WORKING_NAV, ...SCAFFOLDED_NAV];
