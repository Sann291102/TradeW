/**
 * The shape of every server-persisted user preference document.
 *
 * ── WHERE SETTINGS LIVE ────────────────────────────────────────────────────
 *
 * Each exported interface below is ONE row in `UserPreference` — `(userId,
 * key)` unique, value stored as JSON — read with `GET /auth/preferences` and
 * written with `POST /auth/preferences/:key`. That table already existed; this
 * file gives its previously free-form JSON a name and a default so a settings
 * screen can round-trip it.
 *
 * The keys are mirrored in `services/api/src/auth/preference-keys.ts`, which
 * is the allowlist the write route enforces. A key added here and not there is
 * a 400, on purpose: the server decides what may be stored, not the browser.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * Anything the app cannot actually honour. A preference in this file is a
 * promise that some real code path reads it; a control with no reader belongs
 * in the UI marked unavailable, not in this type. Each field below names its
 * reader in a comment so the promise stays checkable.
 */

// ---------------------------------------------------------------------------
// general
// ---------------------------------------------------------------------------

/** Every workspace route a user may be sent to on sign-in. */
export const LANDING_ROUTES = [
  { value: '/dashboard', label: 'Home' },
  { value: '/markets', label: 'Markets' },
  { value: '/portfolio', label: 'Portfolio' },
  { value: '/trade', label: 'Trade' },
  { value: '/orders', label: 'Orders' },
  { value: '/positions', label: 'Positions' },
  { value: '/sentinel', label: 'AI Sentinel' },
  { value: '/research', label: 'Research' },
  { value: '/news', label: 'News Feed' },
] as const;

export type LandingRoute = (typeof LANDING_ROUTES)[number]['value'];

export type DateFormat = 'dd-mm-yyyy' | 'yyyy-mm-dd' | 'mm-dd-yyyy';
export type NumberFormat = 'en-IN' | 'en-US';
export type Density = 'comfortable' | 'compact';

export interface GeneralPreferences {
  /** Read by `lib/settings/format.ts`, used by the settings surfaces that
   *  render dates. NOT yet threaded through every legacy formatter — see the
   *  note on `formatPreferredDate`. */
  dateFormat: DateFormat;
  /** Grouping for prices and quantities (Indian lakh/crore vs. thousands). */
  numberFormat: NumberFormat;
  /** Where sign-in lands. Read by `lib/session-redirect.ts`'s caller in
   *  `components/landing/AuthPanel.tsx`. */
  landingRoute: string;
  /** Row height / padding on dense tables. Applied as `data-density` on the
   *  document element by `SettingsEffects`. */
  density: Density;
}

export const DEFAULT_GENERAL: GeneralPreferences = {
  dateFormat: 'dd-mm-yyyy',
  numberFormat: 'en-IN',
  landingRoute: '/dashboard',
  density: 'comfortable',
};

// ---------------------------------------------------------------------------
// appearance
// ---------------------------------------------------------------------------

/**
 * `system` follows the OS via `prefers-color-scheme`; the other three are
 * explicit. `high-contrast` predates this file (workspaceStore's ThemeName)
 * and is kept — dropping a working accessibility theme to match a mockup would
 * be a regression.
 */
export type ThemePreference = 'light' | 'dark' | 'system' | 'high-contrast';

/** Factory defaults for the candle colours, matching the dark theme's
 *  `--green` / `--red` tokens in `@tradew/ui`. "Reset to default" restores
 *  exactly these. */
export const DEFAULT_CANDLE_UP = '#26a69a';
export const DEFAULT_CANDLE_DOWN = '#ef5350';

export interface AppearancePreferences {
  theme: ThemePreference;
  /** Bullish candle body/wick colour. Applied to `--candle-up` on the document
   *  element; read by `components/charts/TradeChart.tsx`. */
  candleUp: string;
  /** Bearish candle body/wick colour → `--candle-down`. */
  candleDown: string;
  /** Hollow up-candles with a coloured border, the way many terminals draw
   *  them. Read by TradeChart (`borderVisible` + transparent body). */
  hollowUpCandles: boolean;
  /** Chart grid lines. Read by TradeChart. */
  showChartGrid: boolean;
  /** Crosshair mode: normal (magnet-free) or hidden. Read by TradeChart. */
  showCrosshair: boolean;
}

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: 'dark',
  candleUp: DEFAULT_CANDLE_UP,
  candleDown: DEFAULT_CANDLE_DOWN,
  hollowUpCandles: false,
  showChartGrid: true,
  showCrosshair: true,
};

