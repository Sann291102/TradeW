import { INSTRUMENT_CATALOG } from './catalog';
import type { InstrumentRef } from './types';

/**
 * Resolve an instrument named anywhere inside a sentence.
 *
 * ── THE BUG THIS REPLACES ──────────────────────────────────────────────────
 *
 * `assistant/instruments.ts#findSymbol` searched `SYMBOL_UNIVERSE`, which was
 * assembled exclusively from the NSE mock sources. "Open BTC chart" therefore
 * matched nothing, fell through the whole command cascade, and was answered
 * with the analysis fallback — a sentence claiming the *analysis engine* was
 * unbuilt, when the actual failure was that the word "BTC" named nothing this
 * application could see. That resolver now delegates here, so every venue in
 * the catalog is reachable by the same grammar that already handled NIFTY.
 *
 * ── MATCH ORDER IS THE CONTRACT ────────────────────────────────────────────
 *
 * Longest form first, always. "bank nifty" must beat "nifty" or the assistant
 * silently opens the wrong instrument — the same class of bug the original file
 * documented, now applying across three more venues ("btc usdt" before "btc").
 */

export interface InstrumentMatch {
  ref: InstrumentRef;
  /** The literal text that matched — shown in the trace so the user can see
   *  which word the assistant keyed on when it picks the wrong instrument. */
  matched: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every (needle, instrument) pair the resolver will consider, sorted longest
 * needle first. Built once — this runs on every utterance.
 */
const NEEDLES: ReadonlyArray<{ needle: string; ref: InstrumentRef; isSymbol: boolean }> = (() => {
  const out: Array<{ needle: string; ref: InstrumentRef; isSymbol: boolean }> = [];
  for (const ref of INSTRUMENT_CATALOG) {
    out.push({ needle: ref.symbol.toLowerCase(), ref, isSymbol: true });
    for (const alias of ref.aliases) out.push({ needle: alias.toLowerCase(), ref, isSymbol: false });
  }
  return out.sort((a, b) => b.needle.length - a.needle.length);
})();

/**
 * Display names, considered only after symbols and aliases have all missed.
 *
 * Kept as a separate, later pass for the reason the original resolver gave:
 * short name fragments produce constant false positives, so a name must be
 * reasonably distinctive before it is allowed to decide which instrument the
 * user meant.
 */
const NAME_NEEDLES: ReadonlyArray<{ needle: string; ref: InstrumentRef }> = INSTRUMENT_CATALOG
  .map((ref) => ({ needle: ref.displayName.toLowerCase(), ref }))
  .filter((n) => n.needle.length >= 5)
  .sort((a, b) => b.needle.length - a.needle.length);

/**
 * Find the instrument named in `text`, across every venue.
 *
 * Word boundaries are required on both sides so "ITC" cannot match inside
 * "SWITCH" and "ADA" cannot match inside "CANADA" — the false-positive class
 * that gets worse, not better, as the catalog grows.
 */
export function resolveInstrument(text: string): InstrumentMatch | null {
  const lower = text.toLowerCase();

  for (const { needle, ref } of NEEDLES) {
    // A slash is not a word character, so "eur/usd" needs the boundary assertion
    // relaxed at any edge that is already punctuation.
    const pattern = `${/^\w/.test(needle) ? '\\b' : ''}${escapeRe(needle)}${/\w$/.test(needle) ? '\\b' : ''}`;
    if (new RegExp(pattern).test(lower)) return { ref, matched: needle };
  }

  for (const { needle, ref } of NAME_NEEDLES) {
    if (lower.includes(needle)) return { ref, matched: ref.displayName };
  }

  return null;
}

/**
 * Can this instrument satisfy a request that needs a real chart?
 *
 * The assistant calls this BEFORE navigating, so it can decline honestly
 * instead of arriving on an embed and reporting that it set a timeframe it
 * cannot reach. This is the smallest concrete piece of the verify-before-you-
 * claim rule: knowing a plan is unsatisfiable is cheaper than discovering it.
 */
export function chartCapability(ref: InstrumentRef): {
  canChart: boolean;
  canOperate: boolean;
  why: string | null;
} {
  if (ref.chartSurface === 'none') {
    return { canChart: false, canOperate: false, why: `There's no chart for ${ref.displayName}.` };
  }
  if (ref.chartSurface === 'embed') {
    return {
      canChart: true,
      canOperate: false,
      why:
        `${ref.displayName} charts through an embedded TradingView view, so I can show it to you ` +
        `but I can't set its timeframe or draw on it. Our own chart has no bars for it yet.`,
    };
  }
  return { canChart: true, canOperate: true, why: null };
}

/** Whether an interval is one this instrument's feed actually serves. */
export function supportsInterval(ref: InstrumentRef, interval: string): boolean {
  return (ref.supportedIntervals as readonly string[]).includes(interval);
}
