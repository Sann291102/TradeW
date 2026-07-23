# Chapter 15 — Frontend Architecture

**Status: 🟢 for the shell, dock, palette, theme, and state layer (~110 files). 🟡 for data — several surfaces still read from `lib/mock/`.**

---

## 15.1 Stack

| Concern | Choice | Version | Why |
|---|---|---|---|
| Framework | Next.js (App Router) | ^14.2.20 | RSC, streaming, file routing, image/font optimisation |
| UI | React | ^18.3.1 | — |
| Language | TypeScript | ^5.7.2 | strict |
| Styling | Tailwind CSS + CSS custom properties | ^3.4.16 | tokens in CSS vars, utilities in Tailwind |
| State | Zustand | ^4.5.5 | ~1 KB, no provider tree, no reducer boilerplate |
| Charts | lightweight-charts | ^4.2.3 | 45 KB, canvas, Apache-2.0 |
| Animation | Framer Motion | ^11.15.0 | declarative, respects `prefers-reduced-motion` |
| Markdown | react-markdown + remark-gfm | ^9 / ^4 | knowledge vault viewer |
| Diagrams | mermaid | ^11.4.1 | knowledge graph rendering |

### 15.1.1 Why Zustand and not Redux / Context

| | Zustand | Redux Toolkit | React Context |
|---|---|---|---|
| Bundle | ~1 KB | ~12 KB | 0 |
| Boilerplate | none | slices, actions, thunks | providers |
| Re-render granularity | **per selector** | per selector | **whole subtree** |
| Persistence | built-in middleware | separate package | manual |
| Outside React | ✅ `store.getState()` | ✅ | ❌ |

The decisive row is **re-render granularity**. In a trading terminal, a quote updates several times per second. Context re-renders every consumer in the subtree; Zustand re-renders only components whose selected slice changed. That difference is the entire performance story of a live terminal (§15.9).

---

## 15.2 Directory structure

```
apps/web/src/
├── app/                        Next.js App Router
│   ├── layout.tsx              root shell: theme script, AppFrame, fonts
│   ├── page.tsx                marketing/landing (bare route)
│   ├── login/ signup/          bare routes (no chrome)
│   ├── dashboard/ trade/ markets/ portfolio/
│   ├── research/ learning/ knowledge/ sentinel/
│   ├── notifications/ settings/ profile/
│
├── components/
│   ├── shell/       (10)  AppFrame · Sidebar · TopBar · Ticker
│   │                      · ThemeMenu · NotificationCenter · FloatingAI
│   │                      · nav-config · icons
│   ├── workspace/   (11)  WorkspaceDock · DockSlot · Splitter
│   │                      · CommandPalette · LayoutMenu · WorkspaceTabs
│   │                      · panel-registry · ShortcutsHelp · Popover
│   ├── terminal/    (18)  the dockable panels
│   ├── dashboard/   (13)  dashboard widgets
│   ├── sentinel/    (9)   Sentinel workspace components
│   ├── markets/ trade/ charts/
│
└── lib/
    ├── store/       zustand: workspaceStore · sessionStore
    │                · tradeBasketStore · useHydrated · useKeyboardShortcuts
    ├── hooks/       useCandles · useLiveQuotes · useDhanLiveFeed
    │                · useInstrumentMeta · useHasOptionChain
    ├── sentinel/    deriveContext · useSentinel · types
    ├── search/      command-palette providers
    ├── mock/        (7 files) — the honest fallback layer
    ├── api.ts oms.ts marketData.ts knowledge.ts dhanLiveFeed.ts
    └── technicals.ts black-scholes.ts format.ts analytics.ts shortcuts.ts
```

---

## 15.3 The shell

### 15.3.1 `AppFrame` — path-aware chrome

The core insight of the M2 terminal conversion: **wrap existing pages with the shell rather than moving them into a shell layout.**

