import { NAV_ITEMS } from '@/components/shell/nav-config';
import type { PanelKind, ThemeName } from '../store/workspaceStore';
import { commandPlan, type AssistantAction, type AssistantPlan } from './types';
import { EXPLAIN_RE as CONCEPT_EXPLAIN_RE } from './concepts';
import { contractHref, findSymbol, parseContract } from './instruments';

/**
 * The command grammar — TRADEW-ASSISTANT.md §3/§5.
 *
 * §5 is the governing requirement: the assistant can open "every feature
 * available to the current user", so the nav grammar is DERIVED from
 * `NAV_ITEMS` rather than hand-listed. Adding a page to the sidebar makes it
 * commandable automatically, exactly as it already makes it searchable in the
 * command palette (lib/search/providers.ts).
 *
 * Everything resolves without an LLM call.
 */

/** Verbs that mean "take me there" / "do this". */
const OPEN_VERB = String.raw`(?:open|show(?:\s+me)?|go\s+to|goto|take\s+me\s+to|navigate\s+to|bring\s+up|pull\s+up|launch|load|switch\s+to|display)`;
const HIDE_VERB = String.raw`(?:hide|close|remove|dismiss)`;

/** "explain", "tell me about", "what's happening" — the analysis half of a
 *  compound command like "open research and explain". */
