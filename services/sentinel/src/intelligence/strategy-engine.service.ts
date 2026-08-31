/**
 * Module 2 — Strategy Engine.
 *
 * Sentinel does not invent arbitrary setups; it monitors the trader's own
 * strategy handbook. A strategy is declarative data — an id, a bias resolver,
 * a list of rule names from `strategy-rules.ts`, and a list of invalidation
 * rule names. The eight Master Plan strategies ship as built-ins; a trader
 * adds their own by dropping a YAML file into the strategy directory, with no
 * code change and no way to introduce arbitrary logic into the observe path.
 *
 * Detection is graded, not binary: a setup with some rules confirmed is a
 * *forming* setup (which drives the STRATEGY_DETECTION state), and only a
 * fully confirmed rule set with no invalidation is a validated match.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { join, resolve } from 'path';
import { StrategyMatch } from '../domain';
import { isWithinSession } from '../market-clock';
import { analyseStructure } from './market-structure';
import { MarketSnapshot, latestBarAt } from './market-intelligence.service';
import { STRATEGY_RULES, isKnownRule } from './strategy-rules';

/** How the engine derives which side the setup describes. */
export type BiasSource =
  | 'orb'
  | 'cpr'
  | 'vwap'
  | 'ema'
  | 'sweep'
  | 'failed-breakout'
  | 'structure'
  | 'swing-structure'
  | 'wyckoff'
  | 'trend';

/**
 * The regime vocabulary an agent strategy declares itself applicable in.
 *
 * These are `MarketProfile.structure`'s own four values, deliberately, rather
 * than a fifth vocabulary invented here — and rather than `MarketProfile.type`,
 * which has ten members. Ten buckets split the calibration sample ten ways and
 * most would never reach a usable sample size; four is coarse enough to
 * accumulate and fine enough to separate "works in a trend, fails in a range",
 * which is the distinction Master Plan Module 12 exists to capture.
 */
export type StrategyRegime = 'trending' | 'ranging' | 'consolidating' | 'breaking-out';

export interface StrategyDefinition {
  id: string;
  name: string;
  /** rule names, all of which must confirm for a validated match */
  rules: string[];
  /** rule names, any of which cancels the setup */
  invalidations: string[];
  /** IST window, 'HH:mm-HH:mm'; omitted means the whole session */
  idealSession?: string;
  /** 0..1 ceiling on this strategy's confidence contribution */
  baseConfidenceWeight: number;
  biasSource: BiasSource;
  enabled: boolean;
  /** where the definition came from, for the audit trail */
  source: 'built-in' | 'user-yaml';

  // ───────────────────────────────────────────────────────────────────────
  // AGENT METADATA (2026-08-30)
  //
  // Present only on the four strategies an autonomous paper agent may act on.
  // Every field below is OPTIONAL so the eight pre-existing built-ins and any
  // user YAML keep working untouched — and `agentTradable` defaulting to
  // absent is what makes the separation safe: a strategy is not agent-tradable
  // unless it says so, so no existing definition became one by this change.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * May an autonomous execution profile take a position on this strategy?
   *
   * The eight observation strategies are deliberately NOT tradable by an
   * agent. They were written to describe setups to a trader, so several are
   * built on bullish-only predicates (`price_above_vwap`, `ema_fast_above_slow`)
   * and none declares what would invalidate a POSITION as opposed to a setup.
   * Making them agent-tradable would ship an agent that can only ever buy
   * calls and has nothing to exit on.
   */
  agentTradable?: boolean;

  /**
   * Semantic version of the RULE SET.
   *
   * Load-bearing rather than decorative: `StrategyCalibration` is keyed on it,
   * so changing what a strategy means starts a fresh sample instead of
   * averaging the new rules' results with the old rules'. Bump the minor for a
   * changed threshold, the major for a changed rule list.
   */
  version?: string;

  /**
   * `knowledge-base/` concept ids this strategy is an application of.
   *
   * Checked against the loaded ontology by `strategy-knowledge.spec.ts`, so a
   * strategy cannot cite a concept the repository does not define. This is the
   * `knowledge → strategy` half of the provenance chain; the
   * `strategy → observation` half is `evidenceKeys`.
   */
  knowledgeConcepts?: string[];