```tsx
// simplified
export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isBareRoute(pathname))       return <>{children}</>;      // /, /login, /signup
  if (isStandaloneRoute(pathname)) return <>{children}</>;      // currently empty
  return (
    <div className="app-frame">
      <Sidebar /><TopBar /><Ticker />
      <main>{children}</main>
      <FloatingAI /><CommandPalette />
    </div>
  );
}
```

Adding a workspace requires no change here. `BARE_ROUTES` is a three-item array; everything else gets chrome.

### 15.3.2 Config-driven navigation

```ts
export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: HomeIcon,      group: 'primary' },
  { href: '/trade',     label: 'Trade',     icon: TradeIcon,     group: 'primary' },
  …
  { href: '/sentinel',  label: 'Sentinel',  icon: SentinelIcon,
    premium: true, group: 'primary' },
  { href: '/settings',  label: 'Settings',  icon: SettingsIcon,  group: 'secondary' },
];
```

> *"Sidebar navigation is DRIVEN BY THIS CONFIG — pages are never hardcoded in the Sidebar component. Adding a workspace = adding a row here."*

The command palette's navigation provider reads the same array, so **a new page becomes searchable for free.**

`premium: true` controls a **lock affordance**, not visibility (Chapter 2 §2.1). The item always renders.

### 15.3.3 `STANDALONE_ROUTES` — a preserved lesson

```ts
/**
 * Routes that render their own dedicated shell instead of the shared chrome.
 * Reverted for `/sentinel` on 2026-07-21 — a first pass removed all chrome
 * there, but that left no way to navigate back out to the rest of the app,
 * a dead end rather than "standalone." Left this mechanism in place, empty,
 * in case a real standalone-shell need comes up again.
 */
export const STANDALONE_ROUTES: string[] = [];
```

An empty array with a comment explaining why it is empty. That is worth more than deleting the mechanism: the next person to propose a chrome-less page finds the reason it failed instead of rediscovering it.

---

## 15.4 State management

### 15.4.1 Three stores, three lifetimes

| Store | Persisted? | Lifetime | Holds |
|---|---|---|---|
| `workspaceStore` | ✅ localStorage | across sessions | panels, layout, tabs, `activeSymbol`, theme |
| `sessionStore` | ❌ **deliberately not** | in-memory only | user, entitlements, auth state |
| `tradeBasketStore` | ❌ | in-memory | pending multi-leg order construction |

### 15.4.2 Why `sessionStore` is unpersisted

Security. The session is re-derived from `/auth/me` on load; the refresh token lives in an httpOnly cookie. **A stolen `localStorage` dump contains no credential and no entitlement state.**

It also removes an entire bug class: a persisted entitlement snapshot goes stale the moment a subscription changes, and a user whose plan lapsed would keep premium access until they cleared their browser storage.

### 15.4.3 `workspaceStore` shape

```ts
export type PanelKind =
  | 'watchlist' | 'chart' | 'blotter' | 'optionChain' | 'orderTicket'
  | 'depth' | 'sentinel' | 'news' | 'portfolio' | 'learning' | 'research';

export type SlotId = 'left' | 'main' | 'auxA' | 'auxB' | 'right';

export interface PanelState {
  id: PanelKind;      // panels are singletons per tab, so id === kind
  kind: PanelKind;
  slot: SlotId;
  order: number;      // position within the slot
  collapsed: boolean;
  pinned: boolean;    // skipped by "close all"; survives layout switches
  visible: boolean;
  detachable: boolean; // multi-monitor readiness flag — no pop-out yet
}
```

**Shape chosen to match the future server table.** Its docstring:

> *"The shape here is intentionally close to that table (open surfaces, active tab, panel/layout state, selected symbol) so migrating to a server-synced session later is a transport change, not a redesign."*

That is Principle 7 done right: pay the (free) design cost now, pay the operational cost when the trigger fires.

### 15.4.4 ⚠️ The hydration gotcha

