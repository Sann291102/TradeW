# Chapter 13 — Chart Engine

**Status: 🟡.** Candlestick rendering, IST-correct axes, live last-bar patching, timeframes, and a client-side indicator library are 🟢. Drawing tools, replay, chart-native multi-layout, custom indicators, and the licensed TradingView embed are 🔵.

---

## 13.1 Why we render our own chart

TradeW does not embed TradingView's charting library today. It uses **`lightweight-charts`** (Apache-2.0, from the same authors).

| | `lightweight-charts` (today) | TradingView Charting Library (Phase 9 🔵) |
|---|---|---|
| Licence | Apache-2.0, free | commercial, negotiated |
| Bundle | ~45 KB gzipped | ~1 MB+ |
| Drawing tools | none — build your own | complete |
| Indicators | none — build your own | ~100 built in |
| Data feed | you supply arrays | UDF/JS adapter contract |
| Control | total | constrained by the widget API |
| Time to first chart | hours | weeks (contract + integration) |

The decision recorded in `TRADINGVIEW-WORKSPACE.md` is that both will coexist: our own chart for the terminal's dockable panels, and a licensed TradingView **workspace** as a separate surface for users who want the full drawing and indicator toolkit. Hosting model — self-host vs. licensed white-label embed — is open decision **OD-4**.

`TradeChart.tsx`'s own docstring calls it *"the interim"*, which is honest: it is what ships while the licensing question is unresolved, and it is good enough that the answer is not urgent.

---

## 13.2 File map

```
apps/web/src/
├── components/charts/TradeChart.tsx        the renderer
├── components/terminal/panels/ChartPanel.tsx  dock integration, toolbar
├── lib/hooks/useCandles.ts                 data loading + fallback
├── lib/hooks/useDhanLiveFeed.ts            live tick subscription
├── lib/dhanLiveFeed.ts                     bridge client (/candles, /quotes)
├── lib/technicals.ts                       indicator maths (pure functions)
└── lib/mock/candles.ts                     simulated fallback series
```

---

## 13.3 The IST timezone problem 🟢

The most valuable 40 lines in the chart, and a bug class that would have shipped silently.

### 13.3.1 The failure

```
/**
 * lightweight-charts renders time-axis/crosshair labels from a plain JS
 * `Date`, which formats in the *browser's* local timezone by default — NSE
 * trading hours (9:15–15:30) are IST-relative, so on any machine not itself
 * set to IST the axis silently drifts (e.g. renders in UTC, ~5.5h earlier).
 */
```

Consider what a developer in London sees without the fix:

```
   REALITY (IST)              WHAT THE AXIS SHOWS (UTC, no fix)
   09:15  session open        03:45
   12:00  midday              06:30
   15:30  session close       10:00
```

The chart is not *wrong* — every bar is in the right place relative to every other bar. It is *unreadable*, and worse, it is plausibly readable: a trader glancing at it sees times that look like times and draws conclusions about session structure that are five and a half hours out.

### 13.3.2 The fix

Two explicit formatters pinning every label to `Asia/Kolkata`:

```ts
function istTickMarkFormatter(time: Time, tickMarkType: TickMarkType): string {
  const date = new Date((time as number) * 1000);
  switch (tickMarkType) {
    case TickMarkType.Year:       return date.toLocaleString('en-US', { year: 'numeric', timeZone: 'Asia/Kolkata' });
    case TickMarkType.Month:      return date.toLocaleString('en-US', { month: 'short',  timeZone: 'Asia/Kolkata' });
    case TickMarkType.DayOfMonth: return date.toLocaleString('en-US', { day: 'numeric',  timeZone: 'Asia/Kolkata' });
    case TickMarkType.TimeWithSeconds:
      return date.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
    default:
      return date.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  }
}
```

> ⚠️ **Any new time-formatted surface must pin `timeZone: 'Asia/Kolkata'` explicitly.** The default is the *viewer's* timezone, and for a market-hours product that default is always wrong. This applies to the chart axis, the blotter, the order book, the journal, and every notification timestamp.

