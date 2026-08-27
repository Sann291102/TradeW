import { describe, expect, it } from 'vitest';
import { buildAvailability, type SourceState } from './data-availability';
import { evaluateHealth, healthFingerprint, type DependencyHealth, type HealthInput } from './lab-health';
import {
  CONDITION_BUCKET_MS,
  EMITTABLE_IN_PHASE_0,
  defaultSeverity,
  deriveDedupeKey,
  isEmittableNow,
  type LabEventInput,
} from './lab-events';

/**
 * Phase 0's pure logic.
 *
 * The three properties worth pinning are the ones whose absence is silent: an
 * idempotency key that is not actually idempotent, a health gate that cannot
 * tell "switched off" from "waiting", and an availability record that calls a
 * closed market a degraded feed.
 */

const AT = new Date('2026-08-20T05:45:00.000Z'); // 11:15 IST, mid-session

function evt(over: Partial<LabEventInput> = {}): LabEventInput {
  return {
    kind: 'OBSERVING',
    at: AT,
    actor: 'lab-runner',
    summary: 'x',
    profileId: 'p1',
    symbol: 'NIFTY',
    timeframe: '15m',
    ...over,
  };
}

describe('deriveDedupeKey', () => {
  it('is identical for the same event described twice', () => {
    expect(deriveDedupeKey(evt())).toBe(deriveDedupeKey(evt()));
  });

  it('does NOT depend on when it was called', async () => {
    // The trap this whole mechanism exists to avoid: a key containing a clock
    // read is unique per attempt, which is the opposite of idempotent.
    const first = deriveDedupeKey(evt());
    await new Promise((r) => setTimeout(r, 15));
    expect(deriveDedupeKey(evt())).toBe(first);
  });

  it('separates different bars, profiles, symbols and kinds', () => {
    const base = deriveDedupeKey(evt());
    expect(deriveDedupeKey(evt({ at: new Date(AT.getTime() + 60_000) }))).not.toBe(base);
    expect(deriveDedupeKey(evt({ profileId: 'p2' }))).not.toBe(base);
    expect(deriveDedupeKey(evt({ symbol: 'BANKNIFTY' }))).not.toBe(base);
    expect(deriveDedupeKey(evt({ kind: 'SETUP_CANDIDATE' }))).not.toBe(base);
    expect(deriveDedupeKey(evt({ timeframe: '5m' }))).not.toBe(base);
    expect(deriveDedupeKey(evt({ discriminator: 'orb-retest' }))).not.toBe(base);
  });

  it('cannot be collided by a delimiter inside a field', () => {
    // Concatenating with a separator would let these two collapse into one row,
    // which presents as "the timeline is missing entries".
    const a = deriveDedupeKey(evt({ symbol: 'A:B', discriminator: 'C' }));
    const b = deriveDedupeKey(evt({ symbol: 'A', discriminator: 'B:C' }));
    expect(a).not.toBe(b);
  });

  it('buckets CONDITION events so an outage is not one row per tick', () => {
    const t0 = new Date('2026-08-20T05:00:00.000Z');
    const sameBucket = new Date(t0.getTime() + CONDITION_BUCKET_MS - 1_000);
    const nextBucket = new Date(t0.getTime() + CONDITION_BUCKET_MS + 1_000);

    const k = (at: Date) => deriveDedupeKey(evt({ kind: 'OBSERVATION_SKIPPED', at, discriminator: 'sentinel-down' }));
    expect(k(sameBucket)).toBe(k(t0));
    expect(k(nextBucket)).not.toBe(k(t0));
  });

  it('does NOT bucket bar events — every bar keeps its own entry', () => {
    const t0 = new Date('2026-08-20T05:00:00.000Z');
    const oneMinuteLater = new Date(t0.getTime() + 60_000);
    expect(deriveDedupeKey(evt({ at: oneMinuteLater }))).not.toBe(deriveDedupeKey(evt({ at: t0 })));
  });
});

describe('phase gating', () => {
  it('permits exactly the kinds Phase 0 can actually produce', () => {
    for (const kind of EMITTABLE_IN_PHASE_0) expect(isEmittableNow(kind)).toBe(true);
  });

  it('refuses kinds whose machinery does not exist yet', () => {
    // The brief's one hard requirement: no fake dashboard. A kind no code path
    // can produce must never reach the timeline.
    for (const kind of ['TRADE_PROPOSAL', 'EXECUTION_RESULT', 'TRADE_OUTCOME', 'LEARNING_CANDIDATE'] as const) {
      expect(isEmittableNow(kind)).toBe(false);
    }
  });

  it('gives failure-ish kinds a non-INFO severity by default', () => {
    expect(defaultSeverity('HEALTH_DEGRADED')).toBe('WARN');
    expect(defaultSeverity('OBSERVATION_SKIPPED')).toBe('WARN');
    expect(defaultSeverity('KILL_SWITCH')).toBe('ERROR');
    expect(defaultSeverity('OBSERVING')).toBe('INFO');
  });
});