> **Cost: most of a day. It will happen to you.**

```ts
export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({ … }),
    {
      name: 'tradew-workspace',
      skipHydration: true,          // ← REQUIRED
    },
  ),
);

// in a client component, once:
useEffect(() => { useWorkspaceStore.persist.rehydrate(); }, []);
```

**Why:** the server renders with default state; the client would render with persisted state; React sees two different trees and throws a hydration mismatch.

**Three rules for any persisted store:**

1. `skipHydration: true` + a manual `rehydrate()` in `useEffect`
2. **No `Math.random()` or `Date.now()` in seed data** — they differ between server and client render
3. Gate anything that reads persisted state behind `useHydrated()`

`lib/store/useHydrated.ts` exists for rule 3.

### 15.4.5 ⚠️ The mount-only effect gotcha

> **Cost: half a day. Symptom: "the action succeeded but the UI didn't update."**

```ts
// ❌ does NOT re-run on client-side navigation
useEffect(() => { loadSession(); }, []);

// ✅
const pathname = usePathname();
useEffect(() => { loadSession(); }, [pathname]);
```

`AppFrame` does not remount when the router navigates — Next.js preserves the layout tree. A mount-only effect in a layout component runs exactly once per full page load. Login succeeded, the session updated, the shell showed the logged-out state.

**Diagnostic rule:** if a state change is not reflected in persistent chrome, suspect a mount-only effect on a component that does not remount.

---

## 15.5 Data fetching

### 15.5.1 The layers

```
   apps/web
     ├── lib/api.ts          fetch wrapper: base URL, auth header, error shape
     ├── lib/oms.ts          order/position/portfolio calls
     ├── lib/marketData.ts   quote aggregation
     ├── lib/knowledge.ts    vault + graph
     ├── lib/dhanLiveFeed.ts live-feed bridge (/quotes, /candles)
     └── lib/sentinel/       observe + context derivation
```

No React Query, no SWR, no tRPC. Hooks own their own fetching, `AbortController`/cancellation flags, and status. For a codebase this size that is a defensible trade: fewer dependencies, no cache-invalidation model to reason about, and full control over the refetch semantics that matter (§13.5).

🔵 The trigger for adopting a data-fetching library is duplicated cache logic appearing in three or more hooks.

### 15.5.2 The hook contract

Every data hook returns `{ data, status }`, never a bare value:

```ts
export type CandlesStatus = 'loading' | 'live' | 'preview';
export function useCandles(…): { candles: Candle[] | null; status: CandlesStatus }
```

**`'preview'` is the honesty state** and is rendered as a visible badge. A user must always be able to tell simulated data from real. Same principle as `Quote.source` and `priceStatus` — when the system is unsure or synthetic, it says so.

### 15.5.3 Cancellation is mandatory

```ts
useEffect(() => {
  let cancelled = false;
  (async () => {
    const data = await fetchThing();
    if (cancelled) return;      // ← without this, a slow earlier
    setData(data);              //   response overwrites a fast later one
  })();
  return () => { cancelled = true; };
}, [deps]);
```

A user flipping timeframes fires overlapping loads. Without the guard, the chart shows 15-minute data while the toolbar reads 1-minute.

### 15.5.4 ⭐ The ref pattern for tick-frequency values

Generalising Chapter 13 §13.5 — this is the most important frontend rule in the terminal:

> **A value that changes at tick frequency but is only *read* inside an effect belongs in a ref, not in the dependency array.**

```ts
const liveRef = useRef(livePrice);
liveRef.current = livePrice;          // updates every render, triggers nothing

useEffect(() => {
  // reads liveRef.current — always current
}, [symbol, interval]);               // fires only on a real change
```

Applies to: live price in an order ticket, live P&L in a blotter, live quote in depth, live LTP in the chart's candle fallback.

---

## 15.6 The workspace dock

### 15.6.1 Five zones, not floating windows