  /**
   * The evidence this strategy decides on — see `execution/evidence.ts`.
   *
   * A closed declaration, not a hint: the evidence reader reads exactly these
   * and nothing else, so a signal absent from this list cannot influence this
   * strategy's trade and cannot appear in its intent record.
   */
  evidenceKeys?: string[];
  /** Per-key weighting, 0..1. Absent keys count 1. */
  evidenceWeights?: Record<string, number>;

  /** Regimes this strategy claims to work in. Empty means "any". */
  regimes?: StrategyRegime[];

  /** Underlyings this strategy may be run on. Empty means "any permitted". */
  instruments?: string[];

  /**
   * The share of decided evidence that must SUPPORT the direction before the
   * strategy is considered confirmed for execution. A second, evidence-level
   * gate on top of the rule set — the rules say the pattern is present, this
   * says the surrounding context is not fighting it.
   */
  minEvidenceSupport?: number;

  /**
   * What ends the POSITION, as opposed to what cancels the setup.
   *
   * `invalidations` answers "is this setup still valid?" and is evaluated
   * before entry. These are evaluated by the position manager for as long as
   * the position is open, and firing one is an exit. Kept separate because
   * they are genuinely different questions: a setup that has played out is not
   * invalid, and a position whose thesis is gone is not un-entered.
   */
  exitRules?: string[];

  /** One line, for the console and the journal. */
  purpose?: string;
}

/** Full detection detail — the wire shape plus the rule notes for "Why?". */
export interface StrategyDetection extends StrategyMatch {
  /** true only when every rule confirmed and nothing invalidated */
  validated: boolean;
  source: StrategyDefinition['source'];
}

