# Market Workspace — Dashboard → Landing Page Evolution

Status: **implemented (frontend-only), Phase 1 redesign.** Records the in-place evolution of the `/dashboard` route into the Market Workspace — the landing page / command center answering "what is happening in the market right now" — per the frontend redesign mission's explicit instruction to never delete or archive the dashboard, only evolve it.

## 1. What changed

The route (`/dashboard`) and its `page.tsx` are unchanged in identity — same path, same server-component shell. What changed is composition: `page.tsx` now renders a single `MarketWorkspace` client component (`apps/web/src/components/dashboard/MarketWorkspace.tsx`) instead of an inline static grid. `MarketWorkspace` applies the new `staggerContainerSlow`/`cardEntrance` motion variants (`packages/ui/src/motion/variants.ts`) to a section-level grid and composes:

- **Reused as-is** (all 7 pre-existing widgets, zero archived): `IndexOverview`, `PortfolioSummary`, `MarketMovers`, `MarketNews`, `WatchlistWidget`, `SectorHeatmap`, `TrendingStocks`.
- **Net-new** (`apps/web/src/components/dashboard/`): `GlobalMarkets`, `RiskAlerts`, `EconomicCalendar`, `SentinelBriefing`, `QuickLinks` — filling the sections the pre-redesign dashboard didn't cover (mock data added to `lib/mock/market.ts`: `GLOBAL_MARKETS`, `RISK_ALERTS`, `ECONOMIC_EVENTS`, `SENTINEL_BRIEFING`).

`IndexOverview`, `PortfolioSummary`, and `WatchlistWidget` were additionally enhanced in place: wrapped in `next/link` navigation, live figures rendered through the new `AnimatedNumber` primitive (`@tradew/ui`), and index/quick-link tiles use the new `Surface` primitive's `interactive` hover-lift.

## 2. Navigation contract

Every new interactive surface is a real `next/link`, not a placeholder — targets are today's existing routes, re-pointable to dedicated workspaces (NIFTY Analysis Workspace, Trade Workspace) in a later phase without touching this layout:

| Surface | Target |
|---|---|
| Index cards (NIFTY/BANKNIFTY/SENSEX/…) | `/markets` |
| Watchlist rows | `/markets` |
| Portfolio Summary card | `/portfolio` |
| Sentinel Daily Briefing | `/sentinel` |
| Quick Links: NIFTY, BANKNIFTY | `/markets` |
| Quick Links: Option Chain | `/trade` |
| Quick Links: Research | `/research` |
| Quick Links: Journal | `/sentinel` |

## 3. Why AnimatedNumber doesn't tween on live ticks

`AnimatedNumber` (`packages/ui/src/components/AnimatedNumber.tsx`) deliberately does **not** animate the digits between values on every update — `TRADEW-OS.md` §8 states ticks update in place, no animated count-up, because "speed-to-information is the product's core metric." The only per-tick animation is a brief up/down background flash (`priceFlash` variant). `PortfolioSummary`'s metrics opt into `countUpOnMount` — a one-time reveal-from-zero on first render, which is not a live tick and doesn't conflict with that rule.

## 4. Not in this phase

Global/Risk/Economic/Sentinel-briefing sections use static mock data — no live feed. The Sentinel briefing summary is hand-authored mock copy in the same shape the real `/sentinel` `synthesis` object uses, so wiring it to the real endpoint later is a data-source swap, not a component rewrite (see [`SENTINEL.md`](SENTINEL.md) §5).