### 13.3.3 The crosshair range formatter

A subtler correctness fix, and one that most charting UIs get wrong:

```ts
/** Candle duration in minutes. When given (intraday only), the crosshair
 *  label shows the bar's full span — "22 Jul 15:15–15:30" — instead of
 *  just its open time. Candles are open-stamped by convention, so the
 *  final bar of an NSE session reads 15:15 even though it runs to the
 *  15:30 close; showing the range removes that ambiguity. */
intervalMinutes?: number;
```

```
   WITHOUT interval          WITH interval
   "22 Jul 15:15"            "22 Jul 15:15–15:30"
        ▲                          ▲
   Is this a bar that        Unambiguous: this is the
   started at 15:15, or      closing bar of the session
   the closing bar of
   the session?
```

Candles are open-stamped by convention. On a 15-minute chart the last NSE bar reads 15:15 — which looks like there is a missing bar at 15:30. Showing the span removes the question entirely.

---

## 13.4 Live price without losing the user's view 🟢

The single most important performance-and-UX decision in the chart.

### 13.4.1 The problem

A naive live chart re-fetches candles on every tick and calls `setData()`. That:

- resets the visible range (`fitContent`), **wiping the user's zoom and pan**
- re-allocates the entire series
- hammers the `/candles` endpoint several times per second
- makes the chart unusable during live trading, which is when it matters

### 13.4.2 The fix — patch the forming bar

```ts
/** Live last-traded price. When provided, the most recent (forming) candle's
 *  close/high/low track this in real time via `series.update()` — so the
 *  chart stays in sync with the live feed without a full re-fetch and,
 *  crucially, without resetting the user's zoom/pan (setData + fitContent
 *  would). Omit for a purely historical chart. */
liveLast?: number;
```

```
   ┌───── HISTORICAL BARS (immutable, loaded once) ─────┬─ FORMING BAR ─┐
   │  ▌  ▐  ▌  ▐  ▌  ▐  ▌  ▐  ▌  ▐  ▌  ▐  ▌  ▐  ▌  ▐   │       ▌       │
   │                                                    │       ▲       │
   │  setData() ONCE on symbol/interval change          │  series       │
   │                                                    │  .update()    │
   │                                                    │  per tick     │
   └────────────────────────────────────────────────────┴───────────────┘

   close = liveLast
   high  = max(high, liveLast)
   low   = min(low,  liveLast)
```

`series.update()` mutates one bar. The visible range is untouched. Zoom, pan, and any drawn overlay survive. Cost per tick is a single point update rather than a full series replacement.

---

## 13.5 The `anchorPrice` ref pattern 🟢

**Code:** `useCandles.ts`

The best React-specific lesson in the frontend codebase, and it is written down in the file:

```ts
// anchorPrice moves on every live tick. It must NOT be an effect dependency —
// otherwise the series reloads (and the chart refits, wiping the user's zoom)
// several times a second, and the /candles route gets hammered. Read it via a
// ref so the simulated fallback still scales to the latest LTP at fetch time,
// while the reload only fires on a genuine symbol/interval/window change.
const anchorRef = useRef(anchorPrice);
anchorRef.current = anchorPrice;

useEffect(() => { /* … uses anchorRef.current … */ }, [symbol, interval, days]);
```

### The general rule

> **A value that changes at tick frequency but is only *read* inside an effect belongs in a ref, not in the dependency array.**

```
   ❌  useEffect(load, [symbol, interval, days, anchorPrice])
       → reload 4× per second, chart refits 4× per second,
         /candles hit 4× per second, zoom destroyed continuously

   ✅  const anchorRef = useRef(anchorPrice); anchorRef.current = anchorPrice;
       useEffect(load, [symbol, interval, days])
       → reload only on a genuine change; the load still reads
         the latest value at fetch time
```

This pattern will recur everywhere in the terminal: live price in an order ticket, live P&L in a blotter, live quote in a depth panel. Chapter 15 §15.9 generalises it.

---

## 13.6 The data path 🟡