const BUILT_IN_STRATEGIES: Omit<StrategyDefinition, 'source'>[] = [
  {
    id: 'orb-retest',
    name: 'Opening Range Breakout Retest',
    rules: ['orb_breakout', 'orb_retest', 'orb_retest_volume_lower'],
    invalidations: ['orb_reentry'],
    idealSession: '09:30-11:00',
    baseConfidenceWeight: 0.85,
    biasSource: 'orb',
    enabled: true,
  },
  {
    id: 'cpr-breakout-bounce',
    name: 'CPR Breakout / Bounce',
    rules: ['cpr_level_interaction', 'volume_supports_move'],
    invalidations: ['cpr_reentry'],
    baseConfidenceWeight: 0.8,
    biasSource: 'cpr',
    enabled: true,
  },
  {
    id: 'vwap-pullback',
    name: 'VWAP Pullback',
    rules: ['price_above_vwap', 'vwap_pullback_touch', 'pullback_volume_lower'],
    invalidations: ['vwap_lost_on_volume'],
    idealSession: '09:30-14:00',
    baseConfidenceWeight: 0.82,
    biasSource: 'vwap',
    enabled: true,
  },
  {
    id: 'ema-cross-bounce',
    name: 'EMA Cross & Bounce',
    rules: ['ema_fast_above_slow', 'price_at_ema_confluence', 'volume_supports_move'],
    invalidations: ['ema_fast_below_slow'],
    baseConfidenceWeight: 0.78,
    biasSource: 'ema',
    enabled: true,
  },
  {
    id: 'liquidity-sweep',
    name: 'Liquidity Sweep',
    rules: ['liquidity_sweep', 'sweep_volume_spike'],
    invalidations: ['sweep_not_reclaimed'],
    baseConfidenceWeight: 0.75,
    biasSource: 'sweep',
    enabled: true,
  },
  {
    id: 'fake-breakout',
    name: 'Fake Breakout / Bull & Bear Trap',
    rules: ['broke_key_level', 'breakout_failed', 'breakout_volume_fading'],
    invalidations: ['breakout_sustained'],
    idealSession: '09:15-11:30',
    baseConfidenceWeight: 0.8,
    biasSource: 'failed-breakout',
    enabled: true,
  },
  {
    id: 'ict-smart-money',
    name: 'ICT / Smart Money Concepts',
    rules: ['market_structure_shift', 'fair_value_gap', 'order_block_mitigated'],
    invalidations: ['structure_shift_invalidated'],
    idealSession: '09:30-14:00',
    baseConfidenceWeight: 0.7,
    biasSource: 'structure',
    enabled: true,
  },
  {
    id: 'wyckoff-spring-upthrust',
    name: 'Wyckoff Accumulation / Distribution',
    rules: ['wyckoff_spring_or_upthrust', 'range_bound_context'],
    invalidations: ['range_broken'],
    baseConfidenceWeight: 0.68,
    biasSource: 'wyckoff',
    enabled: true,
  },

  // ═════════════════════════════════════════════════════════════════════════
  // THE FOUR AGENT STRATEGIES (2026-08-30)
  //
  // Four rather than forty. Each one is a distinct thesis about WHY price
  // should move — structure turning over, a trend continuing, a range
  // expanding, a stretched move failing — and the four theses are mutually
  // exclusive by construction: at most one of them is the honest read of any
  // given market. Twenty variations on "the trend is up" would look like
  // twenty independent confirmations to a confidence engine and be one.
  //
  // They are NOT renamed copies of the eight above. Three differences, all
  // structural:
  //
  //  1. Every rule they use is DIRECTION-AGNOSTIC, so both CE and PE are
  //     reachable. The observation strategies lean on bullish-only predicates
  //     and an agent built on them could only ever buy calls.
  //  2. They declare `exitRules` — what ends the POSITION, which no
  //     observation strategy needed to have an opinion about.
  //  3. They declare their evidence, so the intent records what mattered
  //     rather than the whole snapshot.
  //
  // Every `knowledgeConcepts` entry is a real `knowledge-base/*/<id>.yaml`,
  // asserted by `strategy-knowledge.spec.ts`.
  // ═════════════════════════════════════════════════════════════════════════

  {
    id: 'agent-smc-structure-shift',
    name: 'Smart Money Structure Shift',
    purpose:
      'Take the side of a confirmed swing-structure break that displaced with participation and then returned into the order block it left behind.',
    // The four rules are the four things that distinguish an institutional
    // structure shift from a bar that happened to close through a level:
    // the break is confirmed on SWINGS, the bar that made it DISPLACED,
    // price returned to the origin of that move, and volume was there.
    rules: ['structure_break_confirmed', 'displacement_bar', 'order_block_mitigated', 'volume_supports_move'],
    // Structure turning over the other way, or the break simply failing back
    // inside the range it came from.
    invalidations: ['structure_reversed', 'structure_shift_invalidated'],
    exitRules: ['structure_reversed', 'structure_shift_invalidated'],
    baseConfidenceWeight: 0.86,
    biasSource: 'swing-structure',
    enabled: true,
    agentTradable: true,
    version: '1.0.0',
    knowledgeConcepts: [
      'swing-point',
      'trend',
      'institutional-order-flow',
      'liquidity',
      'volume-confirmation',
      'block-trade',
    ],
    evidenceKeys: [
      'market-structure',
      'index-trend',
      'ema-alignment',
      'volume-confirmation',
      'support-resistance',
      'option-oi-walls',
    ],
    evidenceWeights: { 'market-structure': 1.5, 'volume-confirmation': 1.2, 'option-oi-walls': 0.6 },
    regimes: ['trending', 'breaking-out'],
    minEvidenceSupport: 0.6,
  },

  {
    id: 'agent-trend-momentum',
    name: 'Trend Momentum Continuation',
    purpose:
      'Join an established, still-accelerating trend on the side the EMA stack and VWAP agree on, after a quiet pullback rather than into an extension.',
    rules: ['ema_stack_aligned', 'trend_momentum_confirmed', 'price_beyond_vwap', 'pullback_volume_lower'],
    invalidations: ['momentum_faded', 'vwap_reclaimed_against'],
    exitRules: ['momentum_faded', 'vwap_reclaimed_against', 'structure_reversed'],
    baseConfidenceWeight: 0.84,
    biasSource: 'ema',
    enabled: true,
    agentTradable: true,
    version: '1.0.0',
    knowledgeConcepts: ['trend', 'moving-average', 'vwap', 'volume-confirmation', 'market-breadth'],
    evidenceKeys: [
      'index-trend',
      'ema-alignment',
      'vwap-position',
      'momentum-macd',
      'momentum-rsi',
      'volume-confirmation',
      'market-breadth',
    ],
    evidenceWeights: { 'index-trend': 1.5, 'ema-alignment': 1.3, 'market-breadth': 0.6 },
    regimes: ['trending'],
    minEvidenceSupport: 0.65,
  },

  {
    id: 'agent-opening-range-expansion',
    name: 'Opening Range Expansion',
    purpose:
      'Take a decisive break of the opening range that is expanding the session range on real volume, rather than drifting through it.',
    rules: ['orb_breakout', 'session_range_expanding', 'volume_supports_move', 'price_beyond_vwap'],
    invalidations: ['orb_reentry'],
    exitRules: ['orb_reentry', 'momentum_faded'],
    // The opening-range thesis is about the first half of the session. After
    // noon a "breakout" of a range set five hours ago is a different claim,
    // and this strategy does not make it.
    idealSession: '09:30-12:00',
    baseConfidenceWeight: 0.82,
    biasSource: 'orb',
    enabled: true,
    agentTradable: true,
    version: '1.0.0',
    knowledgeConcepts: ['range-expansion', 'breakout', 'volume-confirmation', 'vwap', 'trend-day'],
    evidenceKeys: [
      'opening-range',
      'index-trend',
      'volume-confirmation',
      'vwap-position',
      'volatility-regime',
      'option-oi-walls',
    ],
    evidenceWeights: { 'opening-range': 1.5, 'volume-confirmation': 1.3 },
    regimes: ['breaking-out', 'trending'],
    minEvidenceSupport: 0.6,
  },

  {
    id: 'agent-exhaustion-reversal',
    name: 'Exhaustion Reversal',
    purpose:
      'Fade a stretched move that has run a 20-bar liquidity pool, been rejected on the bar that took it, and closed back through the level.',
    rules: ['liquidity_pool_swept', 'momentum_stretched', 'rejection_bar', 'sweep_volume_spike'],
    // A pool taken and NOT reclaimed is a genuine break, which is the exact
    // opposite of the thesis; and a range that has actually given way is no
    // longer a range to fade inside.
    invalidations: ['sweep_not_reclaimed', 'range_broken'],
    exitRules: ['sweep_not_reclaimed', 'range_broken', 'structure_reversed'],
    baseConfidenceWeight: 0.8,
    biasSource: 'sweep',
    enabled: true,
    agentTradable: true,
    version: '1.0.0',
    knowledgeConcepts: [
      'liquidity-sweep',
      'stop-loss-clustering',
      'relative-strength-index',
      'false-breakout',
      'max-pain',
    ],
    evidenceKeys: [
      'momentum-exhaustion',
      'support-resistance',
      'volume-confirmation',
      'market-structure',
      'option-max-pain',
      'volatility-regime',
    ],
    evidenceWeights: { 'momentum-exhaustion': 1.5, 'support-resistance': 1.2, 'option-max-pain': 0.8 },
    regimes: ['ranging', 'consolidating'],
    minEvidenceSupport: 0.6,
  },
];