```
   ┌────────┬─────────────────────┬────────┐
   │        │        main         │        │
   │  left  ├──────────┬──────────┤ right  │   right stacks vertically,
   │        │   auxA   │   auxB   │(stack) │   ordered by `order`
   └────────┴──────────┴──────────┴────────┘
              ▲ Splitter (draggable, keyboard-resizable)
```

Floating windows were considered and rejected:

| Zones | Floating |
|---|---|
| layout serialises as `PanelState[]` | needs a geometry graph |
| deterministic keyboard navigation | ambiguous focus order |
| responsive collapse is well-defined | undefined below a width |
| no z-index management | z-index management forever |
| less flexible | more flexible, unasked-for |

### 15.6.2 The panel registry

```tsx
export const PANEL_REGISTRY: Record<PanelKind, PanelRegistryEntry> = {
  watchlist:   { title: 'Watchlist',    icon: MarketsIcon,   Component: WatchlistPanel },
  chart:       { title: 'Chart',        icon: TradeIcon,     Component: ChartPanel },   // lazy
  optionChain: { title: 'Option Chain', icon: MarketsIcon,   Component: OptionChainPanel }, // lazy
  …
};
```

> *"Adding a new dockable panel kind means adding one row here plus a `PanelKind` union member — nothing else in `WorkspaceDock`/`DockSlot` needs to change."*

The registry is also read by the command palette and the closed-panels menu, so a new panel becomes searchable and restorable for free.

### 15.6.3 Lazy loading at the registry

```tsx
const ChartPanel = dynamic(() => import('../terminal/panels/ChartPanel'), {
  ssr: false,
  loading: () => <Panel title="Chart" loading className="min-h-[220px]" />,
});
```

Three deliberate details: lazy at the *registry* rather than at each call site; `ssr: false` because the chart touches `window` at construction; `min-h` on the skeleton so the dock does not reflow when it resolves.

### 15.6.4 Cross-panel binding

`workspaceStore.activeSymbol` is the shared field. Clicking a watchlist row updates it; chart, option chain, depth, and news all follow. One field is what turns a grid of widgets into an application.

---

## 15.7 Workspace continuity

**Today 🟢 client-local:** `workspaceStore` → `localStorage`. Layout, panels, tabs, and active symbol survive a reload.

**Genesis Phase 10 🔵 server-side:**

```prisma
model WorkspaceSession {          // 🔵 SPECIFIED
  userId       String
  deviceId     String?
  openSurfaces Json
  activeTab    String?
  panelState   Json               // ← the same PanelState[] shape
  activeSymbol String?
  updatedAt    DateTime
  @@unique([userId, deviceId])
}
```

Because the client shape already matches, this is a transport change: write-through on mutation, read on login, last-write-wins per device.

The product promise it completes: **you resume, you do not restart** — on any device.

---

## 15.8 The command palette

Not a shortcut menu. A **unified global search** with pluggable providers.

```ts
export interface SearchProvider {
  id: string;
  label: string;                                          // section heading
  search(query: string, ctx: SearchContext): SearchResult[];
}
```

| Provider | Searches | Source |
|---|---|---|
| navigation | every workspace page | `NAV_ITEMS` |
| symbols | indices + F&O universe | `lib/mock/{indices,foUniverse}` |
| panels | dockable panels | `PANEL_REGISTRY` |
| learning | categories and paths | `lib/mock/learning` |
| theme | light / dark / high-contrast | `ThemeMenu` |
| actions | layout, notifications, shortcuts | static |

Adding a provider is one module. Because navigation and panels read from their own configs, **new pages and panels become searchable without touching the palette.**

---

## 15.9 Performance

### 15.9.1 The budget