describe('evaluateHealth', () => {
  const ok = (name: string): DependencyHealth => ({ name, status: 'ok', detail: 'reachable' });
  const base: HealthInput = {
    enabled: true,
    dependencies: [ok('database'), ok('sentinel'), ok('market-data')],
    session: { open: true, reason: 'open' },
    observeOutsideSession: false,
    requiredDependencies: ['database', 'sentinel', 'market-data'],
    checkedAt: AT,
  };

  it('runs when everything is healthy and the session is open', () => {
    const h = evaluateHealth(base);
    expect(h.state).toBe('RUNNING');
    expect(h.canObserve).toBe(true);
    expect(h.blockedBy).toEqual([]);
  });

  it('NEVER reports canExecute in Phase 0 — there is no execution path', () => {
    expect(evaluateHealth(base).canExecute).toBe(false);
  });

  it('distinguishes STOPPED from WAITING', () => {
    // Both look like "nothing is happening" and mean opposite things: one is a
    // decision, the other is an outage.
    const off = evaluateHealth({ ...base, enabled: false });
    expect(off.state).toBe('STOPPED');
    expect(off.blockedBy[0]).toMatch(/AGENT_LAB_ENABLED/);

    const down = evaluateHealth({
      ...base,
      dependencies: [ok('database'), { name: 'sentinel', status: 'unavailable', detail: 'ECONNREFUSED' }, ok('market-data')],
    });
    expect(down.state).toBe('WAITING');
    expect(down.canObserve).toBe(false);
  });

  it('reports a switched-off Lab alone, without also listing the market', () => {
    const off = evaluateHealth({ ...base, enabled: false, session: { open: false, reason: 'closed:weekend' } });
    expect(off.blockedBy).toHaveLength(1);
  });

  it('waits when the database is unavailable', () => {
    const h = evaluateHealth({
      ...base,
      dependencies: [{ name: 'database', status: 'unavailable', detail: 'down' }, ok('sentinel'), ok('market-data')],
    });
    expect(h.canObserve).toBe(false);
    expect(h.blockedBy.join()).toMatch(/database/);
  });

  it('waits when market data is degraded', () => {
    const h = evaluateHealth({
      ...base,
      dependencies: [ok('database'), ok('sentinel'), { name: 'market-data', status: 'degraded', detail: 'stale' }],
    });
    expect(h.canObserve).toBe(false);
    expect(h.blockedBy.join()).toMatch(/market-data/);
  });

  it('treats an unchecked required dependency as blocking, not as passing', () => {
    const h = evaluateHealth({ ...base, dependencies: [ok('database')] });
    expect(h.canObserve).toBe(false);
    expect(h.blockedBy.join()).toMatch(/not checked/);
  });

  it('does not observe outside the session for a calendar market', () => {
    const h = evaluateHealth({ ...base, session: { open: false, reason: 'closed:after-hours' } });
    expect(h.state).toBe('WAITING');
    expect(h.blockedBy.join()).toMatch(/after-hours/);
  });

  it('DOES observe outside the session for a 24/7 market adapter', () => {
    const h = evaluateHealth({
      ...base,
      session: { open: false, reason: 'closed:after-hours' },
      observeOutsideSession: true,
    });
    expect(h.canObserve).toBe(true);
  });

  it('resumes with no state to restore — the same inputs healthy again just run', () => {
    const down = evaluateHealth({
      ...base,
      dependencies: [ok('database'), { name: 'sentinel', status: 'unavailable', detail: 'x' }, ok('market-data')],
    });
    expect(down.canObserve).toBe(false);
    expect(evaluateHealth(base).canObserve).toBe(true);
  });
});

