/**
 * The action vocabulary the conversation brain is allowed to emit, and the
 * validator that enforces it.
 *
 * ── WHY THIS EXISTS SERVER-SIDE AS WELL AS CLIENT-SIDE ─────────────────────
 *
 * `apps/web` re-validates every action it receives before executing it. This
 * validator is therefore not the only defence — it is the FIRST of two, and
 * both are deliberate. A model is a text generator: prompt it to emit JSON from
 * a closed vocabulary and it will, almost always. "Almost always" is not a
 * security property. The rule is that an action reaches `executeAction` only if
 * it independently satisfies a hand-written check on both sides of the network.
 *
 * ── WHAT IS NOT IN THE VOCABULARY ──────────────────────────────────────────
 *
 * There is no order action. Not a gated one, not an unimplemented one, not a
 * placeholder. `ARCHITECTURE.md` §1 and §4 make "no AI-initiated trades" a
 * structural property, and the way a structural property survives contact with
 * a plausible feature request is by there being nothing to switch on.
 *
 * If a future phase adds a chart action (AI-OPERATING-SYSTEM.md §6), it is
 * added here AND in `apps/web/src/lib/assistant/types.ts` AND in the client
 * validator. Three places on purpose: the friction is the feature.
 *
 * ── `analyzeMarket` IS IN THE VOCABULARY; `chartDetect` IS NOT ─────────────
 *
 * Not an inconsistency. `analyzeMarket` names a symbol and a timeframe and
 * nothing else — every number in the resulting answer is fetched from the
 * canonical analysis route and rendered by deterministic client code, so a
 * hallucinated plan can pick the wrong market but cannot invent a price.
 * `chartDetect` runs a detector against the bars in the browser and is left to
 * the deterministic grammar, which already handles it without a round trip.
 */

/** Routes the brain may navigate to. Anything else is dropped. */
export const KNOWN_ROUTES = [
  '/dashboard',
  '/trade',
  '/markets',
  '/crypto',
  '/forex',
  '/news',
  '/portfolio',
  '/research',
  '/learning',
  '/sentinel',
  '/settings',
  '/profile',
  '/notifications',
  '/discipline',
] as const;

/** The real PanelKind union from apps/web's workspaceStore. Accepting any
 *  string let the model emit a panel that does not exist, which validates but
 *  cannot do anything — the trace then claims a success the user never sees. */
const PANELS = new Set([
  'watchlist', 'chart', 'blotter', 'optionChain', 'orderTicket',
  'depth', 'sentinel', 'news', 'portfolio', 'learning', 'research',
]);

const OVERLAYS = new Set(['commandPalette', 'notifications', 'shortcuts']);
const THEMES = new Set(['light', 'dark', 'high-contrast']);
const ASKS = new Set(['price', 'range', 'volume']);

/** Hard ceiling on plan length, mirrored in the agent's guardrails. */
export const MAX_STEPS = 8;

export interface PlanStepDto {
  describe: string;
  action: Record<string, unknown>;
}

