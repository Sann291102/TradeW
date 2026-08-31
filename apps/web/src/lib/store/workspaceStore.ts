import { create } from 'zustand';
import { persist, type StorageValue } from 'zustand/middleware';
import type { Candle } from '@tradew/types';
import type { NarrationMode } from '../assistant/narration';
import {
  clearDrawingsByTag,
  replaceDrawingsByTag,
  type ChartDrawing,
  type DrawingTag,
} from '../charts/drawings';

/**
 * TradeW workspace store (Phase 1, Milestone 3).
 *
 * This is the CLIENT-SIDE implementation of `WORKSPACE-CONTINUITY.md` for the
 * current, backend-free phase of the build ("do NOT begin backend integration
 * yet" — M3 brief). It persists to localStorage instead of the doc's
 * server-owned `workspace_session` table. The shape here is intentionally
 * close to that table (§3 of the doc: open surfaces, active tab, panel/layout
 * state, selected symbol) so migrating to a server-synced session later is a
 * transport change, not a redesign — see WORKSPACE-SHELL.md §6.
 */

// ---------------------------------------------------------------------------
// Panels & layout
// ---------------------------------------------------------------------------

export type PanelKind =
  | 'watchlist'
  | 'chart'
  | 'blotter'
  | 'optionChain'
  | 'orderTicket'
  | 'depth'
  | 'sentinel'
  | 'news'
  | 'portfolio'
  | 'learning'
  | 'research';

/** Dock zones. `right` stacks multiple panels vertically, ordered by `order`. */
export type SlotId = 'left' | 'main' | 'auxA' | 'auxB' | 'right';

export interface PanelState {
  /** Stable id — panels are singletons per tab, so id === kind. */
  id: PanelKind;
  kind: PanelKind;
  slot: SlotId;
  /** Position within its slot (lower = earlier/higher). */
  order: number;
  collapsed: boolean;
  /** Pinned panels are skipped by "close all" / survive layout switches' visibility reset. */
  pinned: boolean;
  visible: boolean;
  /** Multi-monitor architecture flag (TRADEW-OS.md, §8 of the M3 brief — no pop-out
   *  implementation yet, this only marks which panels WOULD be eligible). */
  detachable: boolean;
}

export interface LayoutPreset {
  id: string;
  name: string;
  builtIn: boolean;
  panels: PanelState[];
}

function panel(kind: PanelKind, over: Partial<PanelState> = {}): PanelState {
  const detachableKinds: PanelKind[] = ['chart', 'optionChain', 'sentinel', 'news', 'research', 'learning'];
  return {
    id: kind,
    kind,
    slot: 'right',
    order: 0,
    collapsed: false,
    pinned: false,
    visible: true,
    detachable: detachableKinds.includes(kind),
    ...over,
  };
}

/** The full panel roster, in the "Swing" default arrangement — every kind present
 *  exactly once, matching M2's original static grid so the default view is familiar. */
function defaultPanels(): PanelState[] {
  return [
    // hidden by default (Phase 1 redesign) — the "Markets/watching" surface
    // now lives on /markets, not duplicated in the Trade dock (avoids the
    // "trading vs. browsing" confusion of two watchlist-shaped panels).
    panel('watchlist', { slot: 'left', order: 0, visible: false }),
    panel('chart', { slot: 'main', order: 0 }),
    panel('blotter', { slot: 'auxA', order: 0 }),
    // hidden by default — Option Chain is now a tab inside the chart panel
    // (ChartPanel.tsx's "Option Chain" view), not a separate stacked panel.
    // The standalone panel/PanelKind still exists, restorable via "Closed".
    panel('optionChain', { slot: 'auxB', order: 0, visible: false }),
    // hidden by default (Phase 1 redesign) — index/trade workspaces observe
    // and analyze first; order entry is a deliberate secondary action, not
    // the default view. Still fully functional, restorable via "Closed" menu.
    panel('orderTicket', { slot: 'right', order: 0, visible: false }),
    // hidden by default — Market Depth is now a tab inside the chart panel
    // (ChartPanel.tsx's "Depth" view), alongside Option Chain/Technicals.
    panel('depth', { slot: 'right', order: 1, visible: false }),
    panel('sentinel', { slot: 'right', order: 2 }),
    panel('news', { slot: 'right', order: 3 }),
    panel('portfolio', { slot: 'right', order: 4, visible: false }),
    panel('learning', { slot: 'right', order: 5, visible: false }),
    panel('research', { slot: 'right', order: 6, visible: false }),
  ];
}

