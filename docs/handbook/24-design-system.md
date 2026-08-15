# Chapter 24 — Design System

**Status: 🟢 for tokens, themes, the Tailwind preset, motion, and eleven primitives (`packages/ui`, 16 files). 🟡 for adoption — some app code still styles ad hoc.**

---

## 24.1 The source of truth

> *"Source: 14 screenshots from the Emergent AI mockups. These are treated as **the design system**, not inspiration: `packages/ui` should implement exactly what's described here, not a reinterpretation of it."*

And, from the tokens file itself:

```css
/* TradeW design tokens — extracted VERBATIM from the canonical terminal
 * (apps/terminal/index.html), which docs/design-reference/DESIGN-SYSTEM.md
 * designates as the design system, not inspiration. Values here must match
 * that file byte-for-byte; do not "improve" colors here — change the canonical
 * reference first, then mirror it. */
```

> ⚠️ **`apps/terminal` is not an application** and has since been **moved to `archive/apps-terminal-legacy-prototype/`** (archived, not deleted — Rule 1). The `tokens.css` docstring quoted above still names the old `apps/terminal/index.html` path; read it as `archive/apps-terminal-legacy-prototype/index.html`. The tokens in `packages/ui/src/styles/tokens.css` are now the operational source of truth; the archived HTML remains the historical reference behind their values.

**The rule: change the canonical reference first, then mirror it into tokens.** A colour "improved" directly in `tokens.css` silently forks the design system from its own source of truth.

---

## 24.2 The token architecture

```
   packages/ui/src/styles/tokens.css     ← CSS custom properties, 3 themes
              │
              ├──► tailwind-preset.ts    ← maps vars to Tailwind theme keys
              │        │
              │        └──► bg-card · text-muted · border-border2 · text-up
              │
              └──► motion/variants.ts    ← Framer Motion, mirrors the CSS ms values
```

**Why CSS custom properties rather than a JS theme object:**

| | CSS vars | JS theme object |
|---|---|---|
| Theme switch cost | **zero JS** — one attribute on `<html>` | re-render the tree |
| Works in plain CSS | ✅ | ❌ |
| Readable from canvas code | ✅ `getComputedStyle` | needs prop drilling |
| SSR flash | preventable with an inline script | harder |
| Tailwind integration | via the preset | via config regeneration |

The chart reads tokens directly:

```ts
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
```

A theme change updates the chart because it updates the tokens — no chart-specific palette to keep in sync.

---

## 24.3 Colour

### 24.3.1 The token set

Every theme defines the same tokens. **Nothing that consumes a token needs to know which theme is active.**

| Token | Light | Dark | High-contrast | Use |
|---|---|---|---|---|
| `--bg` | `#f5f7fb` | `#0d1524` | `#000000` | app background |
| `--card` | `#ffffff` | `#131e33` | `#0a0a0a` | panels, cards |
| `--border` | `#e6eaf2` | `#1e2c47` | `#ffffff` | 1px borders |
| `--border2` | `#d7deea` | `#2a3a5c` | `#ffffff` | emphasised borders |
| `--text` | `#1c2536` | `#e2e8f0` | `#ffffff` | primary text |
| `--muted` | `#6b7a99` | `#8ea0c4` | `#d6d6d6` | labels, metadata |
| `--faint` | `#95a3bd` | `#64769c` | `#aaaaaa` | timestamps, hints |
| `--teal` | `#0d9488` | `#14b8a6` | `#00e5cc` | **brand accent** |
| `--green` | `#089981` | `#26a69a` | `#00e676` | ⚠️ **market up only** |
| `--red` | `#e4573d` | `#ef5350` | `#ff5252` | ⚠️ **market down only** |
| `--amber` | `#e8930c` | `#f0a53c` | `#ffca28` | warnings, traps, caution |

Each colour has a matching `-bg` tint (`--teal-bg`, `--green-bg`, `--red-bg`, `--amber-bg`) for translucent-looking surfaces.

### 24.3.2 ⚠️ NFR-U4 — green and red are reserved

