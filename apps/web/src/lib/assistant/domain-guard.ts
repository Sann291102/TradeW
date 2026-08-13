import { ASSISTANT_NAME } from './identity';
import { findSymbol } from './instruments';
import { refusalPlan, type AssistantPlan } from './types';

/**
 * The assistant's remit fence.
 *
 * ${ASSISTANT_NAME} answers ONLY about (a) this application and (b) markets — market
 * structure, market information, market news. Markets means all markets
 * (Indian equities/derivatives first, plus forex, commodities and crypto);
 * everything else is declined.
 *
 * ---------------------------------------------------------------------------
 * SCOPE OF THIS FILE — read before trusting it as a guardrail.
 *
 * This is a DETERMINISTIC PRE-FILTER, not a model guardrail. It is sufficient
 * for Phase 1 precisely because Phase 1 generates no free-form prose: an
 * utterance either resolves to a known in-app action, or it is parked/declined.
 * There is no path here that produces an LLM answer, so there is nothing for a
 * jailbreak to steer.
 *
 * The moment the analysis agents are wired in (Phase 2), this filter stops
 * being the boundary and becomes only the cheap first pass. The real
 * enforcement then has to live server-side in `services/api` /
 * `services/tradew-ai` — system prompt, output checks, refusal handling —
 * because anything client-side is editable by the user. Do NOT put Phase 2
 * generation behind this file alone.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Hard boundaries
// ---------------------------------------------------------------------------

/**
 * Sentinel's reasoning is the premium product (SUBSCRIPTIONS.md §3, and the
 * 2026-07-26 direction call). The assistant will happily NAVIGATE to Sentinel
 * — that's just a route — but it does not narrate, summarise or explain what
 * Sentinel is doing or why. Paraphrasing Sentinel's output through the free
 * assistant would give away the thing users pay for.
 */