```
   useCandles(symbol, interval, days, anchorPrice)
        │
        ▼
   fetchDhanCandles()  ──►  bridge /candles  ──►  Dhan Historical Data API
        │                        │
        │ real candles?          │ empty / error / unsupported symbol
        ▼                        ▼
   status: 'live'          mockMarketDataProvider (OU-based)
                           rescaled to end on anchorPrice
                                │
                                ▼
                           status: 'preview'
```

### 13.6.1 `status` is surfaced to the user

```ts
export type CandlesStatus = 'loading' | 'live' | 'preview';
```

**`'preview'` is rendered in the UI as a visible badge.** A user must never be unable to tell whether they are looking at real history or a simulation. This is the same honesty principle as `Quote.source` (Chapter 12 §12.6.3) and Sentinel's `sampleTooSmall` (Chapter 6 §6.2, G7): when the system is unsure or synthetic, it says so.

### 13.6.2 Why the fallback rescales to `anchorPrice`

The simulated series is rescaled to end on the real live LTP. Without that, the chart would show a simulated history ending at, say, 24,600 while the ticker beside it reads 24,812 — an obvious visual contradiction that makes the whole screen look broken.

### 13.6.3 Cancellation

```ts
let cancelled = false;
// …
if (cancelled) return;
return () => { cancelled = true; };
```

Standard, and necessary: a user flipping through timeframes fires several overlapping loads, and without the guard a slow earlier response overwrites a fast later one. The chart would show 15-minute data while the toolbar reads 1-minute.

---

## 13.7 Indicators 🟢

**Code:** `apps/web/src/lib/technicals.ts`

```ts
/**
 * Technical-analysis math — pure functions over OHLC candle data. Standard,
 * industry-common formulas (RSI/MACD/pivots/etc. are not any one platform's
 * IP); this is our own implementation, not lifted from a reference UI.
 */
```

That second sentence is a deliberate ⚖️ IP note, and a correct one: the *formulas* are public domain; a particular vendor's *implementation* is not.

### 13.7.1 Implemented

| Function | Returns |
|---|---|
| `sma(closes, period)` | simple moving average |
| `ema(closes, period)` | exponential moving average |
| `rsi(closes, period=14)` | relative strength index |
| `macd(closes)` | `{ macd, signal, histogram }` |
| `vwap(candles)` | volume-weighted average price |
| `classicPivots(h, l, c)` | `{ r3, r2, r1, pivot, s1, s2, s3 }` |
| `cpr(dayCandle)` | central pivot range `{ pivot, bc, tc }` |
| `atr(candles, period)` | average true range |
| `bollinger(closes, period, k)` | `{ upper, middle, lower }` |

### 13.7.2 Client-side computation is the right default

```
   NETWORK ROUND TRIP        CLIENT COMPUTATION
   50–200 ms                 ~50 μs for an EMA over 500 candles

   ⇒ 1000–4000× faster, and it works offline, and it re-renders
     instantly when the user changes the period
```

The candles are already in the browser. Sending them back to a server to compute an average of them is pure latency.

### 13.7.3 The rule for where an indicator lives

| Compute on the | When | Examples |
|---|---|---|
| **Client** | The inputs are already in the browser, and the output is only displayed | EMA, RSI, MACD, VWAP, pivots, Bollinger |
| **Server** | Needs data the client does not have, **or** the result feeds a signal that must be reproducible for the ⚖️ audit trail | market breadth, VIX-derived, OI trend, anything Sentinel cites as evidence |

### 13.7.4 ⚠️ The drift risk — TD-4

RSI exists in two places: `apps/web/src/lib/technicals.ts` and `services/sentinel/src/intelligence/indicators.ts`.

```
   The failure mode:
     the chart's RSI reads 70.1
     Sentinel's evidence line says "RSI(14) is 69.8, above 70"

   A user checks. The numbers disagree. Trust is gone, and the
   observation's entire credibility rests on numbers being checkable.
```

