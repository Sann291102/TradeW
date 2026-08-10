/**
 * Stage 1 of the request pipeline: understanding (`TRADEW-ASSISTANT.md` §9).
 *
 * Pure and deterministic. Classification decides whether a request costs an
 * LLM round-trip at all, so it must be fast, free and testable — the same
 * reasoning that made the browser-side command resolver deterministic
 * (`apps/web/src/lib/assistant/router.ts`).
 *
 * This is the SERVER's classifier. The browser has its own for navigation, and
 * the two overlap deliberately: the browser one makes "open NIFTY" instant,
 * this one exists because the browser's can be bypassed. Anything reaching the
 * API is classified here regardless of what the client claimed.
 */

export type ServerIntent =
  /** Resolvable to an app action; the client executes it, no reasoning needed. */
  | 'command'
  /** A market/app question for the specialist agents. */
  | 'analysis'
  /** Outside the assistant's remit, or across a hard boundary. */
  | 'refusal'
  /** "What can you do" — answered from a fixed capability description. */
  | 'capability';

export type Specialist =
  | 'technical'
  | 'options'
  | 'news'
  | 'portfolio'
  | 'learning'
  | 'general';

export type RefusalReason =
  | 'advice-boundary'
  | 'order-boundary'
  | 'sentinel-boundary'
  | 'out-of-domain';

export interface Classification {
  intent: ServerIntent;
  specialist: Specialist;
  refusalReason?: RefusalReason;
  /** True when the utterance points at whatever the user is looking at. */
  needsPageContext: boolean;
}

// ---------------------------------------------------------------------------
// Hard boundaries — checked before anything else
// ---------------------------------------------------------------------------

/**
 * Requests for a trade decision. Refused at classification so no such question
 * ever reaches a model — cheaper and more reliable than generating an answer
 * and having the output gate catch it, though the output gate still runs.
 */
/**
 * Requests for a trade decision.
 *
 * Assembled from named parts rather than one long literal: the last group was
 * added after a live probe got through, and a pattern this load-bearing needs
 * to be readable enough that the next gap is visible on inspection.
 */
const ADVICE_PATTERNS = [
  // "Should I buy…", "what should I do"
  String.raw`should i (buy|sell|short|exit|enter|hold|book|add|average)`,
  String.raw`what should i (buy|sell|do|trade)`,
  String.raw`tell me what to (buy|sell|trade)`,
  String.raw`where (should|do) i (buy|sell|enter|exit)`,
  String.raw`which (stock|option|strike) (should|to) (i )?(buy|sell|pick)`,
  // Verdict-seeking. `is <anything> a good buy` — the natural phrasing names
  // the instrument ("is NIFTY a good buy here?"), not a pronoun.
  String.raw`is (it|this|that|[a-z]+) an? (good |strong |safe )?(buy|sell)\b`,
  String.raw`(buy|sell) or not`,
  String.raw`worth (buying|selling)`,
  // Asking for a call outright.
  String.raw`give me (a |some )?(call|tip|signal|trade)`,
  String.raw`any (tips?|calls?|signals?)`,
  // Asking for the trade PARAMETERS without ever saying "buy". "Give me an
  // entry, target and stop for NIFTY" is a signal request in every sense that
  // matters, and every pattern above missed it — found by a live probe against
  // the running API, not by review.
  String.raw`(give|tell|show|send|share) me (an? |the |your )?(entry|exit|target|stop.?loss|sl|trade|call|setup|level)`,
  // "what is the entry" as well as "what's the entry" — the uncontracted form
  // is the more common typed one, and the contracted-only pattern missed it.
  String.raw`what(?:'?s| is| are)?\s+(the|a|your|my)\s+(entry|exit|target|stop.?loss|sl)\b`,
  String.raw`\b(entry|target|stop.?loss|sl)\b[^.?!]{0,24}\b(and|or)\s+(target|stop.?loss|sl|exit|entry)\b`,
  String.raw`\b(entry|target|stop.?loss|sl)\b\s*,\s*[^.?!]{0,24}(target|stop.?loss|sl|exit|entry)\b`,
  // Level-seeking for a specific instrument.
  String.raw`entry (point|level) for`,
  String.raw`target (price )?for`,
  String.raw`stop.?loss for`,
];

const ADVICE_REQUEST = new RegExp(`\\b(?:${ADVICE_PATTERNS.join('|')})`, 'i');

