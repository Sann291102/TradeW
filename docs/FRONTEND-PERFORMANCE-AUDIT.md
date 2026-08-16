# Frontend Performance & Reliability Audit — `apps/web`

**Scope:** every `.ts`/`.tsx` under `apps/web/src` (285 files, ~40k lines).
**Premise:** the Sentinel bugs (forced remounts, aggressive fetching, no
caching, permanent error states) were not local to Sentinel. They were the
visible end of platform-wide defaults. This audit finds every instance and
fixes the defaults.

---

## Phase 1 — Discovery

### 1. Forced remounts

| Severity | Location | Affects |
|---|---|---|
| **P0** | `components/shell/AppFrame.tsx:108` — `key={pathname}` inside `<AnimatePresence mode="wait">` | **Every workspace route** |

This is the single highest-impact finding, and it is the root cause the rest of
the audit kept running into. Two defects in one expression:

- `key={pathname}` tore down and rebuilt the **entire route subtree** on every
  pathname change — including dynamic-segment moves
  (`/learning/a/b` → `/learning/a/c`) and RSC payload re-fetches. Every
  `useEffect` fetch re-fired cold, every poller restarted its clock, and all
  client state (scroll position, active tab, filters, a half-typed order) was
  discarded. Navigating away and back was a cold boot.
- `mode="wait"` held the outgoing tree mounted for the full 250ms exit before
  the incoming one was allowed to mount — so both trees existed and both
  fetched, and the user saw a quarter-second of blank main area on every
  navigation.

No `key={router.asPath}`, `key={Date.now()}` or `key={Math.random()}` anywhere.

### 2. Aggressive / uncached fetching

No caching library was installed at all. Every read in the app was a bare
`useEffect` + `fetch` via `lib/api.ts`. 45+ call sites; the load-bearing ones:

| Severity | Location | Affects |
|---|---|---|
| P1 | `app/(workspace)/portfolio/PortfolioClient.tsx:58` | Portfolio |
| P1 | `components/dashboard/PortfolioSummary.tsx:43` | Dashboard |
| P1 | `components/terminal/panels/BlotterPanel.tsx:59,76` | Trade terminal |
| P1 | `components/portfolio/sections/OrdersSection.tsx:36` | Portfolio |
| P1 | `components/portfolio/sections/TradeHistorySection.tsx:35` | Portfolio |
| P1 | `components/portfolio/sections/PerformanceSection.tsx:39,213,233,257,284` | Portfolio |
| P1 | `components/dashboard/TodaysTrades.tsx:32` | Dashboard |
| P1 | `components/learning/LearningClient.tsx:55` | Learning |
| P1 | `components/learning/CoursePathClient.tsx:28,46` | Learning |
| P1 | `components/sentinel/StrategyCatalogue.tsx:31` | Sentinel |
| P1 | `components/sentinel/StrategyWorkspace.tsx:45` | Sentinel |
| P1 | `components/sentinel/StrategyTimelineFeed.tsx:62` | Sentinel |
| P1 | `components/sentinel/StrategyFocusPanel.tsx:50` | Sentinel |
| P1 | `components/sentinel/StrategySelector.tsx:40` | Sentinel |
| P1 | `app/(workspace)/checkout/CheckoutClient.tsx:45` | Billing |
| P1 | `components/sentinel/SentinelPricingView.tsx:57,62` | Billing |
| P1 | `lib/sentinel/useExpiries.ts:42` | Sentinel / Trade |
| P1 | `components/terminal/panels/chart-tabs/OptionChainTab.tsx:173,211` | Trade terminal |

### 3. Missing request deduplication

Same endpoint fetched independently by siblings:

| Severity | Endpoint | Duplicate callers |
|---|---|---|
| P1 | `/news` | `MarketNews` (limit 3), `NewsPanel` (12), `NewsClient` (40) — three timers, three requests, and they could disagree about the top headline |
| P1 | `/notifications` | `NotificationSync` (limit 50 → store), `NotificationsClient` (limit 100 → local state) |
| P1 | `/sim/portfolio` | `PortfolioClient`, `PortfolioSummary` |
| P1 | `/sim/positions` | `PortfolioClient`, `BlotterPanel` |
| P1 | `/learning/courses` | `LearningClient`, `CoursePathClient` |
| P1 | `/payments/catalog` | `CheckoutClient`, `SentinelPricingView` — two screens that must never quote different prices |
| P1 | `/optionchain/expirylist` | `useExpiries`, `OptionChainTab`, `ApplyStrategyDialog` |
| P2 | `useSignedIn` | Copy-pasted verbatim into `PortfolioClient`, `PortfolioSummary`, `TodaysTrades` |
| P2 | hand-rolled in-flight maps | `useOptionQuote.ts:61`, `useHasOptionChain.ts:36` — bespoke dedup caches, one per file |