const EXPLAIN_RE = /\b(explain|analys[ei]s?|analyz[ei]|tell me about|walk me through|what'?s (?:happening|going on)|break (?:it|this) down|insights?)\b/i;

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/**
 * Instrument-panel TABS, addressed via `/trade?view=` (see ChartPanel's
 * `initialView` and TradeWorkspace's `view` param).
 *
 * These are NOT dock panels. Option Chain / Depth / Technicals were folded
 * into ChartPanel as tabs (see ChartPanel's doc comment), and the legacy
 * `optionChain`/`depth` PanelKinds are hidden by default AND not rendered by
 * TradeWorkspace at all. An earlier version of this file resolved "show the
 * option chain" to `restorePanel('optionChain')`, which flipped a store flag
 * nothing reads — the assistant reported success and the screen didn't change.
 * Routing to the tab is the only thing that actually shows the chain.
 */
const VIEW_ALIASES: ReadonlyArray<{ view: string; label: string; aliases: string[] }> = [
  { view: 'optionChain', label: 'Option Chain', aliases: ['option chain', 'options chain', 'option-chain', 'chain'] },
  { view: 'depth', label: 'Market Depth', aliases: ['market depth', 'depth', 'order book'] },
  { view: 'technicals', label: 'Technicals', aliases: ['technicals', 'technical indicators', 'indicators'] },
  { view: 'markets', label: 'Markets', aliases: ['markets tab', 'market movers'] },
  // 'chart'/'charts' were MISSING here, so "show the chart" — the single most
  // obvious way to ask for this tab — matched nothing at all. Only 'candles'
  // and 'candlestick' worked, which nobody guesses. Bare 'chart' is safe
  // despite "open RELIANCE chart" also being a symbol command: the resolver
  // below folds `findSymbol` into the same href, so both phrasings land on the
  // same place.
  {
    view: 'charts',
    label: 'Charts',
    aliases: ['chart', 'charts', 'price chart', 'chart view', 'candles', 'candlestick'],
  },
];

/**
 * Dock panels the assistant can genuinely toggle — deliberately ONLY the three
 * that TradeWorkspace actually renders (`blotter`, `sentinel`, `news`). The
 * other PanelKinds still exist in the store for saved layouts, but nothing on
 * /trade renders them, so a command to show one would be a lie.
 */
const PANEL_ALIASES: ReadonlyArray<{ panel: PanelKind; label: string; aliases: string[]; needsPanelWord?: boolean }> = [
  { panel: 'blotter', label: 'Blotter', aliases: ['blotter', 'trade blotter'] },
  { panel: 'news', label: 'News', aliases: ['news feed', 'news'] },
  { panel: 'sentinel', label: 'Sentinel', aliases: ['sentinel'], needsPanelWord: true },
];

const THEME_ALIASES: ReadonlyArray<{ theme: ThemeName; aliases: string[]; label: string }> = [
  { theme: 'dark', aliases: ['dark mode', 'dark theme', 'night mode'], label: 'Dark' },
  { theme: 'light', aliases: ['light mode', 'light theme', 'day mode'], label: 'Light' },
  { theme: 'high-contrast', aliases: ['high contrast', 'high-contrast'], label: 'High contrast' },
];

const LAYOUT_IDS = ['scalping', 'swing', 'options', 'learning', 'research', 'minimal'] as const;

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve an utterance to an executable plan, or null if it isn't a command.
 *
 * Ordering is significant — most specific first. A contract reference must be
 * tested before a bare symbol, or "NIFTY 24300 call" opens the NIFTY index
 * chart and silently drops the strike the user asked for.
 */
export function resolveCommand(text: string, today = new Date()): AssistantPlan | null {
  const t = text.trim();
  if (!t) return null;
  const lower = t.toLowerCase();

  return (
    matchContract(t, today) ??
    matchDetect(t) ??
    // Above matchTheme/matchPanel/matchSymbol deliberately — see matchAnalyze's
    // docblock. Below matchDetect, because "find the FVGs and analyse them" is
    // a detection request that happens to use the word.
    matchAnalyze(t) ??
    matchTheme(lower) ??
    matchOverlay(lower) ??
    matchLayout(lower) ??
    matchView(t) ??
    matchPanel(lower) ??
    matchChrome(lower) ??
    matchNav(lower) ??
    matchSymbol(t) ??
    null
  );
}

// --- option contract -------------------------------------------------------

function matchContract(text: string, today: Date): AssistantPlan | null {
  const c = parseContract(text, today);
  if (!c) return null;

  const href = contractHref(c);
  const label = `${c.symbol} ${c.strike} ${c.optionType} · ${c.expiryLabel}`;

  const steps = [
    `Parsed contract → ${c.symbol} ${c.strike} ${c.optionType}`,
    c.expiryImplied
      ? "No expiry named → using the chain's nearest expiry"
      : `Expiry → ${c.expiryLabel}${c.expiryPast ? ' (already passed)' : ''}`,
    `Opened ${href}`,
  ];

  // The assistant resolves and opens; it does not assert the contract trades.
  // If this strike isn't in the live chain, the Trade workspace surfaces that
  // itself rather than the assistant claiming a price that doesn't exist.
  let reply = `Opening ${label}.`;
  if (c.expiryImplied) {
    reply = `Opening ${label}. You didn't name an expiry, so I've left it on the chain's nearest one — say "of 21st July" to pin a specific expiry.`;
  } else if (c.expiryPast) {
    reply = `Opening ${label} — note that expiry has already passed, so this contract is settled, not live. Name a future date if you meant a tradeable one.`;
  }

  return commandPlan(reply, [{ type: 'selectSymbol', symbol: c.symbol }, { type: 'navigate', href }], steps);
}

// --- chart detection -------------------------------------------------------

/** Names for the one detector that exists. "Imbalance" is the same thing. */
const FVG_RE = /\b(fvgs?|fair\s+value\s+gaps?|imbalances?)\b/i;

/** "clear the fvgs", "get rid of the gaps". */
const ERASE_VERB = /\b(clear|erase|delete|get\s+rid\s+of|take\s+(?:them\s+)?off|remove|hide)\b/i;

/**
 * Phrasings that make the CHART the object of the question rather than the
 * concept: "what's the FVG **on this chart**" wants rectangles, "what is an
 * FVG" wants an explanation.
 */
const CHART_SCOPED_RE = /\b(on (?:the|this|my) chart|on screen|on the screen|right now|currently|here\b)/i;

/**
 * Detection commands — "FVG", "mark the fair value gaps", "clear the gaps".
 *
 * ── THE COLLISION THIS FUNCTION EXISTS TO NOT CAUSE ────────────────────────
 *
 * `router.ts` runs command resolution BEFORE concept questions, deliberately.
 * That ordering is safe for navigation ("open the FVG chart" really is
 * navigation) but it is a trap for a detector, because "what is a fair value
 * gap" contains the same words as "mark the fair value gaps". Resolving that
 * as a command would answer a question by drawing on the chart — precisely the
 * regression `concepts.ts` was written to fix, reintroduced from the other
 * side of the pipeline.
 *
 * So an explain-phrasing hands control back to `concepts.ts` by returning
 * null, using that module's own exported regex rather than a second copy of
 * it. The one exception is an utterance that names the chart as its subject,
 * where "what are the FVGs on this chart" is plainly a request to look.
 *
 * ── WHY THIS NAVIGATES ─────────────────────────────────────────────────────
 *
 * Detection needs a chart on screen, and this resolver is pure — it cannot see
 * which route the user is on. Opening `/trade` guarantees there is something to
 * draw on. It is reversible in one click, which is why `safety.ts` leaves the
 * whole plan in the `free` tier.
 */
function matchDetect(text: string): AssistantPlan | null {
  if (!FVG_RE.test(text)) return null;
  if (CONCEPT_EXPLAIN_RE.test(text) && !CHART_SCOPED_RE.test(text)) return null;

  if (ERASE_VERB.test(text)) {
    return commandPlan('Cleared the fair value gaps.', [{ type: 'chartClearDrawings', tag: 'fvg' }], [
      'Classified → clear drawings',
      'Removed the fvg layer (other drawings untouched)',
    ]);
  }

  return commandPlan(
    'Marking fair value gaps on the chart…',
    [
      { type: 'navigate', href: '/trade' },
      { type: 'chartDetect', detector: 'fvg' },
    ],
    ['Classified → chart detection', 'Detector → fair value gaps'],
  );
}

// --- market analysis -------------------------------------------------------

/**
 * Verbs that mean "measure this market for me".
 *
 * Deliberately narrower than `EXPLAIN_RE` above: that one exists to spot the
 * analysis HALF of a compound navigation command, and matching "insights" or
 * "tell me about" here would turn "tell me about the Research page" into a
 * market read.
 */
const ANALYSE_VERB_RE =
  /\b(analys[ei]|analyz[ei]|analysis of|read (?:the )?(?:market|chart)|market read|how (?:is|does) .{1,30} (?:look|doing)|what (?:is|'s) .{1,30} doing)\b/i;

/**
 * Timeframes the user can name, mapped to the chart's own pill labels.
 *
 * The label is passed through to the API unchanged; `services/sentinel`'s
 * `resolveInterval` owns the translation to a `CandleInterval` and owns saying
 * no. Two normalisers would eventually disagree about what "1H" means, and the
 * one that matters is the one beside the engine.
 */
const TIMEFRAME_RE =
  /(?:^|[\s,([])(1\s*m(?:in(?:ute)?s?)?|5\s*m(?:in(?:ute)?s?)?|15\s*m(?:in(?:ute)?s?)?|30\s*m(?:in(?:ute)?s?)?|1\s*h(?:our|r)?|60\s*m(?:in)?|1\s*d(?:ay)?|daily|hourly|1\s*w(?:eek)?|weekly)(?:$|[\s,.)?!])/i;

/** Phrasings that mean "the thing I am looking at" rather than a named symbol. */
const CURRENT_CHART_RE =
  /\b(this|the current|current|my|the active|active|on screen|on the screen)\s+(chart|market|symbol|instrument|timeframe)\b|\bthis\b\s*$/i;

/** Normalise "15 min" / "1 hour" to the pill label the chart uses. */
function normaliseTimeframeLabel(raw: string): string {
  const compact = raw.toLowerCase().replace(/\s+/g, '');
  if (/^1m(in(ute)?s?)?$/.test(compact)) return '1m';
  if (/^5m(in(ute)?s?)?$/.test(compact)) return '5m';
  if (/^15m(in(ute)?s?)?$/.test(compact)) return '15m';
  if (/^30m(in(ute)?s?)?$/.test(compact)) return '30m';
  if (/^(1h(our|r)?|60m(in)?|hourly)$/.test(compact)) return '1H';
  if (/^(1d(ay)?|daily)$/.test(compact)) return '1D';
  if (/^(1w(eek)?|weekly)$/.test(compact)) return '1W';
  return raw.trim();
}

/**
 * "Analyse NIFTY", "analyse NIFTY 15m", "analyse the current chart".
 *
 * ── WHY THIS SITS ABOVE `matchSymbol` AND `matchPanel` ─────────────────────
 *
 * Both would swallow it. `matchSymbol` resolves a bare "NIFTY" to *select the
 * NIFTY symbol*, so "analyse NIFTY" would silently become a symbol switch and
 * report success; `matchPanel` claims the word "chart", so "analyse the current
 * chart" would open the chart panel. Either outcome is the failure mode
 * `concepts.ts` was written about — an answer replaced by a plausible-looking
 * navigation.
 *
 * ── WHY IT EMITS NULLS INSTEAD OF DEFAULTS ─────────────────────────────────
 *
 * A missing symbol becomes `null`, not `'NIFTY'`. Defaulting would mean
 * "analyse this" silently measures an index the user may not be looking at and
 * presents the result as their chart. The executor resolves nulls against the
 * live workspace and says so plainly when it cannot.
 *
 * ── WHY IT DOES NOT NAVIGATE ───────────────────────────────────────────────
 *
 * Unlike `matchDetect`, this needs no chart on screen — the measurements come
 * from the engine, not from the bars in the browser. Navigating would move the
 * user somewhere they did not ask to go in order to answer a question.
 */
function matchAnalyze(text: string): AssistantPlan | null {
  if (!ANALYSE_VERB_RE.test(text)) return null;

  // "what is NIFTY doing" is an analysis ask; "what is a fair value gap" is a
  // concept question and must reach `concepts.ts` untouched. The verb regex
  // above cannot separate them, so a concept-explain phrasing with no symbol in
  // it is handed back.
  const found = findSymbol(text);
  const wantsCurrent = CURRENT_CHART_RE.test(text);
  if (!found && !wantsCurrent) return null;

  const tfMatch = TIMEFRAME_RE.exec(text);
  const timeframe = tfMatch ? normaliseTimeframeLabel(tfMatch[1]) : null;

  const symbol = found?.symbol ?? null;
  const target = symbol ?? 'the chart you have open';
  const on = timeframe ? ` on ${timeframe}` : '';

  return commandPlan(
    `Reading ${target}${on}…`,
    [{ type: 'analyzeMarket', symbol, timeframe }],
    [
      'Classified → market analysis',
      symbol ? `Symbol → ${symbol}` : 'Symbol → the active chart',
      timeframe ? `Timeframe → ${timeframe}` : 'Timeframe → the active chart’s',
    ],
  );
}

// --- theme -----------------------------------------------------------------

function matchTheme(lower: string): AssistantPlan | null {
  for (const { theme, aliases, label } of THEME_ALIASES) {
    if (aliases.some((a) => lower.includes(a))) {
      return commandPlan(`Switched to the ${label} theme.`, [{ type: 'setTheme', theme }], [`Theme → ${label}`]);
    }
  }
  return null;
}

// --- overlays --------------------------------------------------------------

function matchOverlay(lower: string): AssistantPlan | null {
  if (/\bcommand palette\b/.test(lower)) {
    return commandPlan('Command palette open.', [{ type: 'openOverlay', overlay: 'commandPalette' }], ['Opened command palette']);
  }
  if (/\b(keyboard )?shortcuts\b/.test(lower)) {
    return commandPlan('Here are the keyboard shortcuts.', [{ type: 'openOverlay', overlay: 'shortcuts' }], ['Opened shortcuts help']);
  }
  // "notifications page" is the full route; bare "notifications" is the drawer,
  // which is the faster surface for a glance.
  if (/\bnotifications?\b/.test(lower) && !/\b(page|screen|all)\b/.test(lower)) {
    return commandPlan('Notifications open.', [{ type: 'openOverlay', overlay: 'notifications' }], ['Opened notification centre']);
  }
  return null;
}

// --- layouts ---------------------------------------------------------------

function matchLayout(lower: string): AssistantPlan | null {
  // Require the word layout/preset — "options" and "research" are also a panel
  // and a route, and guessing wrong rearranges the user's whole workspace.
  if (!/\b(layout|preset|workspace layout)\b/.test(lower)) return null;
  for (const id of LAYOUT_IDS) {
    if (lower.includes(id)) {
      const name = id.charAt(0).toUpperCase() + id.slice(1);
      return commandPlan(`Applied the ${name} layout.`, [{ type: 'applyLayout', layoutId: id }], [`Layout → ${name}`]);
    }
  }
  return null;
}

// --- panels ----------------------------------------------------------------

function matchView(text: string): AssistantPlan | null {
  const lower = text.toLowerCase();
  // "hide the option chain" isn't meaningful for a tab — there's always exactly
  // one tab showing. Let those fall through rather than pretending to close it.
  if (new RegExp(`\\b${HIDE_VERB}\\b`).test(lower)) return null;

  for (const { view, label, aliases } of VIEW_ALIASES) {
    if (!aliases.some((a) => new RegExp(`\\b${a.replace(/-/g, '[- ]')}\\b`).test(lower))) continue;

    // Carry the symbol through when one was named ("show BANKNIFTY's chain"),
    // otherwise the tab opens on whatever instrument is already loaded.
    const sym = findSymbol(text);
    const params = new URLSearchParams();
    if (sym) params.set('symbol', sym.symbol);
    params.set('view', view);
    const href = `/trade?${params.toString()}`;

    const actions: AssistantAction[] = sym
      ? [{ type: 'selectSymbol', symbol: sym.symbol }, { type: 'navigate', href }]
      : [{ type: 'navigate', href }];

    return commandPlan(
      sym ? `${label} for ${sym.symbol}.` : `${label} is open.`,
      actions,
      [`Instrument view → ${label}`, `Opened ${href}`],
    );
  }
  return null;
}

function matchPanel(lower: string): AssistantPlan | null {
  const hidingIntent = new RegExp(`\\b${HIDE_VERB}\\b`).test(lower);
  const hasPanelWord = /\bpanel\b/.test(lower);

  for (const { panel, label, aliases, needsPanelWord } of PANEL_ALIASES) {
    if (needsPanelWord && !hasPanelWord) continue;
    if (!aliases.some((a) => new RegExp(`\\b${a.replace(/-/g, '[- ]')}\\b`).test(lower))) continue;

    return hidingIntent
      ? commandPlan(`Closed the ${label} panel.`, [{ type: 'hidePanel', panel }], [`Hid panel → ${label}`])
      : commandPlan(
          `${label} panel is open on the Trade workspace.`,
          [{ type: 'showPanel', panel }, { type: 'navigate', href: '/trade' }],
          [`Showed panel → ${label}`, 'Opened /trade'],
        );
  }
  return null;
}

// --- shell chrome ----------------------------------------------------------

function matchChrome(lower: string): AssistantPlan | null {
  if (/\b(collapse|expand|toggle|hide|show)\b.*\bsidebar\b/.test(lower) || /\bsidebar\b/.test(lower)) {
    return commandPlan('Toggled the sidebar.', [{ type: 'toggleSidebar' }], ['Toggled sidebar']);
  }
  if (/\bnew (workspace|tab)\b/.test(lower)) {
    return commandPlan('Created a new workspace tab.', [{ type: 'newWorkspaceTab' }], ['Added workspace tab']);
  }
  return null;
}

// --- navigation (derived from NAV_ITEMS) -----------------------------------

/**
 * Short names for pages whose sidebar LABEL is not what anyone calls them.
 *
 * ── THE CONTRADICTION THIS FIXES ───────────────────────────────────────────
 *
 * `matchNav` matches an item's label verbatim, and the Sentinel item is
 * labelled "AI Sentinel". So "open Sentinel" matched nothing, fell through
 * every resolver, and was refused by the remit fence as *outside what the
 * assistant covers* — while the Sentinel boundary's own refusal copy, the
 * capability reply and `TRADEW-ASSISTANT.md` §6 all instruct the user to say
 * exactly that phrase. The product told people to say a sentence the product
 * then declined.
 *
 * Keyed by href rather than by label so renaming a sidebar entry cannot
 * silently orphan its alias.
 */
const NAV_SHORT_NAMES: Record<string, readonly string[]> = {
  '/sentinel': ['sentinel'],
};

function matchNav(lower: string): AssistantPlan | null {
  // Longest label first so a two-word page can't be shadowed by a one-word one.
  const items = [...NAV_ITEMS].sort((a, b) => b.label.length - a.label.length);

  for (const item of items) {
    const label = item.label.toLowerCase();
    const names = [label, ...(NAV_SHORT_NAMES[item.href] ?? [])];
    if (!names.some((n) => new RegExp(`\\b${n}\\b`).test(lower))) continue;

    // Bare mention isn't a command — "how does the dashboard work" is a
    // question about the app, not a request to navigate. Require a verb, or
    // that the whole utterance is essentially just the page name.
    const hasVerb = new RegExp(`\\b${OPEN_VERB}\\b`).test(lower);
    const bare = lower.replace(/[^a-z\s]/g, '').trim();
    const isBareName = names.includes(bare);
    if (!hasVerb && !isBareName) continue;

    const actions: AssistantAction[] = [{ type: 'navigate', href: item.href }];
    const steps = [`Opened ${item.href}`];

    // Compound command: "open research and explain". The navigation half runs
    // now. Reading a PAGE back is still not a capability — what exists is a
    // market read against a named symbol (`matchAnalyze`), which is a different
    // thing — so say what is actually available rather than implying a
    // narration of this screen is coming.
    if (EXPLAIN_RE.test(lower)) {
      return {
        intent: 'command',
        reply: `Opened ${item.label}. I can't narrate a page back to you — what I can do is measure a market: say "analyse NIFTY" (or any symbol, on any timeframe) and I'll read you the real numbers.`,
        actions,
        steps: [...steps, 'Page narration → not a capability; market analysis is per-symbol'],
      };
    }

    return commandPlan(`Opened ${item.label}.`, actions, steps);
  }
  return null;
}

// --- bare symbol -----------------------------------------------------------

function matchSymbol(text: string): AssistantPlan | null {
  const lower = text.toLowerCase();
  const hasVerb = new RegExp(`\\b${OPEN_VERB}\\b`).test(lower);
  const wantsChart = /\bchart\b/.test(lower);
  if (!hasVerb && !wantsChart) return null;

  const sym = findSymbol(text);
  if (!sym) return null;

  const href = `/trade?symbol=${encodeURIComponent(sym.symbol)}`;
  return commandPlan(
    `Opened ${sym.symbol}.`,
    [{ type: 'selectSymbol', symbol: sym.symbol }, { type: 'navigate', href }],
    [`Resolved symbol → ${sym.symbol}`, `Opened ${href}`],
  );
}
