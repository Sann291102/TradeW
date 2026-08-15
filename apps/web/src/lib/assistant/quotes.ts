import { findSymbol } from './instruments';

/**
 * Price/quote questions — the first analysis-adjacent thing the assistant can
 * actually answer.
 *
 * ── WHY THIS IS NOT "PHASE 2" ──────────────────────────────────────────────
 *
 * The router used to park every non-command utterance with "my analysis engine
 * isn't wired up yet". That is the right answer for "is this a good entry" or
 * "read this chart" — those need the reasoning agents. It was the WRONG answer
 * for "what is NIFTY 50 trading at", because that is not analysis at all: it is
 * a lookup against `GET /market-data/quotes`, the same endpoint the ticker and
 * IndexOverview already poll. Telling a user the app cannot tell them a number
 * it is simultaneously rendering three times on screen is a bug, not a boundary.
 *
 * So this module handles FACT RETRIEVAL only. It reports last price, change,
 * the day's range and the market phase. It does not interpret them — no trend
 * call, no support/resistance, no "looks strong". That line is what keeps this
 * inside `TRADEW-AI.md` §4: reporting a number the exchange (or our own engine)
 * produced is an observation; saying what the number means is the analysis
 * agents' job, and saying what to do about it is nobody's.
 *
 * ── PROVENANCE IS PART OF THE ANSWER ───────────────────────────────────────
 *
 * `LiveQuote.source` is per-row and genuinely varies — NIFTY comes back
 * `simulated` while RELIANCE comes back `dhan` on the same request. A price
 * quoted without saying which of those it is would be the exact failure the
 * repo already fixed once for candles (`fix/no-fabricated-candles`): plausible
 * numbers presented as market truth. Every answer this module formats therefore
 * carries its source and its timestamp, and simulated rows say so in words
 * rather than in a field name the user never sees.
 */

/** How the user asked, which decides how much of the quote to read back. */
export type QuoteAsk =
  /** "what is X trading at" — last price and change. */
  | 'price'
  /** "what is X's day range / high / low" — adds OHL. */
  | 'range'
  /** "how much volume" — adds volume. */
  | 'volume';

export interface QuoteQuestion {
  symbols: string[];
  ask: QuoteAsk;
}

/**
 * Phrases that make an utterance a quote lookup. Deliberately narrow: this runs
 * AFTER command resolution but BEFORE the analysis fallback, so anything it
 * claims is something it must be able to answer completely. A vague match here
 * turns a question the analysis agents should own into a bare number.
 */
const PRICE_RE =
  /\b(price|prices|quote|quotes|ltp|last traded|trading at|trading now|how much (?:is|are)|what.?s? (?:the )?(?:price|rate|level|value)|where (?:is|are|.s)\b.*\b(?:trading|at|now)|current level|spot)\b/i;

/**
 * Note what is NOT here: a bare `open`. "open nifty chart" is the single most
 * common navigation command in the grammar, and matching the verb as though it
 * meant the opening price made `resolveQuoteQuestion` claim it. The router
 * happens to run command resolution first so nothing broke in practice — but a
 * classifier that is only correct because of what runs before it is one
 * reordering away from being wrong. The opening price is asked for as
 * "opening", "open price" or "day's open".
 */
const RANGE_RE =
  /\b(range|high|low|highs|lows|ohlc|opening|open price|day.?s? (?:high|low|range|open))\b/i;

const VOLUME_RE = /\b(volume|traded quantity|turnover)\b/i;

/**
 * Utterances that LOOK like price questions but are asking for a judgement.
 * These must fall through to the analysis fallback — answering "is NIFTY
 * expensive" with a last price would be dodging the question, and answering it
 * properly is advice this system does not give.
 */
const JUDGEMENT_RE =
  /\b(should|worth|good|bad|cheap|expensive|overbought|oversold|target|entry|exit|buy|sell|hold|forecast|predict|will (?:it|nifty|this)|going to)\b/i;

/**
 * Extract every instrument named in the text, in order, up to `limit`.
 *
 * `findSymbol` returns only the first match, which is right for "open X" but
 * wrong here — "price of nifty and banknifty" is one reasonable question with
 * two answers. This walks the string, removing each match before searching
 * again so the same symbol cannot be reported twice.
 */
export function findSymbols(text: string, limit = 3): string[] {
  const out: string[] = [];
  let rest = text;

  for (let i = 0; i < limit; i++) {
    const hit = findSymbol(rest);
    if (!hit) break;
    if (!out.includes(hit.symbol)) out.push(hit.symbol);
    // Remove the matched phrase (case-insensitively, first occurrence only) so
    // the next pass sees the remainder rather than looping on the same hit.
    const idx = rest.toLowerCase().indexOf(hit.matched.toLowerCase());
    if (idx === -1) break;
    rest = rest.slice(0, idx) + ' ' + rest.slice(idx + hit.matched.length);
  }

  return out;
}

/**
 * Classify an utterance as a quote lookup, or return null to let it fall
 * through to the analysis fallback.
 */
export function resolveQuoteQuestion(text: string): QuoteQuestion | null {
  // A judgement request is never a quote lookup, even when it names a price.
  if (JUDGEMENT_RE.test(text)) return null;

  const wantsRange = RANGE_RE.test(text);
  const wantsVolume = VOLUME_RE.test(text);
  if (!PRICE_RE.test(text) && !wantsRange && !wantsVolume) return null;

  const symbols = findSymbols(text);
  if (symbols.length === 0) return null;

  return { symbols, ask: wantsVolume ? 'volume' : wantsRange ? 'range' : 'price' };
}