@Injectable()
export class StrategyEngineService implements OnModuleInit {
  private readonly logger = new Logger(StrategyEngineService.name);
  private strategies: StrategyDefinition[] = BUILT_IN_STRATEGIES.map((s) => ({ ...s, source: 'built-in' }));

  onModuleInit(): void {
    this.loadUserStrategies();
  }

  /**
   * Scan every enabled strategy against the current snapshot.
   * Returns detections ordered strongest-first; a strategy with no confirmed
   * rules at all is omitted rather than reported as a zero-confidence match.
   *
   * `at` is the scan's own clock — a `/observe` poll or a watch sweep. It gates
   * `idealSession` and is reported as `observedAt`, but it is NOT the time a
   * detection describes: see `detectedAt` below.
   */
  scan(snapshot: MarketSnapshot, at: Date = new Date()): StrategyDetection[] {
    const detections: StrategyDetection[] = [];

    /**
     * Market-event time for everything this scan produces.
     *
     * Every rule is a pure function of `snapshot`, so the bar the snapshot ends
     * on is the market event a detection is about. Stamping detections with the
     * scan clock instead — which is what this did — meant a setup that formed
     * on the 09:42 bar was re-dated to whatever minute the dashboard last
     * polled, so the session timeline read as a burst of simultaneous setups at
     * the moment of the refresh rather than as the sequence the market actually
     * produced. Null only when the snapshot has no candles at all, and only
     * then does the scan clock stand in for market time.
     */
    const barAt = latestBarAt(snapshot);
    const detectedAt = (barAt ?? at).toISOString();
    const observedAt = at.toISOString();

    for (const def of this.strategies) {
      if (!def.enabled) continue;
      if (!isWithinSession(def.idealSession, at)) continue;

      const rulesMatched: string[] = [];
      const rulesUnmet: string[] = [];
      for (const ruleId of def.rules) {
        const rule = STRATEGY_RULES[ruleId];
        if (!rule) {
          rulesUnmet.push(`${ruleId}: rule not recognised`);
          continue;
        }
        const outcome = rule(snapshot);
        (outcome.ok ? rulesMatched : rulesUnmet).push(outcome.note);
      }

      const invalidationsTriggered: string[] = [];
      for (const ruleId of def.invalidations) {
        const rule = STRATEGY_RULES[ruleId];
        if (!rule) continue;
        const outcome = rule(snapshot);
        if (outcome.ok) invalidationsTriggered.push(outcome.note);
      }

      if (rulesMatched.length === 0) continue;

      const completeness = rulesMatched.length / Math.max(1, def.rules.length);
      const validated = rulesUnmet.length === 0 && invalidationsTriggered.length === 0;
      // An invalidated setup is still reported (the trader should see that it
      // fired and died) but its confidence is halved rather than zeroed, so
      // the Confidence Engine can weigh a partially-broken setup honestly.
      const penalty = invalidationsTriggered.length > 0 ? 0.5 : 1;
      const confidence = Math.round(def.baseConfidenceWeight * completeness * penalty * 100);

      detections.push({
        strategyId: def.id,
        strategyName: def.name,
        confidence,
        bias: resolveBias(def.biasSource, snapshot),
        rulesMatched,
        rulesUnmet,
        invalidationsTriggered,
        detectedAt,
        observedAt,
        validated,
        source: def.source,
      });
    }

    return detections.sort((a, b) => b.confidence - a.confidence);
  }