> **Green and red are reserved strictly for market-data direction and sentiment. Never decorative.**

Enforced in the Tailwind preset by naming them for their *meaning*, not their colour:

```ts
// green/red are reserved strictly for market-data direction & sentiment
// (DESIGN-SYSTEM.md §1) — never decorative.
up:   { DEFAULT: 'var(--green)', bg: 'var(--green-bg)' },
down: { DEFAULT: 'var(--red)',   bg: 'var(--red-bg)'   },
```

**There is no `bg-green` class.** There is `bg-up`. An engineer reaching for green for a success toast finds a class named `up`, which reads wrong, which is the point — the naming makes the misuse visible at the call site.

Use `--teal` for brand, positive-neutral emphasis, and active states. Use `--amber` for caution.

### 24.3.3 The three themes

**Dark is the default.** A trading terminal is used in dark rooms for eight hours a day.

**High-contrast is a third explicit theme, not an OS media-query shim:**

```css
/* High-contrast theme — a third explicit theme, not an OS media-query shim:
 * pure black/white with saturated, maximally distinct market-direction colors.
 * Meets WCAG AAA body-text contrast (white-on-black ≈ 21:1). Same token set as
 * light/dark — nothing that consumes tokens needs to know this theme exists. */
```

Note what it does with the v2 additions, which is the mark of a thought-through theme rather than a colour swap:

```css
/* high-contrast: glass degrades to solid (translucency would break AAA
 * contrast), elevation becomes outline-based, glow becomes a saturated
 * outline ring instead of a soft blur */
--card-glass: var(--card);      /* no translucency */
--glass-blur: 0px;
--elev-1: 0 0 0 1px #ffffff;    /* outline, not shadow */
--glow-teal: 0 0 0 2px #00e5cc; /* ring, not blur */
```

A naive high-contrast theme changes the colours and leaves the translucency and soft shadows in place, which destroys the contrast it was created to provide.

### 24.3.4 ⚠️ Opacity modifiers do not work on these tokens

```ts
/* Colors are `var(--token)` (not rgb channels), so Tailwind's `/opacity`
 * modifiers are intentionally not supported on these tokens — the design
 * system is token-driven, not opacity-driven. Use the dedicated `*-bg`
 * (tint) tokens for translucent-looking surfaces. */
```

`bg-teal/20` does not work. Use `bg-teal-bg`. This is deliberate: a tint token can be tuned per theme; an opacity modifier cannot, and `teal at 20%` over a dark background is a different colour from `teal at 20%` over a light one.

### 24.3.5 ⚠️ The accessibility gap

**Direction is currently encoded in colour alone**, which fails WCAG 1.4.1 (Use of Color) and excludes roughly 8% of male users with red-green colour vision deficiency — a population heavily represented among retail traders.

🔵 **The fix is not to abandon NFR-U4 but to add a redundant channel:** an arrow glyph (▲▼) or an explicit sign prefix alongside the colour. Costs almost nothing visually and makes direction readable without colour. The high-contrast theme's maximally-distinct colours help but do not solve it — a user with deuteranopia sees `#00e676` and `#ff5252` as similar regardless of saturation.

---

## 24.4 Typography

### 24.4.1 The scale

Theme-invariant — defined once on `:root` and inherited by every theme:

```css
--fs-2xs: 11px;   --fs-xs:  12px;   --fs-sm:  13px;
--fs-base:14px;   --fs-md:  15px;   --fs-lg:  18px;
--fs-xl:  22px;   --fs-2xl: 28px;   --fs-3xl: 36px;

--lh-tight: 1.15;         --lh-normal: 1.45;
--tracking-tight: -0.01em; --tracking-wide: 0.04em;
```

**14px base, not 16px.** A trading terminal is a density-first interface. The scale starts at 11px because column headers, timestamps, and metadata labels genuinely need to be that small for a dense blotter to fit — and it stops there, because 10px is not readable.

### 24.4.2 Monospace for numbers