function clonePanels(panels: PanelState[]): PanelState[] {
  return panels.map((p) => ({ ...p }));
}

function buildPresets(): LayoutPreset[] {
  const base = defaultPanels();
  const find = (list: PanelState[], kind: PanelKind) => list.find((p) => p.kind === kind)!;

  const scalping = clonePanels(base);
  find(scalping, 'depth').order = 0;
  find(scalping, 'orderTicket').order = 1;
  find(scalping, 'sentinel').collapsed = true;
  find(scalping, 'news').collapsed = true;

  const swing = clonePanels(base); // the default arrangement itself

  const options = clonePanels(base);
  find(options, 'optionChain').slot = 'main';
  find(options, 'optionChain').order = 1;
  find(options, 'chart').order = 0;
  find(options, 'blotter').slot = 'auxA';
  find(options, 'depth').collapsed = true;

  const learningLayout = clonePanels(base);
  find(learningLayout, 'learning').visible = true;
  find(learningLayout, 'learning').slot = 'main';
  find(learningLayout, 'learning').order = 1;
  find(learningLayout, 'chart').order = 0;
  find(learningLayout, 'orderTicket').visible = false;
  find(learningLayout, 'depth').visible = false;
  find(learningLayout, 'optionChain').visible = false;
  find(learningLayout, 'sentinel').collapsed = true;

  const research = clonePanels(base);
  find(research, 'research').visible = true;
  find(research, 'research').slot = 'auxA';
  find(research, 'research').order = 0;
  find(research, 'news').slot = 'auxB';
  find(research, 'news').order = 0;
  find(research, 'orderTicket').visible = false;
  find(research, 'depth').visible = false;
  find(research, 'blotter').visible = false;
  find(research, 'optionChain').visible = false;

  const minimal = clonePanels(base);
  for (const p of minimal) {
    if (p.kind !== 'chart' && p.kind !== 'watchlist') p.visible = false;
  }
  // base now hides watchlist by default (see defaultPanels) — "Minimal" is
  // explicitly the one preset defined as "chart + watchlist only", so it
  // must force watchlist back on rather than inherit the hidden default.
  find(minimal, 'watchlist').visible = true;

  const presets: Array<[string, string, PanelState[]]> = [
    ['scalping', 'Scalping', scalping],
    ['swing', 'Swing', swing],
    ['options', 'Options', options],
    ['learning', 'Learning', learningLayout],
    ['research', 'Research', research],
    ['minimal', 'Minimal', minimal],
  ];
  return presets.map(([id, name, panels]) => ({ id, name, builtIn: true, panels }));
}

export const DEFAULT_LEFT_WIDTH = 240;
export const DEFAULT_RIGHT_WIDTH = 300;
export const DEFAULT_MAIN_HEIGHT_PCT = 65;
const LEFT_WIDTH_RANGE = [180, 420] as const;
const RIGHT_WIDTH_RANGE = [240, 480] as const;
const MAIN_HEIGHT_RANGE = [30, 85] as const;