  /** Only the fully confirmed setups — what the Confidence Engine scores on. */
  validated(detections: StrategyDetection[]): StrategyDetection[] {
    return detections.filter((d) => d.validated);
  }

  getStrategies(): StrategyDefinition[] {
    return this.strategies.map((s) => ({ ...s }));
  }

  getStrategy(id: string): StrategyDefinition | undefined {
    const found = this.strategies.find((s) => s.id === id);
    return found ? { ...found } : undefined;
  }

  setStrategyEnabled(id: string, enabled: boolean): boolean {
    const strategy = this.strategies.find((s) => s.id === id);
    if (!strategy) return false;
    strategy.enabled = enabled;
    return true;
  }

  /**
   * The strategies an autonomous paper agent may take a position on.
   *
   * The filter is `agentTradable === true`, which no user YAML can set (see
   * `normaliseDefinition`) and which none of the eight observation strategies
   * declares. So the set an agent can act on is fixed in this file and cannot
   * be widened by dropping a file into the strategy directory — which matters,
   * because that directory is a deployment artefact and this is a permission.
   */
  agentStrategies(): StrategyDefinition[] {
    return this.strategies.filter((s) => s.agentTradable === true).map((s) => ({ ...s }));
  }

  /** One agent strategy by id, or null when it is not agent-tradable. */
  agentStrategy(id: string): StrategyDefinition | null {
    const found = this.strategies.find((s) => s.id === id && s.agentTradable === true);
    return found ? { ...found } : null;
  }

  /**
   * Read declarative strategies from the strategy directory. A file that
   * references an unknown rule is rejected outright and logged — silently
   * dropping the bad rule would leave the trader with a strategy that looks
   * configured but tests less than they wrote.
   */
  private loadUserStrategies(): void {
    const dir = resolveStrategyDir();
    if (!existsSync(dir)) {
      this.logger.log(`no user strategy directory at ${dir} — running the ${this.strategies.length} built-in strategies`);
      return;
    }

    let loaded = 0;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml') && !file.endsWith('.json')) continue;
      const fullPath = join(dir, file);
      if (!statSync(fullPath).isFile()) continue;
      try {
        const raw = parseYaml(readFileSync(fullPath, 'utf8')) as Record<string, unknown> | null;
        const def = normaliseDefinition(raw);
        if (!def) {
          this.logger.warn(`strategy file ${file} is missing required fields (id, name, rules) — skipped`);
          continue;
        }
        const unknown = [...def.rules, ...def.invalidations].filter((r) => !isKnownRule(r));
        if (unknown.length > 0) {
          this.logger.warn(`strategy ${def.id} references unknown rule(s): ${unknown.join(', ')} — skipped`);
          continue;
        }
        const existing = this.strategies.findIndex((s) => s.id === def.id);
        if (existing >= 0) this.strategies[existing] = def;
        else this.strategies.push(def);
        loaded++;
      } catch (err) {
        this.logger.warn(`could not read strategy file ${file}: ${err}`);
      }
    }
    this.logger.log(`loaded ${loaded} user strategy definition(s) from ${dir}`);
  }
}