/** Requests to transact. The assistant has no order capability at all. */
const ORDER_REQUEST =
  /\b(place|put|submit|execute|make|cancel|modify|square off|close)\s+(an?\s+|my\s+|the\s+)?(order|trade|position|buy|sell)\b|\b(buy|sell)\s+\d+\s+(shares?|lots?|qty)\b/i;

/** Sentinel's reasoning is the premium product; the assistant navigates to it, never narrates it. */
const SENTINEL_EXPLAIN = /\bsentinel\b/i;
const EXPLAIN_VERB = /\b(explain|summari[sz]e|what did|what does|tell me what|paraphrase|relay|interpret)\b/i;

// ---------------------------------------------------------------------------
// Other classes
// ---------------------------------------------------------------------------

const CAPABILITY =
  /\b(what can you do|what do you do|who are you|your capabilities|what are you able|how can you help|what should i ask)\b/i;

const COMMAND =
  /^\s*(open|show|go to|navigate|take me|switch|apply|hide|close|display|find|search|set|change)\b/i;

/**
 * Market/app vocabulary — the remit fence.
 *
 * Grouped rather than written as one literal so a gap is findable. The
 * order-mechanics group was added after "how does a target order work" — a
 * plain Learning Assistant question — fell through and was refused as
 * off-topic, which is a worse failure than answering it.
 */
const DOMAIN_VOCAB = [
  // instruments and indices
  'nifty', 'banknifty', 'bank nifty', 'finnifty', 'sensex', 'midcp',
  'market', 'markets', 'stock', 'stocks', 'share', 'shares', 'equity', 'index', 'indices',
  // derivatives
  'option', 'options', 'call', 'put', 'strike', 'expiry', 'premium', 'iv',
  'implied volatility', 'greeks?', 'delta', 'theta', 'vega', 'gamma', 'oi',
  'open interest', 'pcr', 'max pain', 'future', 'futures',
  // technicals
  'chart', 'candle', 'trend', 'support', 'resistance', 'breakout', 'volume', 'vwap',
  'ema', 'sma', 'rsi', 'macd', 'bollinger', 'fibonacci', 'pivot', 'gap',
  'breadth', 'advance decline',
  // participants, venues, regulators
  'fii', 'dii', 'sector', 'nse', 'bse', 'mcx', 'sebi', 'rbi',
  // book and performance
  'portfolio', 'holding', 'position', 'p&l', 'pnl', 'profit', 'loss',
  'trade', 'trading', 'trader', 'broker', 'margin', 'leverage',
  // fundamentals
  'dividend', 'earnings', 'results', 'quarterly', 'balance sheet', 'valuation',
  'pe ratio', 'market cap', 'news',
  // regimes and other asset classes
  'rally', 'correction', 'volatility', 'vix', 'crypto', 'bitcoin', 'forex',
  'commodity', 'gold', 'silver', 'crude',
  // price movement verbs — "why did RELIANCE fall" carries no other vocabulary
  'fell?', 'fall(ing|en)?', 'rose', 'rise', 'rising', 'drop(ped|ping)?',
  'jump(ed)?', 'surge[ds]?', 'slump(ed)?', 'crash(ed)?', 'gain(ed|s)?', 'declin(e|ed|ing)',
  // order mechanics — see the doc comment above
  'order', 'orders', 'entry', 'exit', 'target', 'stop.?loss', 'sl', 'limit',
  'square.?off', 'intraday', 'delivery', 'lot size', 'tick size', 'slippage', 'spread',
];

const IN_DOMAIN = new RegExp(`\\b(?:${DOMAIN_VOCAB.join('|')})\\b`, 'i');

/** The app itself is in domain too — "how do I change the theme". */
const APP_DOMAIN =
  /\b(tradew|this app|the app|dashboard|watchlist|workspace|panel|layout|sidebar|theme|settings|shortcut|command palette|learning|research|discipline|notification)\b/i;

