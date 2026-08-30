import type { MarketSnapshot } from '../intelligence/market-intelligence.service';

/**
 * The information a strategy actually decides on — and nothing else.
 *
 * ## The problem this solves
 *
 * `MarketSnapshot` carries nineteen fields. An observation that reports all
 * nineteen has said nothing about which of them mattered, so "why did it
 * enter?" is answered with a data dump the reader has to re-derive the
 * decision from. Worse, an agent that *weighs* all nineteen is weighing
 * fifteen it has no thesis about: an opening-range breakout does not become
 * more or less valid because the put-call ratio is 1.06, and letting that
 * number move the decision is how a strategy stops being a strategy.
 *
 * So a strategy DECLARES the evidence keys it is made of (see
 * `StrategyDefinition.evidenceKeys`), and this module reads exactly those.
 * The output is the intent's `evidence` column and the console's "important
 * observations" list. An evidence item that is not in a strategy's declaration
 * is never read, never stored and never weighed.
 *
 * ## Provenance
 *
 * Every reader below names the `knowledge-base/` concept it is an application
 * of, by that concept's own `id`. That is the chain the audit asks for:
 *
 *     knowledge-base/<domain>/<concept>.yaml
 *       → EVIDENCE_READERS[key].concept
 *         → StrategyDefinition.evidenceKeys
 *           → ExecutionIntent.evidence
 *             → the decision
 *
 * The ids are checked against the loaded ontology by
 * `evidence-provenance.spec.ts`, so a typo or a renamed concept fails a test
 * rather than silently producing an evidence item that cites nothing.
 *
 * ## What a reader may NOT do
 *
 * It may not decide. Every reader returns a measurement and a stance
 * (`supports` / `opposes` / `neutral`) RELATIVE TO A GIVEN DIRECTION, and the
 * strategy engine's own rules remain the thing that decides. This module makes
 * the reasoning legible; it does not do the reasoning.
 */

export type EvidenceStance = 'supports' | 'opposes' | 'neutral';

export interface EvidenceItem {
  /** Stable key — what a strategy declares and what the console groups by. */
  id: string;
  label: string;
  /** The `knowledge-base/` concept id this reading applies. */
  concept: string;
  /** The measurement itself, as a number where one exists. */
  value: number | null;
  /** The measurement in words, with real numbers in it. */
  detail: string;
  /** Relative to the direction being evaluated. */
  stance: EvidenceStance;
  /**
   * 0..1 — how much this reading should count for THIS strategy. Set by the
   * strategy's own declaration, not by the reader: the same VWAP reading is
   * decisive for a VWAP-pullback strategy and incidental for a sweep.
   */
  weight: number;
}

export interface EvidenceRead {
  items: EvidenceItem[];
  /** Items that point against the direction being evaluated. */
  opposing: EvidenceItem[];
  /** Declared keys that could not be read at all, with the reason. */
  unavailable: { id: string; reason: string }[];
  /** Weighted share of the readable, non-neutral evidence that supports. */
  supportRatio: number;
  summary: string;
}

type Direction = 'bullish' | 'bearish';

interface Reading {
  value: number | null;
  detail: string;
  stance: EvidenceStance;
}

interface EvidenceReader {
  label: string;
  concept: string;
  /** Null when the snapshot cannot supply this reading at all. */
  read: (s: MarketSnapshot, direction: Direction) => Reading | null;
}

/** Helper: does a signed measurement point the way `direction` does? */
function stanceOf(signed: number, direction: Direction, deadband = 0): EvidenceStance {
  if (Math.abs(signed) <= deadband) return 'neutral';
  const bullish = signed > 0;
  return bullish === (direction === 'bullish') ? 'supports' : 'opposes';
}

/**
 * Every reading the platform can produce, keyed by what a strategy declares.
 *
 * ONE map, so a strategy cannot declare a key that has no reader (asserted in
 * `strategy-engine.spec.ts`) and a reader cannot exist that no strategy can
 * reach. The alternative — readers scattered across strategies — is how two
 * strategies end up with two subtly different definitions of "volume
 * confirmed".
 */
