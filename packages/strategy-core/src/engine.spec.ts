import { describe, expect, it } from 'vitest';
import { firstAcceptable, scanForCandidates, type ScanContext } from './engine';
import { AGENT_SETUPS, evaluateSetup, unknownRuleNames } from './setups';
import { isMeaningfulCandidate } from './decision';
import {
  buildCandles,
  emaCrossLongFixture,
  emaCrossNoiseFloorFixture,
  risingSeries,
  snapshotFrom,
} from './fixtures';

const ctx = (over: Partial<ScanContext> = {}): ScanContext => ({
  market: 'CRYPTO',
  symbol: 'BTCUSDT',
  timeframe: '15m',
  now: new Date('2026-09-08T06:30:00.000Z'),
  istMinuteOfDay: 12 * 60,
  ...over,
});

describe('the setup catalogue', () => {
  it('references no rule the shared vocabulary does not define', () => {
    // A typo here would create a setup that can never validate, silently.
    expect(unknownRuleNames()).toEqual([]);
  });

  it('gives every setup a structural archetype and a version', () => {
    for (const setup of AGENT_SETUPS) {
      expect(setup.archetype).toBeTruthy();
      expect(setup.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(setup.rules.length).toBeGreaterThan(0);
      // The rule the old observation strategies broke: an agent-tradable setup
      // must declare what invalidates it, or it has nothing to exit on.
      expect(setup.invalidations.length).toBeGreaterThan(0);
      expect(setup.exitRules.length).toBeGreaterThan(0);
    }
  });

  it('carries the ported EMA-cross as an ordinary member, marked long-only', () => {
    const ported = AGENT_SETUPS.find((s) => s.id === 'agent-ema-cross');
    expect(ported).toBeDefined();
    expect(ported!.directionality).toBe('long-only');
    // No special standing: same shape, same required fields as the rest.
    expect(ported!.archetype).toBe('signal-bar');
    expect(ported!.enabled).toBe(true);
  });
});

describe('scanForCandidates', () => {
  it('detects a setup, derives levels and accepts it — with no Sentinel present', () => {
    const candidates = scanForCandidates(emaCrossLongFixture(), ctx());
    const taken = firstAcceptable(candidates);

    expect(taken).not.toBeNull();
    expect(taken!.setupId).toBe('agent-ema-cross');
    expect(taken!.accepted).toBe(true);
    expect(taken!.plan).not.toBeNull();
    expect(taken!.plan!.plannedRR).toBe(3);
    expect(taken!.rejectionReason).toBeNull();
  });

  it('writes an explanation built from the rules that actually fired', () => {
    const taken = firstAcceptable(scanForCandidates(emaCrossLongFixture(), ctx()));
    expect(taken).not.toBeNull();

    const why = taken!.explanation;
    expect(why).toContain('Entered long on BTCUSDT');
    // Each clause traces to a RuleOutcome note computed at decision time.
    expect(why).toMatch(/EMA20 .* is above EMA50/);
    expect(why).toMatch(/above VWAP/);
    expect(why).toMatch(/x the 20-bar average/);
    // …and to the structural anchor, not to a percentage of equity.
    expect(why).toContain('Signal bar low');
    expect(why).toContain('3R');
  });

  it('preserves the decision-time features on the record', () => {
    const taken = firstAcceptable(scanForCandidates(emaCrossLongFixture(), ctx()));
    const f = taken!.features;
    expect(f.lastPrice).toBe(taken!.plan!.entry);
    expect(f.atr).toBeGreaterThan(0);
    expect(f.ema20).toBeGreaterThan(f.ema50!);
    expect(f.barsAnalysed).toBe(60);
    expect(f.latestBarAt).toBeTruthy();
  });

  it('records a rejection with a machine-readable reason and the numbers behind it', () => {
    const candidates = scanForCandidates(emaCrossNoiseFloorFixture(), ctx());
    const emaCandidate = candidates.find((c) => c.setupId === 'agent-ema-cross');

    expect(emaCandidate).toBeDefined();
    expect(emaCandidate!.accepted).toBe(false);
    expect(emaCandidate!.rejectionReason).toBe('risk-below-noise-floor');
    expect(emaCandidate!.rejectionDetail).toContain('ATR');
    // The rules DID confirm — the refusal is about the levels, and the record
    // must keep that distinction or the feedback layer cannot use it.
    expect(emaCandidate!.confirmed.length).toBe(3);
    expect(emaCandidate!.unmet).toEqual([]);
    expect(emaCandidate!.explanation).toContain('What did confirm');
  });

  it('returns nothing at all when the market offers nothing — no filler rows', () => {
    // A flat, low-volume market: no setup comes within one rule of validating.
    const flat = risingSeries(60, { start: 1000, drift: 0, range: 1, volume: 1000 });
    const candidates = scanForCandidates(snapshotFrom(buildCandles(flat)), ctx());
    expect(candidates.every((c) => !c.accepted)).toBe(true);
    // Whatever survives the meaningfulness filter must be a genuine near-miss.
    for (const c of candidates) {
      expect(c.unmet.length).toBeLessThanOrEqual(1);
    }
  });

  it('refuses to judge anything on too little history, once, not once per setup', () => {
    const short = snapshotFrom(buildCandles(risingSeries(10)));
    const candidates = scanForCandidates(short, ctx());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].rejectionReason).toBe('insufficient-history');
    expect(candidates[0].accepted).toBe(false);
  });

  it('applies a setup session window only when the caller supplies a session clock', () => {
    const snapshot = emaCrossLongFixture();
    // 24/7 markets pass null and session windows must simply not apply.
    const crypto = scanForCandidates(snapshot, ctx({ istMinuteOfDay: null }));
    expect(crypto.some((c) => c.rejectionReason === 'outside-ideal-session')).toBe(false);
  });

  it('is deterministic — the same snapshot scans to the same decision', () => {
    const snapshot = emaCrossLongFixture();
    const a = scanForCandidates(snapshot, ctx());
    const b = scanForCandidates(snapshot, ctx());
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
  });
});

describe('the meaningfulness filter', () => {
  it('keeps validated setups and one-rule near-misses, drops the rest', () => {
    const snapshot = emaCrossLongFixture();
    for (const setup of AGENT_SETUPS) {
      const detection = evaluateSetup(setup, snapshot);
      const meaningful = isMeaningfulCandidate(detection);
      if (detection.validated) {
        expect(meaningful).toBe(true);
      } else if (detection.unmet.length > 1 || detection.invalidated.length > 0) {
        expect(meaningful).toBe(false);
      }
    }
  });
});