// ---------------------------------------------------------------------------
// trading
// ---------------------------------------------------------------------------

export type ProductTypePreference = 'MIS' | 'CNC' | 'NRML';
export type QuantityUnit = 'lots' | 'qty';

export interface TradingPreferences {
  /** Initial product on the order ticket. Read by
   *  `components/terminal/panels/OrdersPanel.tsx`. */
  defaultProductType: ProductTypePreference;
  /** Whether the quantity field starts in lots or raw quantity. */
  defaultQuantityUnit: QuantityUnit;
  /** How many lots the ticket pre-fills. */
  defaultLots: number;
  /**
   * An extra "are you sure" step before an order is sent.
   *
   * ADDS friction and never removes it. It sits in front of `place()`, so the
   * discipline engine, the margin checks and every server-side validation run
   * exactly as before whether it is on or off — there is no preference in this
   * file that can switch a safeguard off, and there must never be one.
   */
  confirmBeforeOrder: boolean;
}

export const DEFAULT_TRADING: TradingPreferences = {
  defaultProductType: 'MIS',
  defaultQuantityUnit: 'lots',
  defaultLots: 1,
  // Defaults OFF so the ticket behaves exactly as it did before this setting
  // existed. Turning it on is the only thing that changes the flow.
  confirmBeforeOrder: false,
};

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

/**
 * The categories `services/api`'s notification producers actually write.
 * Mirrors `NotificationItem['category']` in `lib/notifications.ts` — a
 * category that no producer emits would be a switch over nothing.
 */
export type NotificationCategory =
  | 'trade'
  | 'sentinel'
  | 'learning'
  | 'research'
  | 'portfolio'
  | 'broker'
  | 'announcement';

export interface NotificationPreferences {
  /** Per-category in-app delivery. A muted category is filtered out of the
   *  notification centre and the unread count by `lib/query/useNotifications`. */
  categories: Record<NotificationCategory, boolean>;
  /** The chime that plays on a new notification. Read by
   *  `components/shell/NotificationSync.tsx`. */
  sound: boolean;
}

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, { label: string; hint: string }> = {
  trade: { label: 'Trading', hint: 'Order placed, filled, rejected or cancelled' },
  portfolio: { label: 'Portfolio', hint: 'Position and P&L movements on your paper account' },
  sentinel: { label: 'AI Sentinel', hint: 'Observations, safety warnings and behaviour alerts' },
  research: { label: 'Research', hint: 'Research output and market analysis' },
  learning: { label: 'Learning', hint: 'Course progress and new concepts' },
  broker: { label: 'Broker', hint: 'Connection state and token expiry for a linked broker' },
  announcement: { label: 'Product', hint: 'System updates and product announcements' },
};

export const DEFAULT_NOTIFICATIONS: NotificationPreferences = {
  categories: {
    trade: true,
    portfolio: true,
    sentinel: true,
    research: true,
    learning: true,
    broker: true,
    announcement: true,
  },
  sound: true,
};

// ---------------------------------------------------------------------------
// privacy
// ---------------------------------------------------------------------------

export interface PrivacyPreferences {
  /**
   * Client-side product analytics. Read by `lib/analytics.ts`, which drops
   * every event when this is false.
   *
   * This governs the browser's own telemetry only. It does not and cannot
   * switch off server-side logging of requests you make — the API records
   * those to answer "what happened to my order", and a client toggle that
   * claimed otherwise would be a lie.
   */
  productAnalytics: boolean;
}

export const DEFAULT_PRIVACY: PrivacyPreferences = {
  productAnalytics: true,
};

// ---------------------------------------------------------------------------
// the whole set
// ---------------------------------------------------------------------------