export const EVIDENCE_READERS: Record<string, EvidenceReader> = {
  // ---------------------------------------------------------------- trend
  'index-trend': {
    label: 'Index trend',
    concept: 'trend',
    read: (s, d) => {
      const t = s.trendAnalysis;
      if (!t) return null;
      const signed = t.direction === 'bullish' ? t.momentumScore : t.direction === 'bearish' ? -t.momentumScore : 0;
      return {
        value: Number(t.sessionChangePct.toFixed(3)),
        detail: `Session ${t.sessionChangePct >= 0 ? '+' : ''}${t.sessionChangePct.toFixed(2)}%, momentum ${t.momentumScore.toFixed(2)}, reading ${t.direction}.`,
        stance: stanceOf(signed, d, 0.2),
      };
    },
  },

  'ema-alignment': {
    label: 'EMA alignment',
    concept: 'moving-average',
    read: (s, d) => {
      if (s.ema20 == null || s.ema50 == null || !(s.lastPrice > 0)) return null;
      const spreadPct = ((s.ema20 - s.ema50) / s.ema50) * 100;
      const priceSide = s.lastPrice > s.ema20 ? 1 : -1;
      const stackSide = s.ema20 > s.ema50 ? 1 : -1;
      // Only a fully aligned stack takes a side; a price on the wrong side of
      // its own fast EMA is a pullback, and calling that "opposes" would make
      // every healthy retracement look like contrary evidence.
      const signed = priceSide === stackSide ? stackSide * Math.abs(spreadPct) : 0;
      return {
        value: Number(spreadPct.toFixed(4)),
        detail: `EMA20 ${s.ema20.toFixed(2)} is ${spreadPct >= 0 ? '+' : ''}${spreadPct.toFixed(2)}% against EMA50 ${s.ema50.toFixed(2)}; price ${s.lastPrice > s.ema20 ? 'above' : 'below'} EMA20.`,
        stance: stanceOf(signed, d, 0.01),
      };
    },
  },

  'market-structure': {
    label: 'Market structure',
    concept: 'swing-point',
    read: (s, d) => {
      const p = s.marketProfile;
      if (!p) return null;
      const signed = p.trend === 'bullish' ? 1 : p.trend === 'bearish' ? -1 : 0;
      return {
        value: null,
        detail: `${p.type} — ${p.structure}, ${p.trend}, ${p.volatility} volatility.`,
        stance: stanceOf(signed, d),
      };
    },
  },

  // ------------------------------------------------------------- levels
  'vwap-position': {
    label: 'VWAP position',
    concept: 'vwap',
    read: (s, d) => {
      if (s.vwap == null || !(s.vwap > 0) || !(s.lastPrice > 0)) return null;
      const distPct = ((s.lastPrice - s.vwap) / s.vwap) * 100;
      return {
        value: Number(distPct.toFixed(4)),
        detail: `Price is ${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}% against VWAP ${s.vwap.toFixed(2)}.`,
        stance: stanceOf(distPct, d, 0.05),
      };
    },
  },

  'opening-range': {
    label: 'Opening range',
    concept: 'range-expansion',
    read: (s, d) => {
      if (!s.openingRange || !(s.lastPrice > 0)) return null;
      const { high, low } = s.openingRange;
      const signed = s.lastPrice > high ? 1 : s.lastPrice < low ? -1 : 0;
      return {
        value: Number((high - low).toFixed(2)),
        detail:
          signed === 0
            ? `Price ${s.lastPrice.toFixed(2)} is inside the opening range ${low.toFixed(2)}–${high.toFixed(2)}.`
            : `Price ${s.lastPrice.toFixed(2)} is ${signed > 0 ? 'above the high' : 'below the low'} of the opening range ${low.toFixed(2)}–${high.toFixed(2)}.`,
        stance: stanceOf(signed, d),
      };
    },
  },

  'support-resistance': {
    label: 'Support / resistance',
    concept: 'support-and-resistance',
    read: (s, d) => {
      if (s.support == null || s.resistance == null || !(s.lastPrice > 0)) return null;
      const span = s.resistance - s.support;
      if (!(span > 0)) return null;
      // Where in its own range price sits, as -1 (at support) .. +1 (at
      // resistance). Near the top of a range is bullish for continuation and
      // is exactly what a reversal strategy would read as opposing — which is
      // why the stance is always relative to the direction asked about.
      const position = ((s.lastPrice - s.support) / span) * 2 - 1;
      return {
        value: Number(position.toFixed(3)),
        detail: `Price ${s.lastPrice.toFixed(2)} sits ${(((position + 1) / 2) * 100).toFixed(0)}% up the ${s.support.toFixed(2)}–${s.resistance.toFixed(2)} range.`,
        stance: stanceOf(position, d, 0.2),
      };
    },
  },

  'cpr-position': {
    label: 'CPR position',
    concept: 'support-and-resistance',
    read: (s, d) => {
      if (!s.cpr || !(s.lastPrice > 0)) return null;
      const signed = s.lastPrice > s.cpr.tc ? 1 : s.lastPrice < s.cpr.bc ? -1 : 0;
      return {
        value: Number(s.cpr.pivot.toFixed(2)),
        detail:
          signed === 0
            ? `Price ${s.lastPrice.toFixed(2)} is inside the central pivot range ${s.cpr.bc.toFixed(2)}–${s.cpr.tc.toFixed(2)}.`
            : `Price ${s.lastPrice.toFixed(2)} is ${signed > 0 ? 'above the top' : 'below the bottom'} of the central pivot range.`,
        stance: stanceOf(signed, d),
      };
    },
  },

  // ------------------------------------------------------------ participation
  'volume-confirmation': {
    label: 'Volume confirmation',
    concept: 'volume-confirmation',
    read: (s, d) => {
      if (s.volumeVsAvg == null) return null;
      // Volume has no direction of its own. It CONFIRMS whatever direction is
      // being evaluated when it is above average, and withholds confirmation
      // when it is thin — it never opposes, because thin volume is an absence
      // of evidence rather than evidence against.
      const strong = s.volumeVsAvg >= 1.1;
      const thin = s.volumeVsAvg < 0.6;
      return {
        value: Number(s.volumeVsAvg.toFixed(3)),
        detail: `Last bar traded ${(s.volumeVsAvg * 100).toFixed(0)}% of the 20-bar average volume.`,
        stance: strong ? 'supports' : thin ? 'opposes' : 'neutral',
      };
    },
  },

  'momentum-rsi': {
    label: 'Momentum (RSI)',
    concept: 'relative-strength-index',
    read: (s, d) => {
      if (s.rsi14 == null) return null;
      const signed = s.rsi14 - 50;
      return {
        value: Number(s.rsi14.toFixed(2)),
        detail: `RSI(14) at ${s.rsi14.toFixed(1)}${s.rsi14 >= 70 ? ' — stretched' : s.rsi14 <= 30 ? ' — stretched' : ''}.`,
        stance: stanceOf(signed, d, 5),
      };
    },
  },

  'momentum-macd': {
    label: 'Momentum (MACD)',
    concept: 'moving-average',
    read: (s, d) => {
      if (s.macdHistogram == null) return null;
      return {
        value: Number(s.macdHistogram.toFixed(4)),
        detail: `MACD histogram ${s.macdHistogram >= 0 ? '+' : ''}${s.macdHistogram.toFixed(2)}.`,
        stance: stanceOf(s.macdHistogram, d),
      };
    },
  },

  // -------------------------------------------------- exhaustion / reversal
  'momentum-exhaustion': {
    label: 'Momentum exhaustion',
    concept: 'relative-strength-index',
    read: (s, d) => {
      if (s.rsi14 == null) return null;
      // The mirror of `momentum-rsi`, and the reason both exist: a reversal
      // strategy wants a stretched RSI AGAINST the direction it is taking, and
      // reading that through `momentum-rsi` would score it as opposing
      // evidence when it is the whole thesis.
      const overbought = s.rsi14 >= 70;
      const oversold = s.rsi14 <= 30;
      const supportsShort = overbought && d === 'bearish';
      const supportsLong = oversold && d === 'bullish';
      return {
        value: Number(s.rsi14.toFixed(2)),
        detail: overbought
          ? `RSI(14) at ${s.rsi14.toFixed(1)} — overbought.`
          : oversold
            ? `RSI(14) at ${s.rsi14.toFixed(1)} — oversold.`
            : `RSI(14) at ${s.rsi14.toFixed(1)} — not stretched in either direction.`,
        stance: supportsShort || supportsLong ? 'supports' : overbought || oversold ? 'opposes' : 'neutral',
      };
    },
  },

  'volatility-regime': {
    label: 'Volatility regime',
    concept: 'volatility',
    read: (s) => {
      if (s.realizedVolPct == null && s.vix == null) return null;
      const parts: string[] = [];
      if (s.realizedVolPct != null) parts.push(`realized ${s.realizedVolPct.toFixed(2)}%`);
      if (s.vix != null) parts.push(`India VIX ${s.vix.toFixed(2)}`);
      return {
        // Volatility is context, never a direction. Reported so the journal
        // can ask "did this strategy only work in calm markets?" — it is never
        // scored for or against a side.
        value: s.realizedVolPct != null ? Number(s.realizedVolPct.toFixed(3)) : s.vix,
        detail: `Volatility: ${parts.join(', ')}.`,
        stance: 'neutral',
      };
    },
  },

  // ----------------------------------------------------------- positioning
  'option-pcr': {
    label: 'Put-call OI ratio',
    concept: 'put-call-ratio',
    read: (s, d) => {
      const oc = s.optionChain;
      if (!oc) return null;
      // PCR above 1 = more put OI outstanding, conventionally read as support
      // beneath the market. Deadbanded hard because a PCR of 1.02 is noise.
      const signed = oc.pcr - 1;
      return {
        value: Number(oc.pcr.toFixed(3)),
        detail: `Front-expiry put-call OI ratio ${oc.pcr.toFixed(2)} across ${oc.strikesAnalysed} strikes.`,
        stance: stanceOf(signed, d, 0.15),
      };
    },
  },

  'option-oi-walls': {
    label: 'Open-interest walls',
    concept: 'open-interest',
    read: (s, d) => {
      const oc = s.optionChain;
      if (!oc || !(s.lastPrice > 0)) return null;
      const call = oc.callOIWall;
      const put = oc.putOIWall;
      if (call == null && put == null) return null;
      // Distance to the nearer wall in the direction of travel: a call wall
      // just overhead is resistance to a bullish read, a put wall just below
      // is support for one.
      const toCall = call != null ? call - s.lastPrice : null;
      const toPut = put != null ? s.lastPrice - put : null;
      const roomAhead = d === 'bullish' ? toCall : toPut;
      const roomBehind = d === 'bullish' ? toPut : toCall;
      const detail =
        `Call OI wall ${call != null ? call.toFixed(0) : 'none'}, put OI wall ${put != null ? put.toFixed(0) : 'none'}, ` +
        `spot ${s.lastPrice.toFixed(2)}.`;
      if (roomAhead == null) return { value: null, detail, stance: 'neutral' };
      // `roomAhead` and `roomBehind` are ALREADY measured in the direction
      // being evaluated, so the comparison is direction-free: more room ahead
      // than behind supports the case whichever way it points. Passing this
      // through `stanceOf` would re-apply the direction a second time and
      // invert the reading for every bearish evaluation.
      const signed = roomBehind == null ? roomAhead : roomAhead - roomBehind;
      return {
        value: Number(roomAhead.toFixed(2)),
        detail,
        stance: signed > 0 ? 'supports' : signed < 0 ? 'opposes' : 'neutral',
      };
    },
  },

  'option-max-pain': {
    label: 'Max pain',
    concept: 'max-pain',
    read: (s, d) => {
      const oc = s.optionChain;
      if (!oc || !(s.lastPrice > 0) || !(oc.maxPain > 0)) return null;
      // Max pain is a pull TOWARD the strike, so it supports a direction when
      // that direction points at it from where price currently is.
      const signed = oc.maxPain - s.lastPrice;
      return {
        value: Number(oc.maxPain.toFixed(2)),
        detail: `Max pain sits at ${oc.maxPain.toFixed(0)}, ${Math.abs(signed).toFixed(0)} points ${signed >= 0 ? 'above' : 'below'} spot.`,
        stance: stanceOf(signed, d, s.lastPrice * 0.001),
      };
    },
  },

  'oi-trend': {
    label: 'Open-interest trend',
    concept: 'open-interest',
    read: (s) => {
      if (s.oiTrend === 'unknown') return null;
      return {
        value: null,
        detail: `Open interest is ${s.oiTrend}.`,
        // Rising OI confirms participation in whatever is happening; it does
        // not name a side. Reported as context.
        stance: 'neutral',
      };
    },
  },

  'market-breadth': {
    label: 'Market breadth',
    concept: 'market-breadth',
    read: (s, d) => {
      if (s.breadthRatio == null) return null;
      const signed = s.breadthRatio - 1;
      return {
        value: Number(s.breadthRatio.toFixed(3)),
        detail: `Advance-decline ratio ${s.breadthRatio.toFixed(2)}.`,
        stance: stanceOf(signed, d, 0.1),
      };
    },
  },
};