| Interaction | Target | Technique |
|---|---|---|
| Keystroke → visual ack | ≈20 ms | local state; no network on the critical path |
| Micro-interaction | ≤150 ms | CSS transition, `--dur-micro` |
| Panel open | 200–300 ms | lazy chunk + skeleton, `--dur-panel` |
| Route change | ≤350 ms | prefetch + streaming, `--dur-route` |
| Quote tick → cell | ≤16 ms | selector-scoped subscription |
| Chart tick | ≤16 ms | `series.update()`, one bar |

### 15.9.2 The ~20 ms target, defined precisely

Taken literally, 20 ms is impossible for anything crossing a network. What it means:

> **20 ms from user input to first visual acknowledgement**, achieved by rendering from local/optimistic state immediately and reconciling with the network asynchronously.

```
   t=0     user clicks BUY
   t=2ms   button enters pressed state          ← local
   t=8ms   optimistic order row appears in the blotter
   t=15ms  "Placing…" state renders
   ─────────────────────────────────────────────────────
   t=180ms server confirms; the row reconciles to PENDING
```

The user perceives a 15 ms response. The network took 180 ms. Both are true, and only the first is what "responsiveness" means.

### 15.9.3 The cell-granularity rule

> Real-time surfaces update at **row/cell granularity** — never full-page re-renders.

An option chain is ~40 strikes × ~14 columns ≈ 560 numeric cells, several changing per tick. Re-rendering that tree at 4 Hz is the difference between a terminal and a toy.

```tsx
// ❌ every cell re-renders when ANY quote changes
const quotes = useQuoteStore(s => s.quotes);
return <td>{quotes[symbol]?.ltp}</td>;

// ✅ only this cell re-renders, and only when ITS ltp changes
const ltp = useQuoteStore(s => s.quotes[symbol]?.ltp);
return <td>{ltp}</td>;
```

**Rule: select the narrowest slice you need.** Selecting an object re-renders on any key change; selecting a primitive re-renders only when that primitive changes.

### 15.9.4 Other techniques in use

| Technique | Where |
|---|---|
| Lazy panels (`next/dynamic`) | Chart, Option Chain |
| Ref-not-dependency for tick values | `useCandles`, live-price consumers |
| Canvas over DOM for dense data | charts, sparklines |
| CSS custom properties for theming | no JS on theme change |
| No-flash inline theme script | before first paint |
| `AnimatedNumber` | value transitions without re-rendering the row |

### 15.9.5 🔵 Not yet done

| Gap | Impact |
|---|---|
| No virtualisation on long lists | 500-row option chain renders all rows |
| No bundle budget in CI | regressions ship silently |
| No RUM | every number in §15.9.1 is a target, not a measurement |
| No `React.memo` discipline | some panels re-render more than needed |
| No shared candle cache across chart panels | N panels = N arrays + N subscriptions |

---

## 15.10 Error boundaries 🟡

### 15.10.1 The specified hierarchy

```
   RootErrorBoundary          app/error.tsx — full-page fallback, reload CTA
     └── ShellErrorBoundary   chrome survives; content area shows the error
           └── PanelErrorBoundary  ⭐ ONE panel fails, the rest keep working
                 └── WidgetErrorBoundary  one dashboard widget fails
```

**`PanelErrorBoundary` is the important one.** A dock with eight panels must not lose all eight because the option chain threw. Principle 8 (Reliability) expressed in the component tree.

```tsx
<DockSlot>
  <PanelErrorBoundary
    panelKind={kind}
    fallback={<PanelError title={title} onRetry={remount} />}
  >
    <Component {...props} />
  </PanelErrorBoundary>
</DockSlot>
```

### 15.10.2 Error UI rules

| Rule | Reason |
|---|---|
| Never a raw stack trace | it is not actionable and it looks broken |
| Always offer a retry | most panel errors are transient |
| Preserve surrounding chrome | the user must be able to navigate away |
| Log with panel kind + user id | otherwise the report is unactionable |
| Never block the order path | ARCH-3 in the UI layer |

---

## 15.11 Accessibility 🟡

