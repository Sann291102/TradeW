# TradeW Design System — extracted from the Emergent AI mockups

Source: 14 screenshots in `TradeW -(Setup & Paper)\TradeW-Setup-main\Planning\Initerface images from EMERGENT AI\` (not moved — referenced in place). These are treated as **the design system**, not inspiration: `packages/ui` should implement exactly what's described here, not a reinterpretation of it.

These mockups show a working frontend preview (with a "wake up servers" banner, implying it's already deployed against a backend) — this is further along than a sketch; treat gaps below as things to confirm with whoever built it, not blanks to fill in with invented alternatives.

---

## 1. Color system

| Token | Value (approx.) | Use |
|---|---|---|
| `bg.base` | near-black, `#0A0E14`–`#0B0F17` | app background |
| `bg.surface` | slightly lighter dark, `#0F1420`–`#121826` | cards, panels |
| `border.subtle` | low-contrast dark gray | 1px card/panel borders |
| `accent.teal` | `#2DD4BF`-ish cyan/teal | primary brand accent, live indicators, active nav item, primary icons |
| `accent.gradient` | blue → purple → cyan | logo mark, primary CTA buttons, the floating AI-assistant trigger |
| `positive` | green | gains, positive sentiment, buy-side context |
| `negative` | red | losses, negative sentiment, sell-side context |
| `warning` | amber/orange | traps, elevated-risk flags, "Anxious"/caution states |
| `text.primary` | white/near-white | headings, primary values |
| `text.secondary` | mid-gray | labels, secondary metadata, timestamps |

Rule observed consistently: **green/red are reserved strictly for market-data direction and sentiment**, never used decoratively — this matches the build plan's own stated principle ("green/red reserved strictly for market data").

## 2. Typography

- Large, bold, tight-tracking display type for hero/landing statements ("Not a chatbot. Not a dashboard. An AI trading desk beside you.") — gradient-filled text for the emphasized line.
- Numeric/price data renders in a **monospaced** face (`24,812.35`, `+0.52%`) — deliberate choice for a trading terminal so digits align in columns; body/UI text uses a standard sans-serif.
- Small-caps, letter-spaced "eyebrow" labels for section context: `AI MARKET INTELLIGENCE OPERATING SYSTEM`, `LIVE AGENT DESK PREVIEW`, `OBSERVATION_ONLY · NOT FINANCIAL ADVICE`. Use this pattern specifically for compliance/status microcopy, not general headings.

## 3. Layout & navigation

- **Persistent left icon-rail sidebar** (collapsed by default to icons, expandable to icon+label): Home, Trading, Options, **Sentinel**, **Research**, Portfolio, Demo Trade, Explorer, with the user's avatar + name + mode ("Paper Trading") pinned at the bottom.
- **Persistent top bar** on every page: current page name + live-status dot, then the index ticker strip (NIFTY 50, BANKNIFTY, SENSEX with inline % change, color-coded), then a right-aligned cluster: search (⌘-style shortcut hint), **Paper/Live toggle**, notification bell (with unread-count red dot), avatar.
- This top bar + sidebar chrome is **shared across every workspace** (Core Platform, Research, Sentinel) — it's what makes the product feel like one app rather than three. Only the content area below/right of it changes per workspace.
- Content areas use a **card grid** (2–3 columns on desktop), each card a rounded, bordered, dark-surface panel with an icon + title header row.
- A **docked right-side panel** (≈420px) is the TradeW AI chat surface — present as an overlay on top of Core Platform pages (Home, Trading), not a separate route. A **floating circular gradient button** (bottom-right, sparkle icon) reopens it from anywhere it's been dismissed.

## 4. Component inventory

| Component | Where seen | Notes |
|---|---|---|
| Stat card | Portfolio, Options | icon + label + large value + colored delta |
| Sparkline row | Watchlist, Portfolio holdings | inline mini trend chart per row, no axes |
| Data table (colored numeric columns) | Option chain, Holdings | monospace numbers, green/red P&L columns, dense rows |
| Tab bar | Portfolio (Holdings/Positions/Performance/Journal), Research (Overview/Fundamentals/.../Risk Factors) | underline-style active tab, horizontal scroll if overflow |
| Donut chart | Sector Allocation | center label shows a summary count ("6 Sectors") |
| Horizontal bar-in-row | Trending Sectors | label + thin bar + % value, bar length encodes magnitude |
| Sentiment/category pill | Live News (positive/negative/neutral), Sentinel traps ("Bear Trap"), Journal moods (Focused/Anxious/Confident/Frustrated) | small rounded pill, color mapped to meaning, not decorative |
| Confidence-scored insight card | Active AI Insights | headline + "X min ago · NN% confidence" |
| Chat message bubble | TradeW AI dock | AI messages left-aligned with a small agent-icon avatar, user messages right-aligned; below each AI message, contextual quick-action chips ("Explain this chart", "Explain my portfolio", "Market pulse") |
| Disclaimer footer | TradeW AI dock, Sentinel eyebrow copy | persistent small-text line ("TradeW AI shares observations only — never investment advice.") — **treat this as a required component, not optional copy** |
| Reflection card | Sentinel | category pill ("Exit Discipline") + observation text + "Reflect with AI ↗" link |
| Agent activity timeline | Sentinel | colored dot + observation text + timestamp, reverse-chronological |
| Session summary stat list | Sentinel | label/value rows (Trades Today, Plan Adherence %, Discipline Δ, Flagged Events) |
| Chart toolbar | Trading, Options | symbol + live price/change, timeframe pill group (1m/5m/15m/1H/4H/1D/1W), Indicators button with count badge, Presets dropdown, layout-variant icons, AI sparkle shortcut, fullscreen |
| Drawing tool rail | Trading (chart left edge) | cursor, trendline, horizontal line, rectangle, fib, text, ruler, eraser |
| Payoff visualizer | Options strategy builder | filled profit(green)/loss(red) region chart with Max Profit / Spot / Max Loss labels |

## 5. Interaction principles to carry into the design system

1. **The AI is always reachable, never blocking.** The dock can be dismissed and reopened via the floating button; it never appears as a modal that stops other work.
2. **Every AI-surfaced number cites its own confidence and recency** ("82% confidence", "5 min ago") — this isn't optional styling, it's the compliance/trust pattern the whole product leans on. Carry it into every AI-sourced card, not just the Home page.
3. **Compliance framing is a first-class UI element, not a legal footnote** — the "OBSERVATION_ONLY · NOT FINANCIAL ADVICE" and "never investment advice" lines appear inline in the actual layout, not in a buried terms page.
4. **Sentinel's tone is diagnostic, not directive** — reflection cards ask questions ("What pattern do you notice about your exit timing?") rather than issue instructions. Any new Sentinel copy should default to this register.

## 6. Open items to confirm before `packages/ui` is built

- Exact hex values and the font family in use (extract from the live deployed app's CSS if the "wake up servers" preview is still reachable, rather than guessing from screenshots).
- Whether `apps/admin` and `apps/mobile` should inherit this exact system or a variant — not shown in any mockup, since none of the 14 screenshots depict an admin or mobile surface.
