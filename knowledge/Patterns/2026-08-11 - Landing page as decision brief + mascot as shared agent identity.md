# Landing page as decision brief + mascot as shared agent identity

Date: 2026-08-11
Files: `apps/web/src/components/brand/MascotMark.tsx` (new), `apps/web/src/components/landing/LandingPage.tsx`, `apps/web/src/components/landing/LandingHeader.tsx`, `apps/web/src/components/shell/FloatingAI.tsx`, `apps/web/src/components/shell/TopBar.tsx`

Related: [[Decisions/2026-07-21 - Sentinel reinstated as a TradeW workspace (decoupling reversed)]] · `docs/product-architecture/TRADEW-OS.md` §1 · `docs/design-reference/DESIGN-SYSTEM.md`

---

## 1. The brief that was missing

The landing page previously carried four surface cards, three principles and a
security list — enough to establish posture, not enough for a visitor to decide
whether to create an account. The product direction was explicit: **someone
should be able to tell from this page alone whether TradeW is for them.**

The page is now organised as a decision brief in this order, and the order is
the argument:

| Section | Question it answers |
|---|---|
| `#brief` | What am I actually getting? (six numbered items) |
| `#platform` | What is on each of the four surfaces? (four concrete bullets per card) |
| `#assistant` | What can the AI do, and where does it stop? |
| `#sentinel` | What is the premium tier actually for? |
| `#learning` | What is the curriculum? |
| `#intelligence` | What are the standing commitments? (pre-existing) |
| `#start` | What happens right after I sign up? |
| `#pricing` | What will this cost me? |
| `#security` | Is my money and data safe? (pre-existing) |
| `#faq` | The six objections, answered directly |

**Every claim on the page is traceable to a binding document** — a header
comment in `LandingPage.tsx` names which one per data block (`TRADEW-AI.md` §3
for the agent roster, `SENTINEL.md` §3 for the trap signals, `LEARNING-HUB.md`
§2 for the curriculum, `ONBOARDING.md` §2 for the sequence, `SUBSCRIPTIONS.md`
§§1–3 for the plans). This is the rule to keep: **no figure appears on the
marketing page that is not in one of those documents.** On a financial product
a marketing page that outruns the product is a compliance exposure, not
enthusiasm — the file's original copy-discipline comment ("no invented traction
numbers, no testimonials from people who do not exist") is extended, not
replaced.

Two honesty lines on the pricing section are load-bearing and must not be
removed as "fine print":

