/**
 * Every query key in the app, in one place.
 *
 * ── WHY A REGISTRY AND NOT INLINE ARRAYS ───────────────────────────────────
 *
 * A cache only deduplicates requests whose keys are equal. The moment two
 * components spell the same query differently — `['news']` here and
 * `['news', 40]` there — they stop sharing an entry and the app is back to two
 * requests for one piece of data, except now it also looks like it is cached.
 * That failure is silent: nothing errors, the screens just each fetch.
 *
 * The same goes for invalidation. A mutation can only refresh what it can
 * name, so `qk.orders.all` existing as one exported prefix is what makes
 * "cancelling an order refreshes the blotter AND the portfolio AND the
 * dashboard card" a two-line change instead of a hunt through the tree.
 *
 * Keys are ordered general -> specific so a prefix invalidates its children:
 * invalidating `qk.orders.all` also clears every `qk.orders.list(...)`.
 */

export const qk = {
  /** Newswire. One entry per limit, because the endpoint is limit-paged. */
  news: {
    all: ['news'] as const,
    list: (limit: number) => ['news', limit] as const,
  },

  notifications: {
    all: ['notifications'] as const,
    list: (limit: number) => ['notifications', limit] as const,
  },

  /**
   * Tradable universe. The search key carries every filter because each
   * combination is a genuinely different server-side query — collapsing them
   * would serve one market's page under another market's key.
   *
   * `all` is the invalidation prefix a universe resync would clear.
   */
  universe: {
    all: ['universe'] as const,
    search: (params: Record<string, string | boolean | number | undefined>) =>
      ['universe', 'search', params] as const,
    facets: () => ['universe', 'facets'] as const,
    stats: () => ['universe', 'stats'] as const,
    instrument: (ref: string) => ['universe', 'instrument', ref] as const,
  },

  /** Paper-trading account. */
  portfolio: {
    all: ['portfolio'] as const,
    summary: () => ['portfolio', 'summary'] as const,
    positions: () => ['portfolio', 'positions'] as const,
    holdings: () => ['portfolio', 'holdings'] as const,
    trades: () => ['portfolio', 'trades'] as const,
  },

  orders: {
    all: ['orders'] as const,
    /** `undefined` status = "every status", which is a different list. */
    list: (statuses?: readonly string[]) =>
      ['orders', statuses ? [...statuses].sort().join(',') : 'all'] as const,
  },

  tradeHistory: {
    all: ['trade-history'] as const,
    list: (filters: Record<string, unknown>) => ['trade-history', filters] as const,
  },

  performance: {
    all: ['performance'] as const,
    overview: () => ['performance', 'overview'] as const,
    today: () => ['performance', 'today'] as const,
    valueSeries: (range: string) => ['performance', 'value-series', range] as const,
    dailyPnl: (range: string) => ['performance', 'daily-pnl', range] as const,
    monthlyReturns: (range: string) => ['performance', 'monthly-returns', range] as const,
    diary: (page: number, pageSize: number) => ['performance', 'diary', page, pageSize] as const,
  },

  /** Live market data. Short staleTime at the call site — see lib/query/live.ts. */
  quotes: {
    all: ['quotes'] as const,
    list: (symbols: readonly string[]) => ['quotes', [...symbols].sort().join(',')] as const,
  },

  optionChain: {
    all: ['option-chain'] as const,
    expiries: (symbol: string) => ['option-chain', 'expiries', symbol] as const,
    chain: (symbol: string, expiry: string) => ['option-chain', 'chain', symbol, expiry] as const,
  },

  learning: {
    all: ['learning'] as const,
    courses: () => ['learning', 'courses'] as const,
    lesson: (lessonId: string) => ['learning', 'lesson', lessonId] as const,
    quiz: (lessonId: string) => ['learning', 'quiz', lessonId] as const,
    flashcards: (lessonId: string) => ['learning', 'flashcards', lessonId] as const,
  },

  sentinel: {
    all: ['sentinel'] as const,
    templates: () => ['sentinel', 'templates'] as const,
    contract: (strategyId: string, watchId: string | null) =>
      ['sentinel', 'contract', strategyId, watchId ?? 'none'] as const,
    timeline: (watchId: string) => ['sentinel', 'timeline', watchId] as const,
    performance: (strategyId: string) => ['sentinel', 'performance', strategyId] as const,
  },

  billing: {
    all: ['billing'] as const,
    catalog: () => ['billing', 'catalog'] as const,
    trialStatus: () => ['billing', 'trial-status'] as const,
  },
} as const;