/** Deictic references that only make sense against the active screen. */
const DEICTIC =
  /\b(this|that|these|those|it|here|current|the chart|on screen|i'?m looking at|in front of me)\b/i;

/**
 * A bare ticker makes a question in-domain: "Why did RELIANCE fall?" contains
 * no other market vocabulary, and refusing it as out-of-remit would be absurd.
 * Matched against the ORIGINAL casing, since that is what distinguishes a
 * ticker from a word. The stoplist keeps shouted ordinary English out.
 */
const TICKER_SHAPED = /\b[A-Z][A-Z0-9&-]{2,}\b/;
const NOT_TICKERS = new Set([
  'WHAT', 'WHY', 'HOW', 'WHEN', 'WHERE', 'WHO', 'THE', 'AND', 'FOR', 'ARE', 'YOU',
  'CAN', 'NOT', 'THIS', 'THAT', 'WITH', 'FROM', 'HAVE', 'DOES', 'DID', 'WAS',
]);

function mentionsTicker(text: string): boolean {
  const tokens = text.match(/\b[A-Z][A-Z0-9&-]{2,}\b/g) ?? [];
  return tokens.some((t) => !NOT_TICKERS.has(t));
}

// ---------------------------------------------------------------------------
// Specialist routing
// ---------------------------------------------------------------------------

const SPECIALIST_PATTERNS: Array<[Specialist, RegExp]> = [
  ['options', /\b(option|options|call|put|strike|expiry|premium|iv|implied volatility|greeks?|delta|theta|vega|gamma|oi|open interest|pcr|max pain|straddle|strangle|spread|writer|writing)\b/i],
  // `holdings` plural, and `holding`/`position` only behind a possessive:
  // "is NIFTY holding support" is a technical question, not a portfolio one,
  // and the bare noun form matched it.
  ['portfolio', /\b(portfolio|holdings|allocation|exposure|my (holding|position|trade|order|p&l|pnl)s?|p&l|pnl)\b/i],
  ['news', /\b(news|headline|announce|event|result|earnings|why (did|is|has).*(fall|rise|drop|jump|move|crash|rally)|what happened)\b/i],
  ['learning', /\b(what does .* mean|explain (the )?(concept|term)|how does .* work|teach|learn|definition|meaning of|difference between|what (is|are) (a|an|the)\b)/i],
  ['technical', /\b(chart|candle|trend|support|resistance|breakout|vwap|ema|sma|rsi|macd|bollinger|fibonacci|pivot|pattern|structure|level|momentum|volume|breadth)\b/i],
];

/**
 * Classify one utterance.
 *
 * Order is the contract: hard boundaries first so no phrasing can reach a
 * prohibited capability, capability question next, then commands, then the
 * remit fence, then analysis.
 */
export function classify(raw: string): Classification {
  const text = (raw ?? '').trim();
  const base = { needsPageContext: DEICTIC.test(text) };

  if (!text) {
    return { intent: 'capability', specialist: 'general', ...base };
  }

  if (ORDER_REQUEST.test(text)) {
    return { intent: 'refusal', specialist: 'general', refusalReason: 'order-boundary', ...base };
  }
  if (ADVICE_REQUEST.test(text)) {
    return { intent: 'refusal', specialist: 'general', refusalReason: 'advice-boundary', ...base };
  }
  if (SENTINEL_EXPLAIN.test(text) && EXPLAIN_VERB.test(text)) {
    return { intent: 'refusal', specialist: 'general', refusalReason: 'sentinel-boundary', ...base };
  }

  if (CAPABILITY.test(text)) {
    return { intent: 'capability', specialist: 'general', ...base };
  }

  if (COMMAND.test(text) && !IN_DOMAIN.test(text.replace(COMMAND, ''))) {
    return { intent: 'command', specialist: 'general', ...base };
  }

  const inDomain = IN_DOMAIN.test(text) || APP_DOMAIN.test(text) || mentionsTicker(text);
  // A deictic question ("explain this") is in-domain by construction: it
  // refers to a TradeW surface the user is looking at.
  if (!inDomain && !base.needsPageContext) {
    return { intent: 'refusal', specialist: 'general', refusalReason: 'out-of-domain', ...base };
  }

  if (COMMAND.test(text)) {
    return { intent: 'command', specialist: 'general', ...base };
  }

  return { intent: 'analysis', specialist: routeSpecialist(text), ...base };
}

/**
 * Asking about the state of something *right now* — never a concept question,
 * however definitional the phrasing looks.
 *
 * "What is a stop-loss order?" wants a definition. "What is the market doing?"
 * has the same opening four words and wants live analysis. Without this guard
 * the second routed to the concept explainer, which was visible in production
 * responses as `specialist: "learning"` on live market questions.
 */
const MARKET_STATE =
  /\b(doing|trading|moving|looking|performing|holding|behaving|today|right now|currently|at the moment|so far)\b/i;

/** Pick the specialist whose vocabulary the utterance most clearly sits in. */
export function routeSpecialist(text: string): Specialist {
  const asksAboutNow = MARKET_STATE.test(text);
  for (const [specialist, pattern] of SPECIALIST_PATTERNS) {
    if (specialist === 'learning' && asksAboutNow) continue;
    if (pattern.test(text)) return specialist;
  }
  return 'general';
}
