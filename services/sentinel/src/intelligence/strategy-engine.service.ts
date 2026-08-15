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
  | 'wyckoff'
  | 'trend';

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