/** Which side of the market the confirmed setup describes. Never an action. */
function resolveBias(source: BiasSource, s: MarketSnapshot): 'bullish' | 'bearish' | 'neutral' {
  const trend = s.trendAnalysis?.direction ?? 'neutral';
  const last = s.candles[s.candles.length - 1];

  switch (source) {
    case 'orb':
      if (!s.openingRange || !last) return trend;
      if (last.close > s.openingRange.high) return 'bullish';
      if (last.close < s.openingRange.low) return 'bearish';
      return 'neutral';
    case 'cpr':
      if (!s.cpr) return trend;
      if (s.lastPrice > s.cpr.tc) return 'bullish';
      if (s.lastPrice < s.cpr.bc) return 'bearish';
      return 'neutral';
    case 'vwap':
      if (s.vwap === null) return trend;
      return s.lastPrice > s.vwap ? 'bullish' : 'bearish';
    case 'ema':
      if (s.ema20 === null || s.ema50 === null) return trend;
      return s.ema20 > s.ema50 ? 'bullish' : 'bearish';
    case 'sweep':
      // A sweep is reclaimed against the direction of the probe.
      if (last && s.support !== null && last.low < s.support && last.close > s.support) return 'bullish';
      if (last && s.resistance !== null && last.high > s.resistance && last.close < s.resistance) return 'bearish';
      return 'neutral';
    case 'failed-breakout':
      // A failed upside breakout leaves the bearish side in focus, and vice versa.
      if (last && s.resistance !== null && last.close < s.resistance) return 'bearish';
      if (last && s.support !== null && last.close > s.support) return 'bullish';
      return 'neutral';
    case 'swing-structure': {
      // The swing engine's own read, not the session's. A structure-shift
      // strategy that took its side from `trendAnalysis` would name the
      // direction of the move it is claiming has just ENDED.
      if (s.candles.length < 10) return trend;
      const st = analyseStructure(s.candles);
      if (st.event && st.eventDirection) return st.eventDirection;
      if (st.state === 'uptrend') return 'bullish';
      if (st.state === 'downtrend') return 'bearish';
      return 'neutral';
    }
    case 'structure':
    case 'wyckoff':
    case 'trend':
    default:
      return trend;
  }
}

function normaliseDefinition(raw: Record<string, unknown> | null): StrategyDefinition | null {
  if (!raw) return null;
  // Accept both `strategy: {...}` (the Master Plan's shape) and a bare object.
  const body = (typeof raw.strategy === 'object' && raw.strategy !== null
    ? (raw.strategy as Record<string, unknown>)
    : raw) as Record<string, unknown>;

  const id = typeof body.id === 'string' ? body.id : null;
  const name = typeof body.name === 'string' ? body.name : null;
  const rules = Array.isArray(body.rules) ? body.rules.filter((r): r is string => typeof r === 'string') : [];
  if (!id || !name || rules.length === 0) return null;

  const invalidations = Array.isArray(body.invalidations)
    ? body.invalidations.filter((r): r is string => typeof r === 'string')
    : [];
  const weight = Number(body.base_confidence_weight ?? body.baseConfidenceWeight ?? 0.75);
  const biasSource = (body.bias_source ?? body.biasSource ?? 'trend') as BiasSource;

  return {
    id,
    name,
    rules,
    invalidations,
    idealSession: (body.ideal_session ?? body.idealSession) as string | undefined,
    baseConfidenceWeight: Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 0.75,
    biasSource,
    enabled: body.enabled !== false,
    source: 'user-yaml',
    // `agentTradable` is DELIBERATELY not read from the file, and this is a
    // permission boundary rather than an omission. The strategy directory is a
    // deployment artefact — a mounted volume, a file an operator can drop in —
    // so honouring the flag from there would mean a file on disk could grant
    // itself the right to place orders on a real user's paper account. The
    // four agent strategies are defined in this module, in code, under review.
    // A user YAML remains exactly what it has always been: an observation
    // strategy that surfaces in the workspace.
  };
}

/** `SENTINEL_STRATEGY_DIR`, else a `strategies/` folder beside the service. */
export function resolveStrategyDir(): string {
  const override = process.env.SENTINEL_STRATEGY_DIR;
  if (override) return resolve(override);

  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'strategies');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(__dirname, '../../strategies');
}