- *Placing an order is never gated by a plan* — `SUBSCRIPTIONS.md` §7's non-goal.
- *Payments are not switched on yet; no account can be charged today* — simply
  true. `SettingsClient.tsx` already carries the same caveat ("pricing display
  only — checkout isn't built yet"), and a pricing table that let a reader
  assume otherwise would be collecting intent under false terms.

## 2. The FAQ uses native `<details>`, deliberately

Not a JS accordion. Every answer stays in the server-rendered markup and is
findable by browser search before hydration — the same constraint that governs
`Reveal` (see §3). An accordion that hides answers until JS runs would put the
page's most decision-relevant text behind hydration.

## 3. The invisible-landing trap still applies to every new section

`Reveal` renders **visible** on the server (`state: 'ssr'`) and only hides
off-screen elements after the client takes over — the fix for the 2026-08-11
bug where 21 of 24 sections shipped as `style="opacity:0"`. Ten sections were
added on top of it, which is ten more chances to reintroduce that failure.

**Verification that should be repeated after any landing edit:**

```bash
curl -s http://localhost:3111/ > /tmp/tw.html
grep -o 'opacity:0'  /tmp/tw.html | wc -l   # must be 0 (0.55 on a gradient is fine)
grep -o 'id="[a-z]*"' /tmp/tw.html | sort -u # every section id must be present
```

Checking the *rendered HTML*, not the browser, is the point: the bug was
invisible in a warm dev browser and fatal in cold/no-JS conditions.

## 4. The mascot is one identity across two components

The robot the visitor meets on the landing page is the same character as the
floating assistant trigger inside the app. Making that true needed a second
component rather than a resized first one:

| | `landing/Mascot.tsx` | `brand/MascotMark.tsx` (new) |
|---|---|---|
| Size | 92–200px illustration | 18–24px icon |
| Content | head, chassis, terminal, hands, rotating candlestick brain | antenna, head, side pods, eyes, readout slot |
| Colour | design tokens (`--card`/`--bg` fill, teal rim) | **`currentColor`, monochrome** |
| Motion | framer-motion float + blink | none |

The colour split is the non-obvious part and the reason a resize would not have
worked. The full mascot is drawn in `--card` on `--bg` with a teal rim because
it sits on the page background; the mark sits **inside a filled teal button**
(`bg-teal text-white`), where a card-coloured chassis disappears entirely.
Inheriting `currentColor` means one component works on the teal FAB, on a card,
and in a header without a per-surface variant. `MascotMark` is also pure SVG
with no `'use client'`, so it renders in server components too.

**Both AI triggers were swapped, not just the floating one.** `FloatingAI`'s
FAB, `FloatingAI`'s dock header and `TopBar`'s "Ask TradeW AI" `IconButton` all
open the *same* dock, so a different icon on any of them reads as a different
feature. `AppFrame` mounts `FloatingAI`, so the swap covers every workspace
route at once — there is no per-page copy to keep in sync. Confirmed by
`grep -rl "M12 2.9v1.9" .next/static/chunks/` resolving to
`app/(workspace)/layout-*.js`.

`SparkleIcon` is **not** deleted — it is still used by `ChartPanel`,
`OptionChainTab` and the search provider registry. Only the assistant-identity
call sites changed.

## 5. Verifying this in a browser — the environment facts that cost time

Verified 2026-08-11 with a **real account**, not a forged session. Two false
starts are worth recording because neither is discoverable from the code:

- **`next build` clobbers a running `next dev`.** Both own `apps/web/.next`.
  Running a production build while the user's dev server was up left every
  `/_next/static/*` chunk returning HTTP 500 with `text/html`, so the page
  half-hydrated and the sign-in form reported a misleading **"API request
  failed"** — the API was fine; the client bundle had never loaded. Fix: stop
  the dev server, move `.next` aside, restart. Don't debug the API on that
  symptom.
- **CORS is pinned to port 3000.** Root `.env` `CORS_ORIGINS` lists
  `http://localhost:3000` only, so the web app must be served on **3000** —
  a scratch port like 3111 renders fine but every auth call fails.

The real-session recipe (no cookie forging — a forged `tw_auth` only unlocks
shell chrome and every API call still 401s, which makes any screenshot taken
that way worthless as evidence):

```bash
docker ps                       # tradew-postgres on 5433, already up
curl -s localhost:4000/health   # API; Swagger UI at localhost:4000/docs
curl -X POST localhost:4000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"...","password":"..."}'   # → {accessToken, refreshToken, user}
```

Then drive the actual `#auth` form in the browser rather than injecting the
token — the app sets `localStorage.tradew_token` and the `tw_auth` cookie
itself, which is the thing worth proving. `password` needs ≥6 chars server-side
(`AuthDto`), though the signup UI asks for 8.

Browser tooling is **not** vendored: `npx playwright install chromium` first,
and scripts must import Playwright from the npx cache by absolute path
(`.../npm-cache/_npx/<hash>/node_modules/playwright/index.js`) as a **default**
import — it is CommonJS, so `import { chromium } from 'playwright'` throws.

## 6. Two market-data clients that disagree — read this before adding a third

Discovered while wiring the assistant's quote lookup. `apps/web` has **two**
market-data clients returning **different numbers for the same symbol**:

| | `lib/dhanLiveFeed.ts` | `lib/marketData.ts` |
|---|---|---|
| Backend | live-feed bridge on **:4600**, no auth, no DB | `services/api` `/market-data/*`, auth-gated, DB-backed |
| Data | real Dhan ticks | **Simulated Market Data Engine** |
| NIFTY | 24,583.80 (`source: 'dhan'`) | 24,850 (`source: 'simulated'`) |
| Used by | IndexOverview, Ticker, MarketMovers, SectorHeatmap, TrendingStocks, WatchlistWidget, MarketsWorkspace, CommodityMarkets, DashboardHero, SentinelLiveCharts | `useLiveQuotes` — which **no component imports** |

So everything the user can see comes from the bridge, and the `services/api`
path is effectively dead in the UI despite being the one `ARCHITECTURE.md` §1's
"one public ingress" prescribes. **This is an unresolved architectural split,
not a settled design** — it is flagged here rather than fixed because picking a
winner is a product/infra decision.

The assistant was first wired to `marketData.ts` and answered "24,850" while the
dashboard tile beside it read "24,583.80". An assistant that contradicts the
screen is worse than one that declines, so `useAssistant.loadQuotes` now reads
the **bridge first** and falls back to the simulated engine only if the bridge
has no row — labelling which it used, per row, in the answer.

Two more findings from the same pass:

- `LiveQuote.source` was typed `'simulated'`. It is not — the API types it
  `string` and passes `Quote.source` through, so `dhan` rows come back on the
  same response. The narrow literal made every provenance check look pointless.
  Widened, with the reason recorded at the field.
- The simulated engine produced **RELIANCE +547.30 (+70.17%)** — `ltp` 1327 against
  a `close` of 780. The bridge gives −2.80 (−0.21%). Anything reading the
  simulated engine for a change figure is showing nonsense.

## 7. Why a sparkle was the wrong mark

A sparkle is what every product's AI button looks like; it says "there is an
LLM in here" and nothing else. TradeW's assistant has a specific, unusual
boundary — it operates the whole application and cannot touch the order path —
and a character the user has already been introduced to on the marketing page
carries that association in a way a generic glyph cannot.