> *"Numeric/price data renders in a **monospaced** face (`24,812.35`, `+0.52%`) — deliberate choice for a trading terminal so digits align in columns."*

Non-negotiable in tables. Proportional digits make a column of prices visually ragged, and a trader scanning a column for an outlier is relying on alignment to do it.

### 24.4.3 The eyebrow label

> *"Small-caps, letter-spaced 'eyebrow' labels for section context: `AI MARKET INTELLIGENCE OPERATING SYSTEM`, `OBSERVATION_ONLY · NOT FINANCIAL ADVICE`. Use this pattern specifically for compliance/status microcopy, not general headings."*

`--tracking-wide: 0.04em` exists for this. ⚖️ The compliance microcopy pattern is a **first-class UI element**, not a legal footnote:

> *"Compliance framing is a first-class UI element, not a legal footnote — the 'OBSERVATION_ONLY · NOT FINANCIAL ADVICE' and 'never investment advice' lines appear inline in the actual layout, not in a buried terms page."*

---

## 24.5 Spacing, elevation, and glass

### 24.5.1 Elevation

```css
--elev-1: 0 1px 3px  rgba(16,24,40,.06);    /* resting card */
--elev-2: 0 4px 10px rgba(16,24,40,.08);    /* hover, dropdown */
--elev-3: var(--shadow);                     /* modal, popover */
--elev-4: 0 20px 50px rgba(16,24,40,.20);   /* command palette */
```

Four levels, each with a job. A fifth would be indistinguishable from the fourth.

### 24.5.2 Glass surfaces

```css
--card-glass:   rgba(255,255,255,.72);
--card-glass-2: rgba(255,255,255,.85);
--glass-blur:   14px;
--glass-border: rgba(28,37,54,.08);
```

Explicit per-theme rgba tokens rather than opacity modifiers — for the reason in §24.3.4.

### 24.5.3 Glow

```css
--glow-teal: 0 0 24px rgba(13,148,136,.35);
--glow-up:   0 0 24px rgba(8,153,129,.35);
--glow-down: 0 0 24px rgba(228,87,61,.35);
```

⚠️ Glow follows the same NFR-U4 rule: `--glow-up` and `--glow-down` are for market-direction emphasis only.

### 24.5.4 Icons

```css
--icon-sm: 14px;   --icon-md: 16px;   --icon-lg: 20px;
```

Three sizes. Icons are line-style, currentColor-driven, and defined in `components/shell/icons.tsx` as inline SVG — no icon-font dependency, no runtime fetch, and they inherit text colour so they theme for free.

---

## 24.6 Motion

### 24.6.1 The duration budget

```css
--dur-micro: 150ms;   /* hover, toggle, focus */
--dur-panel: 250ms;   /* panel open/close, dock change */
--dur-route: 300ms;   /* route transition */
--dur-tick:  600ms;   /* the colour flash on a live value change */
--ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
--ease-spring:   cubic-bezier(0.34, 1.56, 0.64, 1);
```

Mirrored in Framer Motion (in seconds, its unit):

```ts
export const motionTokens = {
  duration: { micro: 0.15, panel: 0.25, route: 0.3, tick: 0.6 },
  ease: {
    standard: [0.4, 0, 0.2, 1],
    spring:   [0.34, 1.56, 0.64, 1],   // overshoot, for magnetic/lift interactions
  },
} as const;
```

### 24.6.2 ⭐ The principle

> *"Motion communicates state change — it never gates an action and never decorates."*

A 250 ms panel animation must not delay the panel's content becoming interactive. Animate the container; render the content immediately.

### 24.6.3 ⭐ `--dur-tick` and the discipline behind it

```css
/* --dur-tick: used for the brief color flash on a live value change,
 * NOT for animating the digits themselves (ticks still update in place
 * — speed-to-information over polish). */
```

This is the design system deferring to the product principle. Animating a price rolling from 24,810 to 24,812 looks impressive and makes the number **unreadable for 600 ms** — during which a trader is trying to read it. So the digits snap; only the background flashes.