Different smoothing conventions (Wilder's vs. simple EMA) produce exactly this. 🔵 **The fix is `packages/indicators`**, consumed by both. Until then:

> ⚠️ **If you change an indicator, change both.** Grep the function name in `services/sentinel/src/intelligence/indicators.ts` before committing a change to `apps/web/src/lib/technicals.ts`, and vice versa.

---

## 13.8 Chart panel integration 🟢

**Code:** `components/terminal/panels/ChartPanel.tsx`

### 13.8.1 Lazy loading

```ts
const ChartPanel = dynamic(() => import('../terminal/panels/ChartPanel'), {
  ssr: false,
  loading: () => <Panel title="Chart" loading className="min-h-[220px]" />,
});
```

Registered in `PANEL_REGISTRY`, not at the call site. Three consequences:

- `lightweight-charts` (~45 KB) is not in the initial bundle
- `ssr: false` is required — the library touches `window` and `getComputedStyle` at construction
- The `loading` component has a `min-h` so the dock does not jump when the chart resolves

### 13.8.2 Theme integration

```ts
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
```

Chart colours are read from the same CSS custom properties as the rest of the design system (Chapter 24). A theme change updates the chart because it updates the tokens — no chart-specific palette to keep in sync.

### 13.8.3 Cross-panel binding

The chart's symbol comes from `workspaceStore.activeSymbol`. Clicking a watchlist row updates the store; the chart, option chain, depth, and news panels all follow. **This is what makes the dock feel like one application** rather than a grid of independent widgets, and it costs one shared store field.

---

## 13.9 Drawing tools 🔵

**Status: specified, no code.** The largest single gap relative to a professional terminal.

### 13.9.1 The tool rail

From the mockups (`DESIGN-SYSTEM.md` §4), on the chart's left edge:

```
   ┌───┐
   │ ↖ │  cursor / select
   │ ╱ │  trendline
   │ ─ │  horizontal line
   │ ▭ │  rectangle
   │ ⌗ │  fibonacci retracement
   │ T │  text annotation
   │ ⟷ │  measure / ruler
   │ ⌫ │  eraser
   └───┘
```

### 13.9.2 Architecture

`lightweight-charts` has no drawing primitives, so this is a **canvas overlay** positioned over the chart, sharing its coordinate transform:

```
   ┌─────────────────────────────────────────┐
   │  <div class="chart-container">          │
   │    ┌─────────────────────────────────┐  │
   │    │  lightweight-charts canvas      │  │  z-0
   │    └─────────────────────────────────┘  │
   │    ┌─────────────────────────────────┐  │
   │    │  drawing overlay canvas          │  │  z-10, pointer-events
   │    │  ← redrawn on visibleRangeChange │  │  only when a tool is active
   │    └─────────────────────────────────┘  │
   └─────────────────────────────────────────┘

   Drawings are stored in PRICE/TIME space, never pixel space:
     { type: 'trendline', p1: { time, price }, p2: { time, price }, style }

   On every visible-range change:
     pixel = chart.timeScale().timeToCoordinate(time)
           , series.priceToCoordinate(price)
```

**Storing in price/time space is the whole design.** Pixel-space drawings break on zoom, pan, resize, timeframe change, and window resize — which is every interaction a chart has.

### 13.9.3 Persistence

```prisma
model ChartDrawing {          // 🔵 SPECIFIED
  userId       String
  instrumentId String
  timeframe    String?        // null = visible on all timeframes
  type         String         // trendline | hline | rect | fib | text | ruler
  points       Json           // [{ time, price }, …]
  style        Json           // colour, width, dash, label
  createdAt    DateTime
  updatedAt    DateTime
  @@index([userId, instrumentId])
}
```

`timeframe` nullable is a real product decision: a horizontal support line drawn on the daily chart should usually be visible on the 15-minute chart; a trendline drawn on a 1-minute chart usually should not appear on the daily. Making it per-drawing lets the user choose.

---

## 13.10 Replay 🔵

**Status: specified, no code.** Genuinely high-value for a learning platform, and one of the few features where our positioning is stronger than a broker's.

### 13.10.1 Why it matters here specifically

Replay lets a user practise on **historical** data at accelerated speed. A trader can experience two hundred setups in an afternoon instead of two hundred sessions.

It composes with the paper OMS in a way nothing else does: **replay + paper orders = a full practice environment.** That combination is the strongest expression of "learn before you risk real money" the product can offer.

### 13.10.2 Architecture

```
   ┌──────────────────────────────────────────────────────┐
   │  Replay session state                                │
   │  { instrumentId, timeframe, from, cursor, speed }    │
   └────────────────────┬─────────────────────────────────┘
                        │
        ┌───────────────▼────────────────┐
        │  candles[0 .. cursor]          │  ← chart sees only this slice
        └───────────────┬────────────────┘
                        │  tick(): cursor++
                        │  speed: 1× 2× 5× 10× 60×
                        ▼
        ┌────────────────────────────────┐
        │  synthetic "live" price feed    │
        │  = candles[cursor].close        │
        └───────────────┬────────────────┘
                        │
        ┌───────────────▼─────────────────────────────────┐
        │  ⚠️  paper OMS in REPLAY MODE                    │
        │  · fills against the replay price, not live      │
        │  · orders tagged replaySessionId                 │
        │  · a SEPARATE replay wallet                      │
        │  · NEVER mixed with real paper P&L               │
        └──────────────────────────────────────────────────┘
```

### 13.10.3 The hard constraints

| Constraint | Why |
|---|---|
| Replay orders must **never** mix with paper-trading P&L | A user's paper track record is meaningless if it contains replayed trades with hindsight-adjacent entries |
| Replay requires the **`Candle`** table | Blocked on Migration 2 |
| The chart must not "leak" future bars | Trivially easy to get wrong via zoom-out. The data slice must be enforced at the source, not in the view. |
| Sentinel observations during replay must be **labelled** | ⚖️ An observation on replayed data is not an observation about the live market |

That third one deserves emphasis: if the chart holds the full candle array and merely *displays* a slice, a user can scroll forward and see the future. The slice must be applied before the data reaches the chart component.

---

## 13.11 Layouts 🟡

Multi-chart today is achieved through **the dock**, not a chart-native grid: open several chart panels into different zones (Chapter 4 §4.18).

| Approach | Status | Trade-off |
|---|---|---|
| Dock-based multi-chart | 🟢 | Reuses the whole workspace system; layouts persist for free |
| Chart-native 2×2 / 1+3 grids | 🔵 | Denser, but a second layout system to maintain |
| Synced crosshair across charts | 🔵 | Needs a shared crosshair bus |
| Synced symbol across charts | 🟢 | Already works — `activeSymbol` |

**Reusing the dock was the right call.** A chart-native grid would duplicate splitting, resizing, persistence, and keyboard navigation — all of which the dock already does, and all of which would then need to stay in sync between two implementations.

---

## 13.12 Performance

### 13.12.1 Budget

| Operation | Target | Technique |
|---|---|---|
| Initial render (500 candles) | ≤100 ms | `setData` once; canvas |
| Live tick update | ≤16 ms (one frame) | `series.update()`, one bar |
| Timeframe switch | ≤300 ms | fetch + `setData` + `fitContent` |
| Symbol switch | ≤300 ms | as above |
| Zoom / pan | 60 fps | library-native, GPU-composited canvas |
| Indicator toggle | ≤50 ms | pure client computation, no fetch |
| Panel mount (cold) | ≤400 ms | lazy chunk + skeleton |

### 13.12.2 What keeps it fast

1. **`series.update()` instead of `setData()`** on ticks — the single biggest win (§13.4)
2. **`anchorPrice` in a ref** — prevents 4 reloads/second (§13.5)
3. **Indicators computed client-side** — no network on a toggle
4. **Lazy-loaded chunk** — the chart is not in the initial bundle
5. **Canvas, not DOM** — 500 candles are 500 draw calls, not 500 elements

### 13.12.3 Where it will break first 🔵

| Scenario | Symptom | Fix |
|---|---|---|
| 6+ chart panels open | each holds its own candle array and subscription | shared candle cache keyed `(symbol, interval)` |
| 5,000+ candles (5-year daily) | initial `setData` slows | downsample beyond the visible range |
| Many indicators + high tick rate | recompute per tick | memoise on `candles.length`, not on candle identity |
| Drawing overlay 🔵 | redraw on every range change | throttle to `requestAnimationFrame` |

---

## 13.13 Accessibility 🟡

A chart is the hardest surface in the product to make accessible, and it is not solved.

| Requirement | Status |
|---|---|
| `aria-label` on the chart container | 🟢 (`TradeChartProps['aria-label']`) |
| Keyboard-navigable crosshair | 🔵 |
| Screen-reader summary of the visible series | 🔵 |
| Data table alternative | 🔵 |
| Colour-blind-safe candle colours | 🔵 |
| Respect `prefers-reduced-motion` | 🔵 |

**The specified approach:** a screen-reader-only summary that updates with the visible range —

> *"NIFTY 50, 15-minute candles. 32 bars from 22 July 09:15 to 22 July 15:30. Open 24,750. High 24,890. Low 24,720. Close 24,812. Up 0.52%."*

That is more useful to a screen-reader user than any attempt to narrate individual candles, and it is achievable. The colour-blind item is separately important because **green/red are reserved for market direction** (NFR-U4) — meaning direction is currently encoded in colour alone, which fails WCAG 1.4.1. A shape or arrow affordance is needed alongside.

---

## 13.14 What is not built 🔵

| Gap | Blocked on | Priority |
|---|---|---|
| Drawing tools | — | P1 — largest gap vs. a professional terminal |
| Replay | `Candle` (Migration 2) | P1 — highest learning value |
| Custom user indicators | a safe expression evaluator | P2 |
| Chart-native layouts | — | P3 — dock covers it |
| Synced crosshair | — | P2 |
| TradingView embed | OD-4 (licensing) | P2 — Phase 9 |
| Volume profile overlay | tick-level volume-at-price data | P2 |
| Chart-attached order tickets | — | P1 — drag a line to place an SL |
| Position/order overlays on price axis | — | P1 |

### 13.14.1 The two highest-value additions

**1. Order and position overlays.** Showing the user's entry price, stop, and target as lines on the chart, and letting them drag those lines to modify the order. This is the interaction that makes a chart a trading surface rather than a display, and it is well within reach: the price-to-coordinate transform already exists for the drawing overlay.

**2. Replay.** For a platform whose thesis is "learn before you risk," replay is the single feature most aligned with the mission, and it is currently blocked on one migration.

---

## 13.15 Testing 🔴

Charts are hard to test, so target the parts that are not:

### Tier 1 — indicator maths (pure functions)

```ts
it('computes RSI(14) matching a known reference series', …);
it('returns null when the series is shorter than the period', …);
it('computes MACD histogram as macd − signal', …);
it('computes classic pivots from prior H/L/C', …);
it('computes VWAP weighted by volume, not by count', …);
it('agrees with the Sentinel implementation', …);   // ⭐ the TD-4 guard
```

That last test is the cheapest possible mitigation for the drift risk in §13.7.4 and should exist before `packages/indicators` does.

### Tier 2 — formatters ⭐

```ts
it('formats the axis in IST regardless of the process timezone', () => {
  process.env.TZ = 'Europe/London';
  expect(istTickMarkFormatter(t(0915_IST), TickMarkType.Time)).toBe('09:15');
});
it('shows the bar span in the crosshair when intervalMinutes is given', …);
it('shows only the day when intervalMinutes is absent', …);
```

Running these under a non-IST `TZ` is the point. A test that only passes on an IST machine tests nothing.

### Tier 3 — the hook

```ts
it('does NOT reload when only anchorPrice changes',   …);  // ⭐ §13.5
it('reloads when symbol changes',                     …);
it('reloads when interval changes',                   …);
it('reports status=preview when the bridge returns empty', …);
it('ignores a stale response after cancellation',     …);
```

---

*Next: [Chapter 14 — Monorepo](14-monorepo.md)*