describe('healthFingerprint', () => {
  const ok = (name: string): DependencyHealth => ({ name, status: 'ok', detail: 'r' });
  const input: HealthInput = {
    enabled: true,
    dependencies: [ok('database'), ok('sentinel'), ok('market-data')],
    session: { open: true, reason: 'open' },
    observeOutsideSession: false,
    requiredDependencies: ['database', 'sentinel', 'market-data'],
    checkedAt: AT,
  };

  it('is unchanged while the same thing stays wrong', () => {
    const broken: HealthInput = {
      ...input,
      dependencies: [ok('database'), { name: 'sentinel', status: 'unavailable', detail: 'x' }, ok('market-data')],
    };
    const a = healthFingerprint(evaluateHealth(broken));
    const b = healthFingerprint(evaluateHealth({ ...broken, checkedAt: new Date(AT.getTime() + 600_000) }));
    // A two-hour outage must be one event, not one per tick.
    expect(a).toBe(b);
  });

  it('is NOT affected by a live value inside the detail text', () => {
    // Regression, found by verify:agent-lab on 2026-08-20. The first version
    // hashed `blockedBy`, whose strings embed a bar age in seconds — so the
    // fingerprint changed every second and every tick looked like a fresh
    // degradation, writing a health event and a skip event per tick. That is
    // precisely the flood the fingerprint exists to prevent, with the mechanism
    // appearing to work.
    const stale = (detail: string): HealthInput => ({
      ...input,
      dependencies: [ok('database'), ok('sentinel'), { name: 'market-data', status: 'degraded', detail }],
    });
    const a = healthFingerprint(evaluateHealth(stale('newest bar is 779949s old')));
    const b = healthFingerprint(evaluateHealth(stale('newest bar is 779950s old')));
    expect(a).toBe(b);
  });

  it('still moves when a dependency changes STATUS', () => {
    const degraded = healthFingerprint(
      evaluateHealth({
        ...input,
        dependencies: [ok('database'), ok('sentinel'), { name: 'market-data', status: 'degraded', detail: 'x' }],
      }),
    );
    const unavailable = healthFingerprint(
      evaluateHealth({
        ...input,
        dependencies: [ok('database'), ok('sentinel'), { name: 'market-data', status: 'unavailable', detail: 'x' }],
      }),
    );
    expect(degraded).not.toBe(unavailable);
  });

  it('moves when the session opens or closes', () => {
    const open = healthFingerprint(evaluateHealth(input));
    const closed = healthFingerprint(evaluateHealth({ ...input, session: { open: false, reason: 'closed:after-hours' } }));
    expect(open).not.toBe(closed);
  });

  it('changes when a DIFFERENT thing breaks', () => {
    const one = healthFingerprint(
      evaluateHealth({
        ...input,
        dependencies: [ok('database'), { name: 'sentinel', status: 'unavailable', detail: 'x' }, ok('market-data')],
      }),
    );
    const two = healthFingerprint(
      evaluateHealth({
        ...input,
        dependencies: [
          { name: 'database', status: 'unavailable', detail: 'y' },
          { name: 'sentinel', status: 'unavailable', detail: 'x' },
          ok('market-data'),
        ],
      }),
    );
    expect(one).not.toBe(two);
  });

  it('changes on recovery', () => {
    const broken = healthFingerprint(
      evaluateHealth({
        ...input,
        dependencies: [ok('database'), { name: 'sentinel', status: 'unavailable', detail: 'x' }, ok('market-data')],
      }),
    );
    expect(healthFingerprint(evaluateHealth(input))).not.toBe(broken);
  });
});

describe('buildAvailability', () => {
  const src = (name: string, status: SourceState['status'] = 'ok'): SourceState => ({
    name,
    status,
    detail: status === 'ok' ? 'fresh' : 'missing',
  });
  const base = {
    checkedAt: AT,
    sources: [src('database'), src('sentinel'), src('candles')],
    newestBarAt: new Date(AT.getTime() - 60_000),
    sessionOpen: true,
    maxBarAgeSeconds: 900,
    requiredSources: ['database', 'sentinel', 'candles'],
  };

  it('is sufficient when every required source answered and the bar is fresh', () => {
    const a = buildAvailability(base);
    expect(a.sufficient).toBe(true);
    expect(a.insufficientReason).toBeNull();
    expect(a.barAgeSeconds).toBe(60);
  });

  it('names the optional inputs that were absent, without failing on them', () => {
    const a = buildAvailability({
      ...base,
      sources: [...base.sources, src('option-chain', 'unavailable'), src('news', 'unavailable')],
    });
    expect(a.absent).toEqual(['option-chain', 'news']);
    expect(a.sufficient).toBe(true); // optional means optional
  });

  it('is insufficient when a REQUIRED source is missing, and says which', () => {
    const a = buildAvailability({ ...base, sources: [src('database'), src('sentinel', 'unavailable'), src('candles')] });
    expect(a.sufficient).toBe(false);
    expect(a.insufficientReason).toMatch(/sentinel/);
  });

  it('is insufficient when a required source was never checked', () => {
    const a = buildAvailability({ ...base, sources: [src('database')] });
    expect(a.sufficient).toBe(false);
    expect(a.insufficientReason).toMatch(/not checked/);
  });

  it('calls a stale bar stale DURING an open session', () => {
    const a = buildAvailability({ ...base, newestBarAt: new Date(AT.getTime() - 3_600_000) });
    expect(a.sufficient).toBe(false);
    expect(a.insufficientReason).toMatch(/the feed is behind/);
  });

  it('does NOT call the same bar stale when the market is shut', () => {
    // Otherwise the Lab sits in a permanent alarm state every evening and every
    // weekend, and a real outage becomes indistinguishable from a Tuesday night.
    const a = buildAvailability({
      ...base,
      newestBarAt: new Date(AT.getTime() - 3_600_000),
      sessionOpen: false,
    });
    expect(a.sufficient).toBe(true);
    expect(a.barAgeSeconds).toBe(3600);
  });

  it('reports no bar at all as insufficient rather than as age null', () => {
    const a = buildAvailability({ ...base, newestBarAt: null });
    expect(a.barAgeSeconds).toBeNull();
    expect(a.sufficient).toBe(false);
    expect(a.insufficientReason).toMatch(/No bar/);
  });

  it('never invents a value — absent stays absent', () => {
    const a = buildAvailability({ ...base, sources: [...base.sources, src('vix', 'unavailable')] });
    expect(a.sources.find((s) => s.name === 'vix')!.status).toBe('unavailable');
    expect(a.absent).toContain('vix');
  });
});