**Speed-to-information over polish**, encoded in a comment on a CSS variable.

### 24.6.4 Reduced motion 🟢 (partly)

```css
@media (prefers-reduced-motion: reduce) {
  :root { --dur-micro: 0ms; --dur-panel: 0ms; --dur-route: 0ms; --dur-tick: 0ms; }
}
```

**The CSS layer is handled.** Every CSS transition collapses to zero while state changes still occur.

🔵 **The Framer Motion layer is not automatic**, and the variants file says so:

> *"Reduced motion: components should read `useReducedMotion()` from framer-motion and skip/instant these where appropriate; the CSS token layer already zeroes its own durations under prefers-reduced-motion."*

Relying on each component to remember is the wrong shape. 🔵 **The fix is one wrapper at the variants level** that reads `useReducedMotion()` once and returns instant variants — so a component author cannot forget.

### 24.6.5 The variants

```ts
fadeInUp   // card/content enter — fade + 4px rise, mirrors the canonical .fade keyframe
fade       // tooltips, subtle swaps
```

A 4px rise, not 12px. The canonical HTML's own value, preserved.

---

## 24.7 Components

**Eleven primitives in `packages/ui/src/components/`:**

| Component | Role |
|---|---|
| `Surface` | the base themed container |
| `Card` | bordered dark-surface panel |
| `Panel` | card + title header row + **built-in `loading` state** |
| `Button` | primary / secondary / ghost, via a `buttonClasses` recipe |
| `IconButton` | icon-only, requires an `aria-label` |
| `Badge` | small status pill |
| `StatCard` | icon + label + large value + coloured delta |
| `Sparkline` | inline mini trend chart, no axes |
| `AnimatedNumber` | value transition without re-rendering the row |
| `Skeleton` | loading placeholder |
| `EmptyState` | icon + message + optional action |

### 24.7.1 `Panel`'s loading state ⭐

```tsx
loading: () => <Panel title="Chart" loading className="min-h-[220px]" />
```

Because `Panel` owns its own loading state, every lazy-loaded panel gets a consistent skeleton for free — and the `min-h` prevents the dock reflowing when the chunk resolves.

**Skeletons, not spinners**, above ~150 ms latency (`TRADEW-OS.md` §8). A skeleton communicates *what is arriving*; a spinner communicates only *wait*.

### 24.7.2 `AnimatedNumber` ⭐

Transitions a value without re-rendering its containing row. In a blotter where P&L updates continuously, this is the difference between a smooth screen and a flickering one — and it is where `--dur-tick` is consumed.

### 24.7.3 The workspace-specific inventory

From the mockups, built in the apps rather than in `packages/ui` because they are domain-specific:

| Component | Where |
|---|---|
| Data table with coloured numeric columns | option chain, holdings |
| Tab bar, underline-style active tab | portfolio, research |
| Donut chart | sector allocation |
| Horizontal bar-in-row | trending sectors |
| Sentiment / mood pill | news, journal |
| Confidence-scored insight card | AI insights — *"5 min ago · 82% confidence"* |
| Chat message bubble | TradeW AI dock |
| ⚖️ **Disclaimer footer** | TradeW AI dock — **a required component, not optional copy** |
| Chart toolbar | timeframe pills, indicators, presets, layouts |
| Drawing tool rail 🔵 | chart left edge |
| Payoff visualiser 🔵 | options strategy builder |
| Day Classification card | Sentinel |
| Market Context panel | Sentinel |
| Live Safety Feed card + "Why" panel | Sentinel |

### 24.7.4 ⚖️ Two components that are compliance controls

**The disclaimer footer.** `DESIGN-SYSTEM.md` §4 marks it as *"a required component, not optional copy."* It is not a UI decision whether to render it.

**The confidence-scored insight card.**

> *"Every AI-surfaced number cites its own confidence and recency ('82% confidence', '5 min ago') — this isn't optional styling, it's the compliance/trust pattern the whole product leans on. Carry it into every AI-sourced card, not just the Home page."*

