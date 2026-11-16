/**
 * The decision engine — the single fork point above backtest and paper/live.
 *
 *     Market Data → Feature Core → Setup Engine → Level Deriver
 *                                                      ↓
 *                                            Decision + 1:3 Filter
 *                                               ↓            ↓
 *                                           Backtest    Paper/Live
 *
 * `scanForCandidates` IS that fork. A backtest calls it per historical bar; the
 * live scanner calls it per poll. Both hand it a `MarketSnapshot` and both get
 * back the same `TradeCandidate[]`. Nothing below this line knows which caller
 * it has, and that is the property that makes a backtest result a statement
 * about the strategy the engine actually runs.
 *
 * ## What this function will not do
 *
 * It does not size a position, debit a wallet, pick an option strike or place
 * an order. Those are the execution layer's, and they differ per venue. It
 * also never lowers a threshold to produce a result: an empty array is a
 * correct and common answer, and it means the market offered nothing.
 */

import { atr } from './indicators';
import { analyseStructure } from './market-structure';
import { deriveLevels } from './levels';
import {
  AGENT_SETUPS,
  detectSetups,
  type SetupDefinition,
  type SetupDetection,
} from './setups';
import {
  buildExplanation,
  extractFeatures,
  isMeaningfulCandidate,
  type RejectionReason,
  type TradeCandidate,
} from './decision';
import { latestBarAt, type MarketSnapshot } from './snapshot';

export interface ScanContext {
  market: string;
  symbol: string;
  timeframe: string;
  /** Wall clock of the scan. Injected so a replay is deterministic. */
  now: Date;
  /**
   * IST minute-of-day, for `idealSession`. Supplied by the caller because the
   * session clock is a venue fact and this package holds no venue knowledge —
   * a 24/7 crypto scan passes null and session windows simply do not apply.
   */
  istMinuteOfDay: number | null;
  /** Minimum bars before any setup may be judged. */
  minCandles?: number;
  /** Restrict the scan. Defaults to the whole agent catalogue. */
  catalogue?: readonly SetupDefinition[];
}

/** 'HH:mm-HH:mm' → [startMinute, endMinute], or null when unparseable. */
function parseSession(window: string): [number, number] | null {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return [start, end];
}

/**
 * Decide one detection. Split out so the ordering of the gates is visible in
 * one place and testable on its own.
 *
 * The order is deliberate: cheap structural disqualifications first, then the
 * rules, then the levels. A setup refused for the wrong regime should say so
 * rather than reporting whichever level check happened to fail second.
 */
function judge(
  detection: SetupDetection,
  snapshot: MarketSnapshot,
  ctx: ScanContext,
): { accepted: boolean; reason: RejectionReason | null; detail: string | null; plan: ReturnType<typeof deriveLevels> | null } {
  const { setup } = detection;

  const regime = snapshot.marketProfile?.structure ?? null;
  if (regime && setup.regimes.length > 0 && !setup.regimes.includes(regime as never)) {
    return {
      accepted: false,
      reason: 'regime-unsuitable',
      detail: `${setup.name} declares itself for ${setup.regimes.join('/')} and the session is reading ${regime}.`,
      plan: null,
    };
  }

  if (setup.idealSession && ctx.istMinuteOfDay !== null) {
    const window = parseSession(setup.idealSession);
    if (window && (ctx.istMinuteOfDay < window[0] || ctx.istMinuteOfDay > window[1])) {
      const hh = Math.floor(ctx.istMinuteOfDay / 60).toString().padStart(2, '0');
      const mm = (ctx.istMinuteOfDay % 60).toString().padStart(2, '0');
      return {
        accepted: false,
        reason: 'outside-ideal-session',
        detail: `${setup.name} applies between ${setup.idealSession} IST and it is ${hh}:${mm}.`,
        plan: null,
      };
    }
  }

  // Defence in depth. A long-only setup's own rules cannot confirm on a
  // bearish read, so this should be unreachable — but "should be unreachable"
  // is exactly what stops being true when someone edits a rule list, and the
  // failure it would cause is an engine quietly shorting on a rule set that
  // was only ever measured long.
  if (
    (setup.directionality === 'long-only' && detection.bias === 'bearish') ||
    (setup.directionality === 'short-only' && detection.bias === 'bullish')
  ) {
    return {
      accepted: false,
      reason: 'direction-not-supported',
      detail: `${setup.name} is ${setup.directionality} and its bias resolved ${detection.bias}.`,
      plan: null,
    };
  }

  if (detection.invalidated.length > 0) {
    return {
      accepted: false,
      reason: 'setup-invalidated',
      detail: detection.invalidated.map((i) => i.note).join('; '),
      plan: null,
    };
  }

  if (!detection.validated) {
    return {
      accepted: false,
      reason: 'setup-not-validated',
      detail: detection.unmet.map((u) => u.note).join('; '),
      plan: null,
    };
  }

  const outcome = deriveLevels(setup, detection.bias, snapshot);
  if (!outcome.ok) {
    return { accepted: false, reason: outcome.reason, detail: outcome.detail, plan: outcome };
  }

  return { accepted: true, reason: null, detail: null, plan: outcome };
}