### 4. Permanent error states

| Severity | Location | Why it is terminal |
|---|---|---|
| **P0** | `lib/sentinel/useExpiries.ts:42` | `void (async () => …)()` with **no catch**. A rejection became an unhandled promise rejection and left `status: 'loading'` forever — an unresolvable spinner with no retry. |
| **P0** | `components/portfolio/sections/PerformanceSection.tsx:213,233,257,284` | `void fetchX().then(setState)` — rejection swallowed, skeleton up forever, four charts. |
| **P0** | `components/sentinel/StrategySelector.tsx:43` | `setLoadError(true)` — a boolean nothing could ever clear. Registry lost to one 502 = permanently empty selector. |
| P1 | `components/sentinel/StrategyWorkspace.tsx:53` | `if (error && !contract) return <p>` — no retry. |
| P1 | `components/sentinel/StrategyCatalogue.tsx:52` | Same shape. |
| P1 | `components/learning/LearningClient.tsx:90`, `CoursePathClient.tsx:33` | Same shape. |
| P1 | `components/dashboard/MarketNews.tsx`, `app/(workspace)/news/NewsClient.tsx` | Error banner, no retry. |
| P1 | `OptionChainTab.tsx:173,211` | `.then()` with no `.catch`. |

Only two surfaces in the entire app had a retry affordance before this pass:
`SentinelStrategyWorkspace.tsx` and `NotificationsClient.tsx`.

**Nothing treated 429 or 5xx as transient.** There was no retry policy at all.

### 5. Polling waste

Pollers that ran regardless of tab visibility:

| Severity | Location | Cadence |
|---|---|---|
| P1 | `PortfolioClient.tsx` | 5s |
| P1 | `PortfolioSummary.tsx` | 5s |
| P1 | `BlotterPanel.tsx` | 5s (×3 endpoints) |
| P1 | `TodaysTrades.tsx` | 5s |
| P1 | `useOptionChainStrikes.ts:120` | 4s |
| P1 | `OptionChainTab.tsx:215` | chain refresh |
| P1 | `PerformanceSection.tsx:50` | 15s |
| P1 | `NotificationSync.tsx:78` | 30s |
| P1 | `MarketNews` / `NewsPanel` / `NewsClient` | 120s each |
| P1 | `StrategyWorkspace.tsx:59`, `StrategyTimelineFeed.tsx:77` | 10s |
| P1 | `useDhanLiveFeed.ts:88` | 5s (the no-EventSource fallback path) |

Already correct before this audit, and left alone: `useSentinel.ts`,
`useStrategyWorkspace.ts`, `useWatchPrices.ts` all gate on `document.hidden`,
and the Dhan feed's SSE path is a shared singleton.

### 6. Mutation cache bugs

| Severity | Location | Bug |
|---|---|---|
| P1 | `OrdersSection.tsx:52` | Cancel/modify refreshed only its own list. Margin freed by a cancellation was not reflected in the Portfolio summary on the same screen. |
| P1 | `NotificationsClient.tsx:43,52` | Mark-read patched local state only; the top-bar bell kept counting the item for up to 30s. |
| P1 | `LessonClient.tsx:42,244` | `completeLesson` / `recordQuiz` did not refresh `/learning/courses`, so the hub's progress ring and the course page's ticks stayed stale. |
| P1 | `CoursePathClient.tsx:45` | `refresh()` then re-fetch into local state — the Learning hub's copy of the same catalogue stayed stale. |
| P1 | `StrategyCatalogue.tsx:44` | Adopt did not invalidate the catalogue or the strategy list. |
| P2 | `NotificationsClient` | Comment claimed "optimistic UI"; the code awaited the round-trip first. |

### 7. Loading state abuse

| Severity | Location | Issue |
|---|---|---|
| P2 | `PerformanceSection` ×4 panels | `setState(null)` before every range switch — chart collapsed to a grey block even for an already-viewed range |
| P2 | `TradeHistorySection`, `OrdersSection` | `setRows(null)` on every filter/tab change — table collapsed, pagination jumped |
| P2 | `CoursePathClient:35`, `LessonClient:343`, `profile/page.tsx:60` | Bare `Loading…` text, no skeleton |
| P2 | `BlotterPanel` | Collapsing the panel discarded rows; re-opening re-fetched from cold |

Good practice already present and preserved: `MarketNews`, `NewsPanel`,
`NewsClient`, `NotificationsClient`, `LearningClient` and the portfolio
sections all use the shared `Skeleton` component with real dimensions.

### 8. Hard reloads as state management

**None.** No `window.location.reload()`, no `window.location.href` for in-app
navigation, no `router.replace(router.asPath)`. This category came back clean.

---

## Phase 2 — Prioritisation