An AI-sourced number without a confidence and a recency is a compliance gap wearing a card.

---

## 24.8 Layout and navigation

```
   ┌──────────────────────────────────────────────────────────────┐
   │ TOP BAR  page name · ● live  │ NIFTY ▲0.52 BANKNIFTY ▼0.31 │  │
   │                              │  ⌘K search · Paper/Live · 🔔 · avatar
   ├────┬─────────────────────────────────────────────────────────┤
   │ ▣  │                                                         │
   │ ▤  │   CONTENT AREA — the only thing that changes            │
   │ ▥  │   per workspace                                         │
   │ ▦  │                                                    ╭────┤
   │ ▧🔒│                                                    │ AI │
   │ ── │                                                    │dock│
   │ ⚙  │                                              ✨    ╰────┤
   └────┴─────────────────────────────────────────────────────────┘
     ▲                                                    ▲
   persistent icon rail                        floating AI trigger
```

### 24.8.1 The scope rule

> *"This section governs **every** workspace — Core Platform, TradeW AI, Sentinel and Learning Hub. A scope note briefly excluded Sentinel here on the assumption it was becoming a standalone application; that direction was reversed the same day and the exclusion is withdrawn."*

⛔ Sentinel uses this chrome like every other workspace. Its *content area* differs substantially — market-context intelligence looks nothing like an order ticket — but the sidebar, top bar, tokens, typography, and primitives are the shared ones.

### 24.8.2 The AI dock

- A **docked right-side panel** (~420px), present as an **overlay** on top of pages, not a separate route
- A **floating circular gradient button** (bottom-right, sparkle icon) reopens it from anywhere
- *"The AI is always reachable, never blocking. The dock can be dismissed and reopened; it never appears as a modal that stops other work."*

---

## 24.9 Interaction principles

From `DESIGN-SYSTEM.md` §5 — all four are product rules expressed as interaction rules:

| # | Principle | Consequence |
|---|---|---|
| 1 | **The AI is always reachable, never blocking** | dock, not modal; dismissible; floating reopen |
| 2 | ⚖️ **Every AI number cites confidence and recency** | on every AI-sourced card, not just the dashboard |
| 3 | ⚖️ **Compliance framing is a first-class UI element** | inline in the layout, not a buried terms page |
| 4 | **Sentinel's tone is diagnostic, not directive** | cards ask questions or state observations — *"What pattern do you notice about your exit timing?"* |

Principle 4 governs copy as much as layout. Any new Sentinel copy defaults to that register.

---

## 24.10 Consuming the design system

### 24.10.1 Setup

```ts
// tailwind.config.ts
import preset from '@tradew/ui/tailwind-preset';
export default { presets: [preset], content: [ … ] };
```

```tsx
// app/layout.tsx
import '@tradew/ui/styles.css';
```

```js
// next.config.js — source-only consumption, no build step
const nextConfig = { transpilePackages: ['@tradew/ui'] };
```

### 24.10.2 The no-flash theme script

The theme is applied by a **blocking inline script before first paint**. A `useEffect` would produce a light flash on every load — a one-line defect that makes a product feel cheap, and one users notice without being able to name.

### 24.10.3 The usage rules

```
   ✅ bg-card  text-muted  border-border2  text-teal  text-up  text-down
   ❌ bg-[#131e33]  text-[#8ea0c4]  bg-green-500

   ✅ transition-[opacity] duration-[--dur-micro]
   ❌ duration-150

   ✅ bg-teal-bg
   ❌ bg-teal/20              ← opacity modifiers don't work (§24.3.4)

   ✅ text-up / text-down for market direction
   ❌ text-up for a success toast    ← NFR-U4
```

**Every raw hex in app code is a design-system bug.** It will not follow a theme change, and it will be wrong in high-contrast.

---

## 24.11 Extending the design system

### 24.11.1 Adding a token