/** Every key a strategy is allowed to declare. */
export const EVIDENCE_KEYS = Object.keys(EVIDENCE_READERS);

/**
 * Read exactly the evidence a strategy declares, for one direction.
 *
 * `weights` lets a strategy say which of its own declared readings are
 * load-bearing and which are supporting. Absent, every declared key counts 1.
 */
export function readEvidence(
  snapshot: MarketSnapshot,
  direction: Direction,
  keys: string[],
  weights: Record<string, number> = {},
): EvidenceRead {
  const items: EvidenceItem[] = [];
  const unavailable: { id: string; reason: string }[] = [];

  for (const key of keys) {
    const reader = EVIDENCE_READERS[key];
    if (!reader) {
      // A declaration naming a reader that does not exist is a definition bug,
      // and it must be visible rather than silently dropping the evidence the
      // strategy believes it is deciding on.
      unavailable.push({ id: key, reason: 'No reader is registered for this evidence key.' });
      continue;
    }
    const reading = reader.read(snapshot, direction);
    if (!reading) {
      unavailable.push({ id: key, reason: `${reader.label} could not be read from this snapshot.` });
      continue;
    }
    items.push({
      id: key,
      label: reader.label,
      concept: reader.concept,
      value: reading.value,
      detail: reading.detail,
      stance: reading.stance,
      weight: weights[key] ?? 1,
    });
  }

  const opposing = items.filter((i) => i.stance === 'opposes');
  const supporting = items.filter((i) => i.stance === 'supports');
  const decided = supporting.reduce((s, i) => s + i.weight, 0) + opposing.reduce((s, i) => s + i.weight, 0);
  const supportRatio = decided > 0 ? supporting.reduce((s, i) => s + i.weight, 0) / decided : 0;

  return {
    items,
    opposing,
    unavailable,
    supportRatio,
    summary:
      decided === 0
        ? `None of the ${keys.length} declared evidence readings took a side.`
        : `${supporting.length} of ${supporting.length + opposing.length} decided readings support the ${direction} case ` +
          `(${(supportRatio * 100).toFixed(0)}% by weight)` +
          (opposing.length ? `; against it: ${opposing.map((o) => o.label).join(', ')}.` : ' with nothing against.'),
  };
}