/**
 * Scan one snapshot and return every candidate worth recording.
 *
 * Accepted candidates come first, then near-misses by quality. The caller
 * takes the first accepted one it can execute; the rest are journal rows.
 */
export function scanForCandidates(
  snapshot: MarketSnapshot,
  ctx: ScanContext,
): TradeCandidate[] {
  const minCandles = ctx.minCandles ?? 40;
  const volatility = atr(snapshot.candles);
  const features = extractFeatures(snapshot, volatility);
  // Structure is computed once here rather than inside `extractFeatures`,
  // which has no candle budget of its own.
  features.structureState =
    snapshot.candles.length >= 10 ? analyseStructure(snapshot.candles).state : null;

  const barAt = latestBarAt(snapshot);

  // Too little history is a fact about the DATA, not about any one setup, so
  // it produces a single row rather than one per setup saying the same thing.
  if (snapshot.candles.length < minCandles) {
    const detail =
      `${snapshot.candles.length} closed bars available, ${minCandles} required before any setup may be judged.`;
    return [
      {
        market: ctx.market,
        symbol: ctx.symbol,
        timeframe: ctx.timeframe,
        decidedAt: ctx.now,
        signalBarAt: barAt,
        setupId: '-',
        setupName: 'Pre-flight',
        setupVersion: '-',
        archetype: 'signal-bar',
        bias: 'neutral',
        direction: null,
        quality: 0,
        confirmed: [],
        unmet: [],
        invalidated: [],
        regime: snapshot.marketProfile?.structure ?? null,
        features,
        plan: null,
        accepted: false,
        rejectionReason: 'insufficient-history',
        rejectionDetail: detail,
        explanation: `Did not scan ${ctx.symbol}: ${detail}`,
      },
    ];
  }

  const detections = detectSetups(snapshot, ctx.catalogue ?? AGENT_SETUPS);
  const candidates: TradeCandidate[] = [];

  for (const detection of detections) {
    if (!isMeaningfulCandidate(detection)) continue;

    const verdict = judge(detection, snapshot, ctx);
    const plan = verdict.plan && verdict.plan.ok ? verdict.plan.plan : null;

    candidates.push({
      market: ctx.market,
      symbol: ctx.symbol,
      timeframe: ctx.timeframe,
      decidedAt: ctx.now,
      signalBarAt: barAt,
      setupId: detection.setup.id,
      setupName: detection.setup.name,
      setupVersion: detection.setup.version,
      archetype: detection.setup.archetype,
      bias: detection.bias,
      direction: plan?.direction ?? null,
      quality: detection.quality,
      confirmed: detection.confirmed,
      unmet: detection.unmet,
      invalidated: detection.invalidated,
      regime: snapshot.marketProfile?.structure ?? null,
      features,
      plan,
      accepted: verdict.accepted,
      rejectionReason: verdict.reason,
      rejectionDetail: verdict.detail,
      explanation: buildExplanation({
        setupName: detection.setup.name,
        direction: plan?.direction ?? null,
        symbol: ctx.symbol,
        confirmed: detection.confirmed,
        invalidated: detection.invalidated,
        unmet: detection.unmet,
        plan,
        accepted: verdict.accepted,
        rejectionReason: verdict.reason,
        rejectionDetail: verdict.detail,
      }),
    });
  }

  return candidates.sort((a, b) => {
    if (a.accepted !== b.accepted) return a.accepted ? -1 : 1;
    return b.quality - a.quality;
  });
}

/** The first candidate the engine would actually trade, if any. */
export function firstAcceptable(candidates: TradeCandidate[]): TradeCandidate | null {
  return candidates.find((c) => c.accepted) ?? null;
}