```
   □ Does an existing token cover it?              (usually yes)
   □ Is it theme-varying (colour, shadow) or theme-invariant
     (size, duration, tracking)?
   □ Theme-varying  → define in ALL THREE theme blocks
   □ Theme-invariant→ define once on :root
   □ Map it in tailwind-preset.ts
   □ If it is a duration → add it to the reduced-motion block
   □ ⚠️ Does the canonical apps/terminal reference need updating first?
```

The reduced-motion step is the one people forget, and forgetting it means a new animation ignores the user's OS preference.

### 24.11.2 Adding a component

```
   □ Will 2+ apps or 3+ call sites use it?
       no  → keep it local to the app
       yes → packages/ui
   □ Tokens only. No raw hex, no hardcoded durations.
   □ Does it need a loading state? An empty state?
   □ Keyboard reachable? Escape closes any overlay?
   □ aria-label on any icon-only control
   □ Works in light, dark, AND high-contrast — check all three
   □ Respects prefers-reduced-motion
   □ Export from components/index.ts
```

> ⚠️ **Check high-contrast.** It is the theme least likely to be tested and the one where translucency, soft shadows, and low-contrast borders visibly fail.

### 24.11.3 Do not pre-extract

`ARCHITECTURE.md` §6: *"Design-system components extracted from `apps/web` as they stabilize — don't pre-extract UI that's still changing weekly."*

A component in `packages/ui` is harder to iterate on. Extract when it has stopped changing, not when it looks reusable.

---

## 24.12 Design-system debt

| ID | Item | Severity | Fix |
|---|---|---|---|
| **DS-1** | ⚠️ **Direction encoded in colour alone** — WCAG 1.4.1 | **high** | add ▲▼ glyph or sign prefix |
| DS-2 | Framer Motion does not auto-respect reduced motion | medium | one wrapper reading `useReducedMotion()` at the variants level |
| DS-3 | Colour contrast not audited across all three themes | medium | run an automated contrast check per theme |
| DS-4 | Exact font family unconfirmed against the mockups | low | `DESIGN-SYSTEM.md` §6 open item |
| DS-5 | No component documentation or visual catalogue | medium | Storybook, or a `/design` route in the app |
| DS-6 | Some app code still styles ad hoc | medium | audit for raw hex and hardcoded durations |
| DS-7 | `apps/admin` / `apps/mobile` inheritance undecided | low | `DESIGN-SYSTEM.md` §6 open item |
| DS-8 | No visual regression tests | low | Playwright screenshots per theme |

### 24.12.1 DS-1 is the one that matters

Every other item is polish or process. DS-1 makes the product's most important information — is this number up or down — unreadable for a meaningful fraction of the target users, in a domain where misreading direction has a direct financial cost.

It is also nearly free to fix: an arrow glyph beside the number, or a `+`/`−` prefix, in the components that render market direction. The colour rule stays; a second channel is added beside it.

---

## 24.13 The design system summary card

```
   SOURCE        apps/terminal/index.html is canonical.
                 Change it first, then mirror into tokens.css.

   TOKENS        CSS custom properties → Tailwind preset → classes.
                 Three themes, one token set, zero-JS switching.

   COLOUR        teal = brand. amber = caution.
                 ⚠️ green/red = MARKET DIRECTION ONLY (up/down classes).
                 No opacity modifiers — use the *-bg tint tokens.

   TYPE          14px base. Monospace for every number in a column.
                 Letter-spaced eyebrow for ⚖️ compliance microcopy.

   MOTION        micro 150 · panel 250 · route 300 · tick 600.
                 Motion communicates state; it never gates or decorates.
                 Digits snap; only the background flashes.
                 Reduced motion zeroes CSS durations automatically.

   COMPONENTS    11 primitives in packages/ui.
                 Skeletons, not spinners.
                 ⚖️ Disclaimer footer and confidence+recency are
                    REQUIRED components, not optional copy.

   LAYOUT        One shell for every workspace. Sentinel included.
                 AI dock is an overlay, never a modal.
```

---

*Next: [Chapter 25 — Engineering Processes](25-engineering-processes.md)*