export interface PreferenceSet {
  general: GeneralPreferences;
  appearance: AppearancePreferences;
  trading: TradingPreferences;
  notifications: NotificationPreferences;
  privacy: PrivacyPreferences;
}

export type PreferenceKey = keyof PreferenceSet;

export const DEFAULT_PREFERENCES: PreferenceSet = {
  general: DEFAULT_GENERAL,
  appearance: DEFAULT_APPEARANCE,
  trading: DEFAULT_TRADING,
  notifications: DEFAULT_NOTIFICATIONS,
  privacy: DEFAULT_PRIVACY,
};

/** A 3- or 6-digit hex colour. Used to reject a stored value that has been
 *  hand-edited into something the chart cannot render. */
export const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback;
}

/**
 * Coerce whatever came back from the server into a valid document.
 *
 * The API stores JSON verbatim, so a row written by an older build (or by
 * hand) can be any shape at all. Every field is validated against its own
 * domain and falls back to the default individually — a single bad key must
 * not discard the rest of a user's settings.
 */
export function parsePreferences(raw: Record<string, unknown> | null | undefined): PreferenceSet {
  const g = asObject(raw?.general);
  const a = asObject(raw?.appearance);
  const t = asObject(raw?.trading);
  const n = asObject(raw?.notifications);
  const p = asObject(raw?.privacy);
  const nc = asObject(n?.categories);

  return {
    general: {
      dateFormat: pickEnum(g?.dateFormat, ['dd-mm-yyyy', 'yyyy-mm-dd', 'mm-dd-yyyy'] as const, DEFAULT_GENERAL.dateFormat),
      numberFormat: pickEnum(g?.numberFormat, ['en-IN', 'en-US'] as const, DEFAULT_GENERAL.numberFormat),
      landingRoute: pickEnum(
        g?.landingRoute,
        LANDING_ROUTES.map((r) => r.value),
        DEFAULT_GENERAL.landingRoute as LandingRoute,
      ),
      density: pickEnum(g?.density, ['comfortable', 'compact'] as const, DEFAULT_GENERAL.density),
    },
    appearance: {
      theme: pickEnum(a?.theme, ['light', 'dark', 'system', 'high-contrast'] as const, DEFAULT_APPEARANCE.theme),
      candleUp: pickColor(a?.candleUp, DEFAULT_APPEARANCE.candleUp),
      candleDown: pickColor(a?.candleDown, DEFAULT_APPEARANCE.candleDown),
      hollowUpCandles: pickBool(a?.hollowUpCandles, DEFAULT_APPEARANCE.hollowUpCandles),
      showChartGrid: pickBool(a?.showChartGrid, DEFAULT_APPEARANCE.showChartGrid),
      showCrosshair: pickBool(a?.showCrosshair, DEFAULT_APPEARANCE.showCrosshair),
    },
    trading: {
      defaultProductType: pickEnum(t?.defaultProductType, ['MIS', 'CNC', 'NRML'] as const, DEFAULT_TRADING.defaultProductType),
      defaultQuantityUnit: pickEnum(t?.defaultQuantityUnit, ['lots', 'qty'] as const, DEFAULT_TRADING.defaultQuantityUnit),
      defaultLots: clampLots(t?.defaultLots),
      confirmBeforeOrder: pickBool(t?.confirmBeforeOrder, DEFAULT_TRADING.confirmBeforeOrder),
    },
    notifications: {
      categories: Object.fromEntries(
        (Object.keys(DEFAULT_NOTIFICATIONS.categories) as NotificationCategory[]).map((k) => [
          k,
          pickBool(nc?.[k], DEFAULT_NOTIFICATIONS.categories[k]),
        ]),
      ) as Record<NotificationCategory, boolean>,
      sound: pickBool(n?.sound, DEFAULT_NOTIFICATIONS.sound),
    },
    privacy: {
      productAnalytics: pickBool(p?.productAnalytics, DEFAULT_PRIVACY.productAnalytics),
    },
  };
}

/** Lots is a small positive integer. A stored 0, -3 or 10_000 is nonsense the
 *  ticket would have to reject anyway, so it never gets that far. */
function clampLots(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TRADING.defaultLots;
  return Math.min(100, Math.max(1, Math.round(n)));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
