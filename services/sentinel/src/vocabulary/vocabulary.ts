/**
 * Module 10 — User Messages & Vocabulary Rules.
 *
 * Sentinel never tells a trader what to do; it describes what the market is
 * doing. `@tradew/ai-core`'s CORE_GUARDRAILS constrain the *prompt*; this
 * module constrains the *output*, so a model that ignores its instructions
 * still cannot emit a directive through Sentinel. Deterministic composition
 * paths run through the same enforcer, so both halves obey one rule set.
 *
 * See SENTINEL_MASTER_PLAN.md §2 rule 6 and §4 Module 10.
 */

import { MarketStateValue } from '../domain';

/**
 * Directive phrasings that must never reach a user, each paired with the
 * observational phrasing that replaces it. Order matters: longer, more
 * specific patterns are listed first so they win over the generic verb.
 */
const REWRITES: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\bhigh[- ]conviction\b/gi, replacement: 'high-corroboration' },
  { pattern: /\bstrong buy\b/gi, replacement: 'bullish side in focus' },
  { pattern: /\bstrong sell\b/gi, replacement: 'bearish side in focus' },
  { pattern: /\bno trades today\b/gi, replacement: 'low confidence; wait and watch' },
  { pattern: /\bbook (?:your )?profits?\b/gi, replacement: 'the move appears largely complete' },
  { pattern: /\bcut (?:your )?loss(?:es)?\b/gi, replacement: 'the setup has invalidated' },
  // The article is folded into these two so the rewrite stays grammatical
  // ("a stop-loss" → "an invalidation level", not "a invalidation level").
  { pattern: /\ba stop[- ]loss at\b/gi, replacement: 'an invalidation level near' },
  { pattern: /\bstop[- ]loss at\b/gi, replacement: 'invalidation level near' },
  { pattern: /\b(?:price )?targets?\s+(?:of|at|is|:)\s*/gi, replacement: 'projected range near ' },
  { pattern: /\byou should (?:buy|sell|enter|exit|short|long)\b/gi, replacement: 'the market is showing' },
  { pattern: /\b(?:go|going) long\b/gi, replacement: 'bullish side in focus' },
  { pattern: /\b(?:go|going) short\b/gi, replacement: 'bearish side in focus' },
  { pattern: /\bexit (?:your )?position\b/gi, replacement: 'momentum is weakening' },
  { pattern: /\benter (?:a |the )?(?:trade|position|long|short)\b/gi, replacement: 'the structure is developing' },
  // Subject-verb agreement matters here: a naive "recommend* → observes"
  // yields "I observes", which reads as a bug in a compliance-critical string.
  { pattern: /\b(?:I|we)\s+recommend\b/gi, replacement: 'Sentinel observes' },
  { pattern: /\brecommends\b/gi, replacement: 'observes' },
  { pattern: /\brecommended\b/gi, replacement: 'observed' },
  { pattern: /\brecommending\b/gi, replacement: 'observing' },
  { pattern: /\brecommendations?\b/gi, replacement: 'observations' },
  { pattern: /\brecommend\b/gi, replacement: 'observe' },
  { pattern: /\badvice\b/gi, replacement: 'observation' },
  { pattern: /\b(?:buy|sell)\s+(?:now|immediately|here)\b/gi, replacement: 'side in focus' },
  { pattern: /\btargets?\b/gi, replacement: 'projected level' },
  { pattern: /\bstop[- ]?loss\b/gi, replacement: 'invalidation level' },
  { pattern: /\bbuying opportunity\b/gi, replacement: 'bullish structure' },
  { pattern: /\bselling opportunity\b/gi, replacement: 'bearish structure' },
  // Bare imperatives, last so the phrase rules above get first refusal.
  //
  // "short" is excluded when it is the adjective rather than the verb.
  // `\bshort\b` matches inside "short-term" — the hyphen is a word boundary —
  // so "the short-term trend reference" was being rewritten into "the
  // observe-term trend reference", which is visibly broken English reaching a
  // trader. The lookahead covers the compound adjectives that actually occur
  // in market prose; "short the index" still rewrites, which is the case the
  // rule exists for.
  { pattern: /\b(?:buy|sell)\b/gi, replacement: 'observe' },
  { pattern: /\bshort\b(?!([- ](?:term|dated|lived|side|squeeze|interest|covering)))/gi, replacement: 'observe' },
  { pattern: /\bexit\b/gi, replacement: 'close of the move' },
];

/**
 * Terms whose presence in output is a hard compliance failure.
 *
 * Carries the same "short" exclusion as the rewrite table above, and must: a
 * legitimate "short-term" surviving enforcement would otherwise be reported as
 * a residual breach, and SentinelIntelligence's synthesis gate fails CLOSED on
 * that probe — so the mismatch would silently withhold correct observations.
 */
const FORBIDDEN_PROBE =
  /\b(buy|sell|exit|target|stop[- ]?loss|recommend\w*|short\b(?!([- ](?:term|dated|lived|side|squeeze|interest|covering))))\b/i;

export interface VocabularyCheck {
  clean: string;
  /** phrases that had to be rewritten — surfaced for the audit trail */
  violations: string[];
}

/**
 * Rewrite directive language into observational language. Returns the cleaned
 * text plus every phrase that had to be changed, so the compliance trail
 * records that an enforcement actually happened.
 */
export function enforceVocabulary(text: string): VocabularyCheck {
  const violations: string[] = [];
  let clean = text;
  for (const { pattern, replacement } of REWRITES) {
    clean = clean.replace(pattern, (match) => {
      violations.push(match);
      return replacement;
    });
  }
  // Collapse whitespace the substitutions may have doubled up.
  clean = clean.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;])/g, '$1');
  return { clean, violations };
}

/** True when the text still contains directive vocabulary after enforcement. */
export function hasDirectiveLanguage(text: string): boolean {
  return FORBIDDEN_PROBE.test(text);
}

/**
 * The allowed status vocabulary, keyed by market state. These are the only
 * headlines Sentinel ever puts in front of a trader.
 */
export const STATUS_PHRASES: Record<MarketStateValue, string> = {
  PRE_MARKET: 'Pre-market — session has not opened',
  OBSERVATION: 'Observing — building session context',
  MARKET_UNDERSTANDING: 'Market structure forming',
  STRATEGY_DETECTION: 'Setup forming — rules partially confirmed',
  VALIDATION: 'Validating setup against corroborating evidence',
  WAIT_AND_WATCH: 'Low confidence / choppy regime — wait and watch',
  SIDE_IN_FOCUS: 'Side in focus',
  OPPORTUNITY_ACTIVE: 'Structure confirmed and active',
  MOVE_DEVELOPING: 'Move developing',
  MOMENTUM_WEAKENING: 'Momentum weakening; price approaching a key level',
  MOVE_COMPLETE: 'Expected move largely complete',
  MARKET_CLOSE: 'Session closed — end-of-day review available',
};

/**
 * Directional status headline for a state that carries a bias.
 * `bias` describes the market, never the trader's action.
 */
export function statusHeadline(
  state: MarketStateValue,
  bias: 'bullish' | 'bearish' | 'neutral' = 'neutral',
): string {
  if (state === 'SIDE_IN_FOCUS' || state === 'OPPORTUNITY_ACTIVE' || state === 'MOVE_DEVELOPING') {
    if (bias === 'bullish') return 'Bullish side in focus';
    if (bias === 'bearish') return 'Bearish side in focus';
    return 'Structure developing — no side in focus';
  }
  return STATUS_PHRASES[state];
}