| Priority | Finding | Count |
|---|---|---|
| **P0** | Forced remount on every workspace route (`AppFrame`) | 1 |
| **P0** | Permanent error states on core features (unhandled rejections, unclearable flags) | 3 sites, 7 surfaces |
| **P0** | Hard reloads in user flow | 0 — none found |
| **P1** | Raw uncached fetch on core workspaces | 18 |
| **P1** | Missing dedup between siblings | 7 endpoints |
| **P1** | Missing mutation invalidation on CRUD | 5 |
| **P1** | Polling that ignores tab visibility | 11 |
| **P2** | Layout shift / loading polish / duplicated helpers | 9 |

---

## Phase 3 — Fixes applied

### Fix A — Global route stability

`AppFrame.tsx`: removed `key={pathname}` and the `AnimatePresence mode="wait"`
wrapper around the route tree. The fade is preserved — it is now replayed
through `useAnimationControls` on pathname change, so children reconcile
instead of remounting. `AnimatePresence` is still used for the mobile drawer
scrim, where an exit animation is what it is for.

### Fix B — Global query client

- `lib/queryClient.ts` — `staleTime` 5min, `gcTime` 30min, retry on 429/5xx
  **and network-level failures**, exponential backoff capped at 30s with up to
  500ms jitter, `refetchOnWindowFocus`, `refetchOnReconnect`,
  `placeholderData: previous`.
- `components/providers/QueryProvider.tsx` mounted in the **root** layout so
  bare routes and workspace routes share one cache.
- `lib/query/keys.ts` — every query key in one registry, so siblings cannot
  accidentally spell the same query differently and lose dedup.
- `lib/query/live.ts` — `liveQueryOptions()` for genuinely-live data.
  `refetchInterval` is paused by react-query while the window is unfocused,
  which is the `enabled: isVisible` behaviour the audit asked for, applied once
  rather than remembered in a dozen components.

Two deliberate deviations from the brief, both documented in the file:

1. **`retry` also retries network failures.** The literal rule
   (`error?.status === 429 || error?.status >= 500`) returns `false` for a
   thrown `TypeError` — a request that never reached the server. That is the
   *most* transient failure of the set; the literal rule would make a two-second
   Wi-Fi blip as fatal as a 403.
2. **No eagerly-evaluated `export const queryClient`.** A module-level `const`
   resolves once per server process, which in Next — where client components are
   server-rendered — is one cache shared by every concurrent user. `getQueryClient()`
   returns a per-render throwaway on the server and a true singleton in the browser.

### Fix C — Migrations

Domain hooks: `useNews`, `useNotifications`, `usePortfolio`, `useLearning`,
`useSentinel`, `useBilling`. Migrated: all three news surfaces, both
notification surfaces, `PortfolioClient`, `PortfolioSummary`, `BlotterPanel`,
`OrdersSection`, `TradeHistorySection`, `PerformanceSection` (all five
queries), `TodaysTrades`, `LearningClient`, `CoursePathClient`,
`StrategyWorkspace`, `StrategyTimelineFeed`, `StrategyCatalogue`,
`StrategyFocusPanel`, `StrategySelector`, `CheckoutClient`,
`SentinelPricingView`, `useExpiries`, `OptionChainTab` (expiry list).

Two manual request-ticket guards (`StrategyWorkspace`, `StrategyTimelineFeed`)
were deleted rather than ported: keying by watch id makes the race structurally
impossible, because a slow response lands in the entry it belongs to.

`useSignedIn` de-duplicated from three copies into `lib/query/usePortfolio`.

### Fix D — Error states and invalidation

Retry affordances added to 12 surfaces. `invalidateTradingData()` names the
whole blast radius of a trading action once, so order mutations refresh
positions, holdings, summary, trade history and performance together.
Notification mark-read is genuinely optimistic now, with rollback.

---

## Known gaps (deliberately not changed)

- **`useOptionChainStrikes`** keeps its hand-rolled state machine and interval.
  Its sticky-ATM ref and three-way `unavailable` reporting are intricate enough
  that a rewrite carries more risk than the remaining benefit; it was already
  gated by `enabled` for collapsed panels, and it now also skips polls while the
  tab is hidden. The chain fetch it shares with `OptionChainTab` and
  `useWatchPrices` is still un-deduplicated.
- **`useOptionQuote` / `useHasOptionChain`** keep their bespoke in-flight maps.
- **`useLiveQuotes`** (`lib/hooks/useLiveQuotes.ts`) was left as-is: it has
  **zero call sites**. It is dead code and should be deleted, not migrated.
- **`apps/web` does not declare `vitest`** despite having a `test` script that
  invokes it. It currently resolves only because sibling workspaces hoist it to
  the root `node_modules`. Pre-existing, unrelated to this pass, worth fixing.