export interface PlanDto {
  goal: string;
  steps: PlanStepDto[];
  /** True when the request needs the analysis agents rather than navigation. */
  needsAnalysis: boolean;
  /** Set when the request cannot be served at all; plain language, shown as-is. */
  unsupported: string | null;
  /** Actions the model emitted that failed validation. Surfaced, never hidden. */
  dropped: number;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate one action. Returns the action (narrowed to a plain object) or null.
 *
 * Every branch checks the payload, not just the discriminant — a `navigate`
 * whose href is `https://evil.example` or `/../admin` is exactly as invalid as
 * an unknown type, and rejecting only unknown types would be security theatre.
 */
export function validateAction(a: unknown): Record<string, unknown> | null {
  if (!a || typeof a !== 'object') return null;
  const act = a as Record<string, unknown>;

  switch (act.type) {
    case 'navigate': {
      if (!isStr(act.href)) return null;
      // Exact match against the allowlist. Not `startsWith`: that would admit
      // "/settings/../admin" and any open-redirect shaped like a path.
      const href = act.href.split('?')[0]!.replace(/\/+$/, '') || '/';
      if (!(KNOWN_ROUTES as readonly string[]).includes(href)) return null;
      return { type: 'navigate', href: act.href };
    }
    case 'selectSymbol':
      if (!isStr(act.symbol)) return null;
      // Symbols are uppercase alphanumerics; anything else is not a ticker.
      if (!/^[A-Z0-9&_-]{1,24}$/i.test(act.symbol)) return null;
      return { type: 'selectSymbol', symbol: act.symbol.toUpperCase() };
    case 'openOverlay':
      if (!isStr(act.overlay) || !OVERLAYS.has(act.overlay)) return null;
      return { type: 'openOverlay', overlay: act.overlay };
    case 'setTheme':
      if (!isStr(act.theme) || !THEMES.has(act.theme)) return null;
      return { type: 'setTheme', theme: act.theme };
    case 'showPanel':
    case 'hidePanel':
      if (!isStr(act.panel) || !PANELS.has(act.panel)) return null;
      return { type: act.type, panel: act.panel };
    case 'applyLayout':
      if (!isStr(act.layoutId)) return null;
      return { type: 'applyLayout', layoutId: act.layoutId };
    case 'toggleSidebar':
      return { type: 'toggleSidebar' };
    case 'newWorkspaceTab':
      return { type: 'newWorkspaceTab' };
    case 'analyzeMarket': {
      /**
       * Canonical market MEASUREMENTS for one symbol on one timeframe.
       *
       * Safe to admit to the model's vocabulary because it carries no numbers:
       * `services/api` fetches the measurements from Sentinel's projection of
       * the canonical `MarketSnapshot`, and `apps/web` renders that payload
       * verbatim. The model chooses WHAT to measure and never WHAT IT READS.
       *
       * Both fields are optional — a null means "resolve it from the chart the
       * user is looking at", which only the client can do. Neither is trusted:
       * the symbol is shape-checked and the timeframe must be one of the
       * chart's own pill labels, so nothing arbitrary reaches the wire.
       */
      const symbol =
        isStr(act.symbol) && /^[A-Z0-9&_-]{1,24}$/i.test(act.symbol)
          ? act.symbol.toUpperCase()
          : null;
      const timeframe =
        isStr(act.timeframe) && /^(1m|5m|15m|30m|1H|1D|1W)$/i.test(act.timeframe)
          ? act.timeframe
          : null;
      return { type: 'analyzeMarket', symbol, timeframe };
    }
    case 'quote': {
      if (!Array.isArray(act.symbols)) return null;
      const symbols = act.symbols
        .filter(isStr)
        .map((s) => s.toUpperCase())
        .filter((s) => /^[A-Z0-9&_-]{1,24}$/.test(s))
        .slice(0, 5);
      if (!symbols.length) return null;
      const ask = isStr(act.ask) && ASKS.has(act.ask) ? act.ask : 'price';
      return { type: 'quote', symbols, ask };
    }
    default:
      // Unknown type — including anything order-shaped. Dropped, and counted.
      return null;
  }
}

/**
 * Parse and validate the model's reply.
 *
 * Tolerant about the envelope (models wrap JSON in prose or fences no matter
 * how firmly told not to), strict about the contents. Tolerating a fence is a
 * usability choice; tolerating an unrecognised action would be a security one.
 */
export function parsePlan(raw: string): PlanDto {
  const empty: PlanDto = {
    goal: '',
    steps: [],
    needsAnalysis: false,
    unsupported: "I couldn't turn that into something I can do.",
    dropped: 0,
  };

  const json = extractJson(raw);
  if (!json) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const p = parsed as Record<string, unknown>;

  const steps: PlanStepDto[] = [];
  let dropped = 0;

  if (Array.isArray(p.steps)) {
    for (const s of p.steps) {
      if (steps.length >= MAX_STEPS) {
        dropped++;
        continue;
      }
      if (!s || typeof s !== 'object') {
        dropped++;
        continue;
      }
      const step = s as Record<string, unknown>;
      const action = validateAction(step.action);
      if (!action) {
        dropped++;
        continue;
      }
      steps.push({
        describe: isStr(step.describe) ? step.describe : 'Run this step',
        action,
      });
    }
  }

  return {
    goal: isStr(p.goal) ? p.goal : '',
    steps,
    needsAnalysis: p.needsAnalysis === true,
    unsupported: isStr(p.unsupported) ? p.unsupported : null,
    dropped,
  };
}

/** Pull the first balanced JSON object out of a reply that may be wrapped. */
function extractJson(raw: string): string | null {
  const text = raw.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