const SENTINEL_RE = /\bsentinel\b/i;
const SENTINEL_EXPLAIN_RE =
  /\b(explain|why|what'?s|whats|what is|what are|tell me|summari[sz]e|interpret|break down|reasoning|thinking|doing|flagged|detected|observing|observation|observations|insight|insights)\b/i;

/** Asking the assistant to transact. Never available, not even gated. */
const ORDER_INTENT_RE =
  /\b(place|execute|submit|punch|fire|modify|cancel|square[\s-]?off|exit)\b[^.?!]*\b(order|orders|position|positions|trade|trades)\b/i;
/**
 * Imperative "buy…" / "sell…". Deliberately NOT including "long"/"short",
 * which are far more often adjectives ("long-term view", "short covering")
 * than commands. The lookahead keeps "open buy/sell panel" navigable.
 *
 * ── WHY THIS IS NOT ANCHORED TO THE START OF THE UTTERANCE ─────────────────
 *
 * It was, and that left a hole. The planner's refusal-poisoning rule protects
 * "open the chart THEN buy 50 lots" — a strong connective splits the utterance
 * and the fragment "buy 50 lots" is anchored, so the whole plan is refused.
 * But a bare "and" only splits when a verb the *grammar* knows follows it, and
 * "buy" is deliberately not one of those verbs. So "show me the fvg and buy 50
 * lots" never split, never matched, and executed its innocent half while
 * silently dropping the order — the precise outcome the poisoning rule exists
 * to prevent, reached by the one phrasing that skipped both mechanisms.
 *
 * Found by a test written for the detection commands, which are what made the
 * innocent half executable in the first place. The fix is to anchor after a
 * connective as well as at the start; the lookahead is unchanged, so "open
 * buy/sell panel" still navigates.
 */
const IMPERATIVE_TRADE_RE =
  /(?:^\s*|[;,]\s*|\b(?:and|then|also|plus)\s+)(buy|sell)\b(?!\s*(\/|or\s+)?(sell|buy)?\s*(panel|ticket|pad|form|button|side|window|screen))/i;

/** Asking for a decision rather than an observation. */
const ADVICE_RE = new RegExp(
  [
    String.raw`\bshould i\b`,
    String.raw`\bwhat should i (buy|sell|trade|do)\b`,
    String.raw`\b(is|are) it (a )?(good|bad) (buy|sell|time|entry)\b`,
    String.raw`\b(recommend|recommendation|advice|advise)\b`,
    // NOTE: "call"/"put" are deliberately absent here — "24300 call for
    // 21st July" is a contract reference, not a request for a tip, and an
    // earlier draft of this pattern refused it.
    String.raw`\b(tips?|sure ?shot|jackpot|multibagger)\b`,
    String.raw`\bgive me a (tip|call|trade|target)\b`,
    String.raw`\b(guaranteed|assured|confirmed) (profit|return|gain)`,
    String.raw`\bwill (it|this|nifty|the market|price|prices) (go|move|rise|fall|crash) `,
    String.raw`\b(entry|exit) (price|point|level)s? (for|to|in)\b`,
  ].join('|'),
  'i',
);

// ---------------------------------------------------------------------------
// In-domain vocabulary
// ---------------------------------------------------------------------------

/**
 * Market-domain terms.
 *
 * Bare everyday words that happen to be market words ("open", "close",
 * "high", "low", "range") are deliberately EXCLUDED — with "open" on the list
 * every "open the pod bay doors" counted as in-domain, which made the fence
 * meaningless. The specific forms ('ohlc', 'gap up') carry the same signal
 * without the false positives.
 */
const MARKET_TERMS = [
  // structure & technicals
  'market', 'markets', 'chart', 'charts', 'candle', 'candlestick', 'support', 'resistance',
  'trend', 'trendline', 'breakout', 'breakdown', 'consolidat', 'volatility', 'volume',
  'momentum', 'ema', 'sma', 'vwap', 'rsi', 'macd', 'bollinger', 'pivot', 'fibonacci',
  'gap up', 'gap down', 'ohlc', 'timeframe', 'price action', 'trading range',
  'intraday', 'swing', 'scalp', 'setup', 'setups', 'liquidity', 'order flow', 'depth',
  // instruments & segments
  'stock', 'stocks', 'equity', 'equities', 'index', 'indices', 'option', 'options', 'strike',
  'expiry', 'future', 'futures', 'derivative', 'premium', 'greeks', 'delta',
  'theta', 'gamma', 'vega', 'implied volatility', 'open interest', 'pcr',
  'max pain', 'lot size', 'etf', 'commodity', 'commodities', 'gold', 'silver', 'crude',
  'currency', 'forex', 'usdinr', 'eurusd', 'crypto', 'bitcoin', 'ethereum',
  // exchanges, regulators, macro
  'nse', 'bse', 'mcx', 'sebi', 'rbi', 'nifty', 'sensex', 'banknifty', 'vix',
  'fii', 'dii', 'earnings', 'results', 'dividend', 'ipo', 'buyback', 'bonus',
  'inflation', 'cpi', 'gdp', 'repo rate', 'interest rate', 'fomc', 'monetary policy',
  'bond', 'yield', 'sector', 'sectoral', 'largecap', 'midcap', 'smallcap', 'valuation',
  'pe ratio', 'fundamentals', 'balance sheet', 'news', 'sentiment', 'macro',
  // portfolio & risk (observation side)
  'portfolio', 'holding', 'holdings', 'position', 'positions', 'pnl', 'drawdown',
  'exposure', 'hedge', 'risk', 'margin', 'brokerage', 'charges', 'paper trade', 'backtest',
] as const;

/** Short acronyms — matched case-sensitively as whole words to avoid firing on
 *  ordinary text ("oi" inside a word, "IV" vs "iv"). */
const MARKET_ACRONYMS = ['IV', 'OI', 'FX', 'BTC', 'ETH', 'P&L', 'CE', 'PE'] as const;

/** App-domain terms — surfaces, features, settings, how-to. */
const APP_TERMS = [
  'tradew', 'app', 'application', 'platform', 'dashboard', 'workspace', 'panel', 'panels',
  'layout', 'preset', 'watchlist', 'blotter', 'order ticket', 'option chain', 'terminal',
  'trade', 'trading', 'research', 'learning', 'knowledge', 'notification', 'notifications',
  'settings', 'profile', 'theme', 'dark mode', 'light mode', 'sidebar', 'shortcut',
  'shortcuts', 'command palette', 'subscription', 'plan', 'plans', 'upgrade', 'trial',
  'login', 'sign in', 'sign up', 'account', 'broker', 'dhan', 'feature', 'features',
  'how do i', 'where is', 'what can you do', 'help', 'screen', 'page',
] as const;

function hasTerm(lower: string, terms: readonly string[]): boolean {
  return terms.some((term) =>
    /^[a-z]+$/.test(term) ? new RegExp(`\\b${term}\\b`).test(lower) : lower.includes(term),
  );
}

/** True when the utterance is about markets or about this application. */
export function isInDomain(text: string): boolean {
  const lower = text.toLowerCase();
  if (hasTerm(lower, MARKET_TERMS)) return true;
  if (hasTerm(lower, APP_TERMS)) return true;
  if (MARKET_ACRONYMS.some((a) => new RegExp(`\\b${a.replace('&', '\\&')}\\b`).test(text))) return true;
  // A bare instrument name is unambiguously in-domain ("RELIANCE?").
  if (findSymbol(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const CAPABILITY_HINT =
  'I can open any screen, chart or contract for you ("open NIFTY 24300 call of 21st July"), rearrange your workspace, and answer questions about the markets or about TradeW.';

/**
 * Boundaries that must hold no matter how the request is phrased. Runs BEFORE
 * command resolution, so a prohibited request can't slip through by happening
 * to match a command pattern.
 */
export function guardHardBoundaries(text: string): AssistantPlan | null {
  const lower = text.toLowerCase();

  if (ORDER_INTENT_RE.test(lower) || IMPERATIVE_TRADE_RE.test(text)) {
    return refusalPlan(
      "I can't place, modify or cancel orders — that's deliberate, not a missing feature. Order entry always stays in your hands on the Trade screen. I can open the order ticket on the contract you want, and you take it from there.",
      'order-boundary',
    );
  }

  if (SENTINEL_RE.test(lower) && SENTINEL_EXPLAIN_RE.test(lower)) {
    return refusalPlan(
      "Sentinel's analysis is the premium product, so I don't relay or explain what it's doing — that's for you to read there directly. Say \"open Sentinel\" and I'll take you to it.",
      'sentinel-boundary',
    );
  }

  if (ADVICE_RE.test(lower)) {
    return refusalPlan(
      "I don't give trade calls, targets or buy/sell advice — I describe what the market is doing and leave the decision with you. Ask me what the structure looks like, where the levels sit, or what the data shows, and I'll go deep on that.",
      'advice-boundary',
    );
  }

  return null;
}

/**
 * The remit fence. Runs only AFTER command resolution has already failed —
 * a resolved in-app command is in-domain by construction, and checking this
 * first would refuse legitimate commands whose wording happens to carry no
 * market vocabulary.
 */
export function guardDomain(text: string): AssistantPlan | null {
  if (isInDomain(text)) return null;
  return refusalPlan(
    `That's outside what I cover — I only handle the markets and this application. ${CAPABILITY_HINT}`,
    'out-of-domain',
  );
}