| Requirement | Status |
|---|---|
| Semantic HTML | 🟢 |
| Keyboard navigation for shell + palette | 🟢 |
| Focus-visible ring (`--focus-ring` token) | 🟢 |
| Documented shortcuts (⌘/) | 🟢 |
| Escape closes every overlay | 🟢 |
| `aria-label` on icon-only controls | 🟡 |
| Colour contrast AA | 🟡 |
| Screen-reader chart alternative | 🔵 |
| `prefers-reduced-motion` | 🔵 |
| Keyboard panel resize | 🔵 |
| Live-region announcements for price changes | 🔵 |

### 15.11.1 ⚠️ The colour-only encoding problem

**NFR-U4 reserves green/red strictly for market direction.** That is a good product rule and a WCAG 1.4.1 failure: direction is currently encoded in colour alone, which excludes roughly 8% of male users with red-green colour vision deficiency — a population heavily represented among retail traders.

🔵 **The fix** is not to abandon the colour rule but to add a redundant channel: an arrow glyph (▲▼) or a sign prefix alongside the colour. Costs nothing visually, and makes the direction readable without colour.

### 15.11.2 The reduced-motion obligation

Framer Motion is used throughout. `prefers-reduced-motion: reduce` must disable transform/opacity animation globally, not per-component — one wrapper at the motion-variants level.

---

## 15.12 The mock data layer

`lib/mock/` — 7 files: `candles`, `foUniverse`, `indices`, `learning`, `market`, `optionCandles`, `optionChain`, `research`.

### 15.12.1 Why it exists, and why that is fine

Layout, virtualisation, update semantics, and interaction were built first so that swapping the data source is a one-line change per consumer. That is correct sequencing.

### 15.12.2 Why it is also a trap

> ⚠️ **Do not assume a number on screen is live.** Check the component's imports. Roughly half the dashboard widgets read from `lib/mock/` today.

### 15.12.3 The rule for retiring a mock

```
□ The real endpoint exists and is tested
□ The hook returns { data, status } with an honest status
□ The 'preview'/mock state is VISIBLE in the UI, not silent
□ The mock file stays (archive-never-delete) as the fallback
```

`lib/mock/foUniverse.ts` is a special case: it is the **allowlist** determining which symbols may have an option chain (`useHasOptionChain`). It is configuration, not fallback data, and it should not be removed when the option chain goes live.

---

## 15.13 Adding a page

```
1. app/<route>/page.tsx
   'use client' only if it needs interactivity

2. Add a row to NAV_ITEMS in components/shell/nav-config.tsx
   → sidebar entry + command-palette searchability, free

3. If it needs dockable panels, add PanelKind members + PANEL_REGISTRY rows

4. If it is premium: premium: true on the nav row (a lock affordance,
   NOT hiding) + a CapabilityGuard on the API endpoints

5. Data: a hook in lib/hooks returning { data, status }

6. Wrap panels in PanelErrorBoundary

7. Verify: no hydration warning, no theme flash, works at 1366×768,
   Escape closes any overlay, every action reachable by keyboard
```

---

## 15.14 Frontend debt

| ID | Debt | Impact |
|---|---|---|
| FE-1 | ~50% of dashboard widgets on mock data | numbers on screen may not be live |
| FE-2 | No virtualisation | long lists render every row |
| FE-3 | No bundle budget in CI | size regressions ship silently |
| FE-4 | No RUM | every performance target is unmeasured |
| FE-5 | Error boundaries partial | one panel can still take out a view |
| FE-6 | Colour-only direction encoding | WCAG 1.4.1 failure |
| FE-7 | No `prefers-reduced-motion` | accessibility + comfort |
| FE-8 | No component tests | zero UI regression coverage |
| FE-9 | Chart panels do not share a candle cache | N panels = N fetches |

---

*Next: [Chapter 16 — Backend Architecture](16-backend-architecture.md)*
