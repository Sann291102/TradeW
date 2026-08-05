---
name: sentinel-workspace-premium-redesign-2026-08-05
description: Presentation-only redesign of /sentinel to a two-column institutional layout, and the two design-token misuses it uncovered (bg-surface, /opacity on var() colors)
metadata:
  type: pattern
---

# Sentinel workspace premium redesign (two-column rail layout)

**Read before restyling any `apps/web/src/components/sentinel/*` panel, and before using a Tailwind `/opacity` modifier anywhere in this repo.**

## What changed

Presentation-only redesign of `/sentinel` to match a premium desktop reference screenshot. Same `useSentinel(symbol, { strategyMode, selectedStrategyIds })` call, same `POST /sentinel/observe` and `GET /sentinel/strategies/registry` contracts, same `deriveContext` derivations, same entitlement gate, same honest-fault states. Nothing in `services/api`, `services/sentinel`, or Prisma touched.

The structural change is the layout, not the components: a single-column stack of full-width cards became **the market read on the left, Sentinel's commentary on it in a right rail** (`xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]`, collapsing to one column below `xl` because the three live charts need real width before the split earns its keep).

- **Left column** — `DayClassificationCard`, `SentinelLiveCharts`, `MarketContextPanel`. What the tape is doing.
- **Right rail** — `StrategySelector`, `SideInFocusCard`/`WaitingForConfirmation`, `LiveSafetyFeed`, `ContextualTraining`, `SentinelTimeline`. What Sentinel says about it.

New files: `SentinelHeader.tsx` (title + entitlement chip + the existing `OptionChainPanel`/`MarketSelector` passed in as `controls`, so market selection flow is untouched), `sentinel-icons.tsx` (market-context dimension glyphs keyed on `MarketContextDimension.label`, with a fallback so a new server-side dimension degrades instead of leaving an empty tile), `SentinelArt.tsx` (decorative shield/radar SVG). Pre-redesign originals are in `archive/apps-web-sentinel-pre-premium-redesign-2026-08-05/` per [[../../CLAUDE.md]] Rule 1.

## Two design-token misuses this uncovered

Both pre-existing, both silent — which is the point worth remembering.

1. **`bg-surface` does not exist.** `SentinelLiveCharts`' `ChartTile` had `bg-surface`; there is no `surface` key in `packages/ui/src/tailwind-preset.ts`, so the tile rendered with no background at all. Tailwind emits nothing for an unknown color and never warns.
2. **`/opacity` modifiers do nothing on this repo's color tokens.** `SideInFocusCard` used `border-up/40 bg-up/5 bg-up/15 bg-bg/60`. The preset maps colors to `var(--token)`, not rgb channels, and its own header comment says opacity modifiers are therefore intentionally unsupported. The supported route is the dedicated `*-bg` tint token (`bg-up-bg`, `bg-teal-bg`, `bg-down-bg`). Anything of the form `<token>/<number>` in this codebase is a no-op — grep for it before trusting a tint.

## What the reference asked for that the design system wouldn't give

The reference's "Premium" chip is violet. There is no violet token, and `DESIGN-SYSTEM.md` §1 reserves color for meaning (green/red are market direction only, teal is brand). It ships in brand teal. It is also a **real entitlement readout** — rendered only when the session carries the `sentinel` capability, the same check that decides `SentinelLocked` — never an upsell button, because a user without the capability never reaches this page.

Three interactions in the reference were genuinely new, and all three were built to fetch nothing:

- **Live Charts full-screen** — the same three panels and the same hooks, drawn against the viewport (`fixed inset-0`, Escape to exit, body scroll locked). No extra request.
- **Session timeline level filter** — filters `entries` already in the client, and only offers chips for levels the session actually produced.
- **Session timeline CSV export** — writes exactly the rows on screen, so a filtered export never claims to be the whole session.

`ShieldHeroArt`/`TrainingRadarArt` use **fixed** candle geometry, deliberately not derived from market data. A decorative series that looked like a chart but wasn't would be a lie about the tape — which is precisely what the rest of this workspace refuses to do (`SentinelLiveCharts` says "no reachable data" rather than drawing a placeholder series; `useSentinel` has no demo fallback at all, see [[2026-07-23 - Sentinel market selector + event-driven safety feed]]).

## The honest-data-gap tile

`MarketContextPanel` gives any dimension with `known === false` a **double-width** tile. Its "not enough data yet" copy is the longest string in the grid; a quarter-width tile is exactly the pressure that pushes a designer toward shortening it into something vaguer. Same principle as the Learning homepage pass — see [[2026-08-05 - Learning homepage premium redesign (honest data-gap handling)]].

## Related

- [[2026-07-23 - Sentinel market selector + event-driven safety feed]] — the market head selector and the `pushworthy` flag this layout still drives
- [[2026-08-05 - Sentinel multi-strategy selection (Phase 2 of reasoning consolidation)]] — `StrategySelector`'s multi-select behaviour, unchanged here
- [[../Decisions/2026-07-21 - Sentinel reinstated as a TradeW workspace (decoupling reversed)]] — why `/sentinel` keeps the standard Sidebar/TopBar shell rather than owning its own chrome