function clamp(n: number, [min, max]: readonly [number, number]) {
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Workspace tabs
// ---------------------------------------------------------------------------

export interface WorkspaceTab {
  id: string;
  name: string;
  panels: PanelState[];
  leftWidth: number;
  rightWidth: number;
  mainHeightPct: number;
  selectedSymbol: string;
  watchlistTab: string;
  /** Last-applied preset id, shown in the Layout menu; diverges once the user
   *  manually resizes/moves/closes a panel (tracked via `layoutDirty`). */
  activeLayoutId: string;
  layoutDirty: boolean;
}

let tabCounter = 0;
/** Deterministic-by-default id generator: pass `id` explicitly for the store's
 *  initial state (must match between SSR and the client's first render — see
 *  WORKSPACE-SHELL.md §5); omit it for tabs created later by user action
 *  (client-only, so Math.random is safe there). */
function newTab(name: string, layoutId = 'swing', id?: string): WorkspaceTab {
  const preset = buildPresets().find((p) => p.id === layoutId) ?? buildPresets()[1];
  return {
    id: id ?? `tab-${++tabCounter}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    panels: clonePanels(preset.panels),
    leftWidth: DEFAULT_LEFT_WIDTH,
    rightWidth: DEFAULT_RIGHT_WIDTH,
    mainHeightPct: DEFAULT_MAIN_HEIGHT_PCT,
    selectedSymbol: 'NIFTY',
    watchlistTab: 'My Watchlist',
    activeLayoutId: preset.id,
    layoutDirty: false,
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type NotificationCategory =
  | 'trade'
  | 'sentinel'
  | 'learning'
  | 'research'
  | 'portfolio'
  | 'broker'
  | 'announcement';

export interface NotificationItem {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  time: string;
  read: boolean;
  /** Producer-specific payload — Sentinel's alert tier rides here. */
  metadata?: unknown;
}

/** Badge tone per category — the single mapping shared by NotificationCenter
 *  (drawer) and the full `/notifications` page, so they never drift apart. */
export const NOTIFICATION_CATEGORY_TONE: Record<NotificationCategory, 'neutral' | 'brand' | 'positive' | 'negative' | 'warning'> = {
  trade: 'positive',
  sentinel: 'brand',
  learning: 'neutral',
  research: 'neutral',
  portfolio: 'warning',
  broker: 'neutral',
  announcement: 'brand',
};

function seedNotifications(): NotificationItem[] {
  return [
    { id: 'n1', category: 'sentinel', title: 'Sentinel observation', body: 'India VIX at 10.0 — elevated within 15 minutes of a losing exit.', time: '2m ago', read: false },
    { id: 'n2', category: 'trade', title: 'Order filled', body: 'BUY NIFTY 23900 CE × 75 filled at ₹142.30.', time: '18m ago', read: false },
    { id: 'n3', category: 'portfolio', title: 'Portfolio alert', body: "Today's P&L crossed +₹4,800.", time: '41m ago', read: true },
    { id: 'n4', category: 'learning', title: 'Continue learning', body: '"New Trader Foundations" — 3 lessons left in this path.', time: '2h ago', read: true },
    { id: 'n5', category: 'announcement', title: 'TradeW update', body: 'Workspace layouts, command palette and themes are now available.', time: '1d ago', read: true },
  ];
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * `system` was added alongside the Settings → Appearance screen. It is a
 * PREFERENCE, not a palette: nothing renders "system", it resolves to `dark`
 * or `light` against `prefers-color-scheme` before `data-theme` is written
 * (see `resolveTheme` below and its two callers — AppFrame at runtime and the
 * inline script in app/layout.tsx pre-hydration).
 *
 * `high-contrast` is kept. It is a real accessibility theme with its own token
 * set and predates the settings screen; dropping it to match a three-option
 * mockup would be a regression, so Appearance shows four choices.
 */
export type ThemeName = 'dark' | 'light' | 'system' | 'high-contrast';

/**
 * Which trading space the Markets workspace is showing.
 *
 * This is a CURRENCY SWITCH, not a display-conversion setting. INR selects the
 * rupee-denominated Indian venues (indices, equities, ETFs, MCX commodities,
 * all fed by Dhan); USD selects the dollar-denominated global venues (crypto
 * from Binance, spot FX from Twelve Data).
 *
 * Nothing is converted between the two, deliberately. Every price stays in the
 * currency its venue actually quotes in. Converting them onto one currency
 * would put a live FX rate inside every price and P&L figure on the screen —
 * and a P&L computed through a rate that moves is not reproducible tomorrow,
 * which is precisely the reasoning already recorded in schema.prisma for
 * keeping the crypto tables separate from the rupee OMS rather than widening
 * it. The switch changes which venues you are looking at; it never restates
 * one venue's numbers in the other's money.
 */
export type MarketCurrency = 'INR' | 'USD';

/**
 * The venue whose session status the top bar's pill is describing.
 *
 * Published by the Markets workspace as the user moves between tabs, and read
 * by `TopBar`'s `MarketStatus`. It exists because that pill hardcoded "· NSE"
 * and drove its dot off the Dhan feed, so on a 24/7 Binance board it read
 * "Status unknown · NSE" over live crypto prices — an NSE session claim
 * printed above numbers that have nothing to do with NSE.
 *
 * Transient, never persisted: it describes what is on screen right now, and a
 * stale value restored from localStorage on a cold load would be a wrong
 * status claim before anything had been checked.
 */
export type MarketVenue = 'NSE' | 'CRYPTO' | 'FX';

/** The palette actually painted for a given preference. */
export type ResolvedTheme = 'dark' | 'light' | 'high-contrast';

/**
 * Resolve a theme preference to the palette to paint.
 *
 * Defaults to `dark` when the OS preference cannot be read (SSR, or a browser
 * that does not answer the query) because TradeW is dark-first — the same
 * default the pre-hydration script in app/layout.tsx uses, so the two never
 * disagree and cause a flash.
 */
export function resolveTheme(theme: ThemeName): ResolvedTheme {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface WorkspaceStore {
  // hydration guard — see lib/store/useHydrated.ts / WORKSPACE-SHELL.md §5
  hasHydrated: boolean;
  setHasHydrated: (v: boolean) => void;

  // theme + chrome
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;

  /**
   * How much the assistant explains while it works — layer 7 of
   * `docs/product-architecture/AI-OPERATING-SYSTEM.md`. Persisted, because a
   * narration preference the user has to re-set every session is not a
   * preference, it is a nag.
   *
   * This is the first slice of the assistant's memory layer (§7 there). It is
   * deliberately an EXPLICIT setting rather than something inferred from
   * behaviour: preferences are learned by asking, never by watching.
   */
  assistantMode: NarrationMode;
  setAssistantMode: (m: NarrationMode) => void;

  /**
   * Whether Tara reads her replies aloud. Off by default and persisted: an app
   * that starts talking unprompted is one the user mutes permanently, and a
   * preference they have to re-set every session is not a preference.
   */
  assistantSpeech: boolean;
  setAssistantSpeech: (on: boolean) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  /**
   * Which trading space the Markets workspace opens in. Persisted, because a
   * trader who works in crypto should not have to re-pick USD every session —
   * same continuity reasoning as the sidebar and workspace tabs below.
   */
  marketCurrency: MarketCurrency;
  setMarketCurrency: (c: MarketCurrency) => void;

  // transient overlays and published view state (never persisted — see
  // partialize below)

  /** Venue whose session the top-bar status pill is describing. See MarketVenue. */
  marketVenue: MarketVenue;
  setMarketVenue: (v: MarketVenue) => void;

  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (v: boolean) => void;
  shortcutsHelpOpen: boolean;
  setShortcutsHelpOpen: (v: boolean) => void;
  notificationCenterOpen: boolean;
  setNotificationCenterOpen: (v: boolean) => void;
  aiDockOpen: boolean;
  setAiDockOpen: (v: boolean) => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (v: boolean) => void;

  /** Close every overlay — the shared Escape-key target (WORKSPACE-SHELL.md §4). */
  closeAllOverlays: () => void;

  /**
   * The chart series currently on screen, published by the chart container so
   * the assistant can run a detector against exactly the bars the user is
   * looking at.
   *
   * `seriesKey` is `SYMBOL|timeframe` and is the whole safety mechanism here:
   * drawings computed on NIFTY 15m are meaningless on RELIANCE 1D, and
   * rendering them anyway would state price levels that were never detected on
   * that instrument. Both the series and its drawings carry the key, and the
   * chart renders drawings only when the two match.
   *
   * Neither field is in `partialize`, so neither is persisted — a few hundred
   * candles in localStorage on every tick would be a real performance bug.
   */
  chartSeries: { seriesKey: string; candles: Candle[]; lastPrice: number | null } | null;
  publishChartSeries: (seriesKey: string, candles: Candle[], lastPrice: number | null) => void;

  /**
   * The timeframe the visible chart is on, as its own field.
   *
   * ── WHY THIS IS NOT READ OUT OF `seriesKey` ────────────────────────────
   *
   * It could be: the key is `SYMBOL|timeframe` and splitting on the pipe would
   * usually work. It is a separate field because `seriesKey` exists to prove
   * that two things describe the SAME series — that is its entire job, and it
   * is why option-contract charts key as `SYMBOL|contract|timeframe`, where the
   * naive split returns the contract. Parsing a value whose format is owned by
   * an unrelated invariant is how "analyse this chart" quietly starts asking
   * for the wrong interval the day someone adds a field to the key.
   *
   * It also has to exist when `chartSeries` does not. The timeframe pill is
   * meaningful before the first candle arrives, and an analysis request made
   * during that window must still carry the interval the user is looking at.
   *
   * Not persisted (absent from `partialize`) — a chart's interval belongs to
   * the session in front of you, not to the browser profile.
   */
  chartTimeframe: string | null;
  /** Published by the chart container whenever its interval changes. */
  setChartTimeframe: (timeframe: string | null) => void;
  chartDrawings: { seriesKey: string; drawings: ChartDrawing[] } | null;
  /** Replace one tag's drawings for a series. Other tags are left untouched. */
  replaceChartDrawings: (seriesKey: string, tag: DrawingTag, next: ChartDrawing[]) => void;
  clearChartDrawings: (tag: DrawingTag) => void;

  // layouts (built-ins regenerated at load; custom ones would append here in a
  // later milestone — the array shape already supports it)
  layouts: LayoutPreset[];

  // workspace tabs
  workspaceTabs: WorkspaceTab[];
  activeTabId: string;
  activeTab: () => WorkspaceTab;
  addWorkspaceTab: (name?: string) => void;
  removeWorkspaceTab: (id: string) => void;
  renameWorkspaceTab: (id: string, name: string) => void;
  switchWorkspaceTab: (id: string) => void;

  // per-tab panel/layout ops (act on the ACTIVE tab)
  applyLayout: (layoutId: string) => void;
  resizeColumns: (leftWidth: number, rightWidth: number) => void;
  resizeMainHeight: (pct: number) => void;
  toggleCollapse: (id: PanelKind) => void;
  togglePin: (id: PanelKind) => void;
  closePanel: (id: PanelKind) => void;
  restorePanel: (id: PanelKind) => void;
  movePanelToSlot: (id: PanelKind, slot: SlotId) => void;
  reorderPanel: (id: PanelKind, direction: 'up' | 'down') => void;
  setSelectedSymbol: (symbol: string) => void;
  setWatchlistTab: (tab: string) => void;

  // notifications
  notifications: NotificationItem[];
  unreadCount: () => number;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  /** Replace the whole list — used by NotificationSync when it pulls the real
   *  feed from services/api. The single writer for server-sourced state. */
  setNotifications: (items: NotificationItem[]) => void;
  /** When true, new notifications arrive silently (no TradeW chime). Persisted
   *  so a muted operator stays muted across reloads. */
  notificationsMuted: boolean;
  toggleNotificationsMuted: () => void;
}

const STORAGE_KEY = 'tradew-workspace-v1';

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      hasHydrated: false,
      setHasHydrated: (v) => set({ hasHydrated: v }),

      theme: 'dark',
      setTheme: (t) => set({ theme: t }),

      // INR default: TradeW's home market is Indian, and the rupee venues are
      // the only ones that are actually placeable today.
      marketCurrency: 'INR',
      setMarketCurrency: (c) => set({ marketCurrency: c }),

      marketVenue: 'NSE',
      setMarketVenue: (v) => set({ marketVenue: v }),

      assistantMode: 'normal',
      setAssistantMode: (m) => set({ assistantMode: m }),

      assistantSpeech: false,
      setAssistantSpeech: (on) => set({ assistantSpeech: on }),
      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      commandPaletteOpen: false,
      setCommandPaletteOpen: (v) => set({ commandPaletteOpen: v }),
      shortcutsHelpOpen: false,
      setShortcutsHelpOpen: (v) => set({ shortcutsHelpOpen: v }),
      notificationCenterOpen: false,
      setNotificationCenterOpen: (v) => set({ notificationCenterOpen: v }),
      aiDockOpen: false,
      setAiDockOpen: (v) => set({ aiDockOpen: v }),
      mobileNavOpen: false,
      setMobileNavOpen: (v) => set({ mobileNavOpen: v }),

      closeAllOverlays: () =>
        set({
          commandPaletteOpen: false,
          shortcutsHelpOpen: false,
          notificationCenterOpen: false,
          aiDockOpen: false,
          mobileNavOpen: false,
        }),

      chartSeries: null,
      chartDrawings: null,
      chartTimeframe: null,
      setChartTimeframe: (timeframe) =>
        // Guarded so a chart re-render that publishes the same interval does not
        // notify every subscriber — the assistant dock subscribes to this.
        set((s) => (s.chartTimeframe === timeframe ? {} : { chartTimeframe: timeframe })),
      publishChartSeries: (seriesKey, candles, lastPrice) =>
        set((s) => ({
          chartSeries: { seriesKey, candles, lastPrice },
          // Changing instrument or timeframe invalidates every drawing derived
          // from the old bars. Dropping them here rather than letting the chart
          // filter on mismatch means stale zones cannot survive a round trip
          // back to the original series.
          chartDrawings:
            s.chartDrawings && s.chartDrawings.seriesKey !== seriesKey ? null : s.chartDrawings,
        })),
      replaceChartDrawings: (seriesKey, tag, next) =>
        set((s) => {
          const existing = s.chartDrawings?.seriesKey === seriesKey ? s.chartDrawings.drawings : [];
          return { chartDrawings: { seriesKey, drawings: replaceDrawingsByTag(existing, tag, next) } };
        }),
      clearChartDrawings: (tag) =>
        set((s) =>
          s.chartDrawings
            ? { chartDrawings: { ...s.chartDrawings, drawings: clearDrawingsByTag(s.chartDrawings.drawings, tag) } }
            : {},
        ),

      layouts: buildPresets(),

      // Fixed id ('tab-1') so server render and the client's first (pre-rehydrate)
      // render produce byte-identical output — see the newTab() doc comment.
      workspaceTabs: [newTab('Workspace 1', 'swing', 'tab-1')],
      activeTabId: 'tab-1',
      activeTab: () => {
        const s = get();
        return s.workspaceTabs.find((t) => t.id === s.activeTabId) ?? s.workspaceTabs[0];
      },

      addWorkspaceTab: (name) =>
        set((s) => {
          const tab = newTab(name || `Workspace ${s.workspaceTabs.length + 1}`);
          return { workspaceTabs: [...s.workspaceTabs, tab], activeTabId: tab.id };
        }),

      removeWorkspaceTab: (id) =>
        set((s) => {
          if (s.workspaceTabs.length <= 1) return s; // always keep at least one
          const remaining = s.workspaceTabs.filter((t) => t.id !== id);
          const activeTabId = s.activeTabId === id ? remaining[0].id : s.activeTabId;
          return { workspaceTabs: remaining, activeTabId };
        }),

      renameWorkspaceTab: (id, name) =>
        set((s) => ({
          workspaceTabs: s.workspaceTabs.map((t) => (t.id === id ? { ...t, name: name.trim() || t.name } : t)),
        })),

      switchWorkspaceTab: (id) => set({ activeTabId: id }),

      applyLayout: (layoutId) =>
        set((s) => {
          const preset = s.layouts.find((l) => l.id === layoutId);
          if (!preset) return s;
          return {
            workspaceTabs: s.workspaceTabs.map((t) =>
              t.id === s.activeTabId
                ? {
                    ...t,
                    panels: clonePanels(preset.panels),
                    leftWidth: DEFAULT_LEFT_WIDTH,
                    rightWidth: DEFAULT_RIGHT_WIDTH,
                    mainHeightPct: DEFAULT_MAIN_HEIGHT_PCT,
                    activeLayoutId: preset.id,
                    layoutDirty: false,
                  }
                : t,
            ),
          };
        }),

      resizeColumns: (leftWidth, rightWidth) =>
        set((s) => ({
          workspaceTabs: s.workspaceTabs.map((t) =>
            t.id === s.activeTabId
              ? {
                  ...t,
                  leftWidth: clamp(leftWidth, LEFT_WIDTH_RANGE),
                  rightWidth: clamp(rightWidth, RIGHT_WIDTH_RANGE),
                  layoutDirty: true,
                }
              : t,
          ),
        })),

      resizeMainHeight: (pct) =>
        set((s) => ({
          workspaceTabs: s.workspaceTabs.map((t) =>
            t.id === s.activeTabId ? { ...t, mainHeightPct: clamp(pct, MAIN_HEIGHT_RANGE), layoutDirty: true } : t,
          ),
        })),

      toggleCollapse: (id) =>
        set((s) => ({
          workspaceTabs: s.workspaceTabs.map((t) =>
            t.id === s.activeTabId
              ? { ...t, panels: t.panels.map((p) => (p.id === id ? { ...p, collapsed: !p.collapsed } : p)), layoutDirty: true }
              : t,
          ),
        })),

      togglePin: (id) =>
        set((s) => ({
          workspaceTabs: s.workspaceTabs.map((t) =>
            t.id === s.activeTabId
              ? { ...t, panels: t.panels.map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p)), layoutDirty: true }
              : t,
          ),
        })),

      closePanel: (id) =>
        set((s) => ({
          workspaceTabs: s.workspaceTabs.map((t) =>
            t.id === s.activeTabId
              ? { ...t, panels: t.panels.map((p) => (p.id === id ? { ...p, visible: false } : p)), layoutDirty: true }
              : t,
          ),
        })),

      restorePanel: (id) =>
        set((s) => ({
          workspaceTabs: s.workspaceTabs.map((t) =>
            t.id === s.activeTabId
              ? { ...t, panels: t.panels.map((p) => (p.id === id ? { ...p, visible: true } : p)), layoutDirty: true }
              : t,
          ),
        })),

      movePanelToSlot: (id, slot) =>
        set((s) => ({
          workspaceTabs: s.workspaceTabs.map((t) => {
            if (t.id !== s.activeTabId) return t;
            const maxOrder = Math.max(-1, ...t.panels.filter((p) => p.slot === slot).map((p) => p.order));
            return {
              ...t,
              panels: t.panels.map((p) => (p.id === id ? { ...p, slot, order: maxOrder + 1 } : p)),
              layoutDirty: true,
            };
          }),
        })),

      reorderPanel: (id, direction) =>
        set((s) => ({
          workspaceTabs: s.workspaceTabs.map((t) => {
            if (t.id !== s.activeTabId) return t;
            const target = t.panels.find((p) => p.id === id);
            if (!target) return t;
            const siblings = t.panels
              .filter((p) => p.slot === target.slot && p.visible)
              .sort((a, b) => a.order - b.order);
            const idx = siblings.findIndex((p) => p.id === id);
            const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
            if (swapIdx < 0 || swapIdx >= siblings.length) return t;
            const other = siblings[swapIdx];
            return {
              ...t,
              panels: t.panels.map((p) => {
                if (p.id === target.id) return { ...p, order: other.order };
                if (p.id === other.id) return { ...p, order: target.order };
                return p;
              }),
              layoutDirty: true,
            };
          }),
        })),

      setSelectedSymbol: (symbol) =>
        set((s) => ({
          workspaceTabs: s.workspaceTabs.map((t) => (t.id === s.activeTabId ? { ...t, selectedSymbol: symbol } : t)),
        })),

      setWatchlistTab: (tab) =>
        set((s) => ({
          workspaceTabs: s.workspaceTabs.map((t2) => (t2.id === s.activeTabId ? { ...t2, watchlistTab: tab } : t2)),
        })),

      notifications: seedNotifications(),
      unreadCount: () => get().notifications.filter((n) => !n.read).length,
      markNotificationRead: (id) =>
        set((s) => ({ notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)) })),
      markAllNotificationsRead: () => set((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) })),
      setNotifications: (items) => set({ notifications: items }),
      notificationsMuted: false,
      toggleNotificationsMuted: () => set((s) => ({ notificationsMuted: !s.notificationsMuted })),
    }),
    {
      name: STORAGE_KEY,
      // Rehydration is triggered manually post-mount (see useHydrated.ts) so the
      // server-rendered HTML and the client's first render always match —
      // avoids React hydration-mismatch warnings from reading localStorage
      // during store creation.
      skipHydration: true,
      version: 1,
      // Only persist genuine continuity state — transient overlay booleans and
      // the regenerated built-in layouts are excluded (WORKSPACE-SHELL.md §5).
      partialize: (s) => ({
        theme: s.theme,
        assistantMode: s.assistantMode,
        assistantSpeech: s.assistantSpeech,
        sidebarCollapsed: s.sidebarCollapsed,
        // marketCurrency is continuity state; marketVenue deliberately is NOT
        // (it is a claim about the current screen — see MarketVenue).
        marketCurrency: s.marketCurrency,
        workspaceTabs: s.workspaceTabs,
        activeTabId: s.activeTabId,
        notifications: s.notifications,
        notificationsMuted: s.notificationsMuted,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<WorkspaceStore>;
        const merged: WorkspaceStore = { ...current, ...p };
        // activeTabId may point at a tab that no longer exists across schema
        // changes; fall back to the first tab rather than rendering nothing.
        if (!merged.workspaceTabs.some((t) => t.id === merged.activeTabId)) {
          merged.activeTabId = merged.workspaceTabs[0]?.id ?? '';
        }
        return merged;
      },
      // Fires once manual rehydrate() (see useHydrated.ts) resolves, whether or
      // not localStorage had anything — this is the hasHydrated signal
      // consumers gate first-paint-sensitive UI on.
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    } satisfies import('zustand/middleware').PersistOptions<WorkspaceStore, Partial<WorkspaceStore>> & {
      storage?: { getItem: (name: string) => StorageValue<unknown> | null | Promise<StorageValue<unknown> | null> };
    },
  ),
);
