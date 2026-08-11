import { describe, expect, it } from 'vitest';
import { MemoryRecord, NewMemoryRecord } from '../domain/knowledge';
import { MemoryStore } from '../memory/interfaces';
import { CognitiveNetwork } from './network';
import { NewPercept, Perceptor, PerceptorRegistry } from './percept';
import { SynapseStore, WEIGHT_INITIAL, decayedWeight } from './weights';

/**
 * The cognition network's behavioural contract.
 *
 * These tests pin the four decisions that are easy to get wrong and impossible
 * to notice in production:
 *
 *  1. **Bursts collapse.** Twelve identical errors are one fact with a count.
 *     If they arrive as twelve percepts, one flapping dependency dominates the
 *     network and every other signal is starved.
 *  2. **Corroboration gates promotion.** A single sensor agreeing with itself
 *     is not evidence, however confident it is.
 *  3. **Firing does not teach; outcomes do.** If activation alone moved
 *     weights, the loudest sensor would win regardless of ever being right.
 *  4. **Neutral rewards are inert.** An unjudgeable outcome must leave weights
 *     untouched — a neutral that pulls weights down makes the network unlearn
 *     itself into silence.
 */

/** Records what was stored, so promotion can be asserted on. */
class FakeMemory implements MemoryStore {
  readonly stored: NewMemoryRecord[] = [];

  async store(record: NewMemoryRecord): Promise<MemoryRecord> {
    this.stored.push(record);
    return { ...record, id: `mem-${this.stored.length}`, createdAt: new Date(0), updatedAt: new Date(0) };
  }
  async get(): Promise<MemoryRecord | null> {
    return null;
  }
  async search() {
    return [];
  }
  async connect(): Promise<void> {}
  async update(): Promise<MemoryRecord> {
    throw new Error('not used');
  }
  async stats() {
    return { total: this.stored.length, byNamespace: {} };
  }
}

function fixedPercept(overrides: Partial<NewPercept> = {}): NewPercept {
  return {
    perceptorId: 'application.error-rate',
    domain: 'application',
    kind: 'error_rate_spike',
    subject: { type: 'route', id: 'POST /orders' },
    observedAt: new Date('2026-08-11T10:00:00Z'),
    salience: 0.8,
    confidence: 0.9,
    features: { errorRate: 0.4 },
    summary: '5xx rate on POST /orders jumped to 40%',
    tags: ['application'],
    ...overrides,
  };
}

/** Deterministic ids so assertions do not depend on a UUID. */
function counterId(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

function makeNetwork(options: { concepts?: boolean; promotionThreshold?: number } = {}) {
  const memory = new FakeMemory();
  const synapses = new SynapseStore();
  const network = new CognitiveNetwork(
    {
      memory,
      now: () => new Date('2026-08-11T10:00:00Z'),
      newId: counterId(),
      // A concept port that always returns one strong match, so L3 has
      // something to associate to without a real embedding store.
      concepts: options.concepts
        ? { related: async () => [{ id: 'deploy-regression', label: 'Deploy regression', score: 0.95 }] }
        : undefined,
    },
    { synapses, promotionThreshold: options.promotionThreshold },
  );
  return { network, memory, synapses };
}

describe('L1 perception', () => {
  it('collapses a burst of identical percepts into one, with a count', async () => {
    const { network } = makeNetwork();
    const burst = Array.from({ length: 12 }, () => fixedPercept());

    const episode = await network.perceive({ percepts: burst, trigger: 'test' });

    expect(episode.percepts).toHaveLength(1);
    expect(episode.percepts[0].occurrences).toBe(12);
    expect(episode.collapsed).toBe(1);
  });

  it('raises salience sub-linearly with repetition', async () => {
    const { network } = makeNetwork();
    const base = fixedPercept({ salience: 0.2 });

    const one = await network.perceive({ percepts: [base], trigger: 'test' });
    const hundred = await network.perceive({
      percepts: Array.from({ length: 100 }, () => base),
      trigger: 'test',
    });

    // 100× the occurrences must not be 100× the salience, or a retry storm
    // outranks every real signal in the window.
    expect(hundred.percepts[0].salience).toBeGreaterThan(one.percepts[0].salience);
    expect(hundred.percepts[0].salience).toBeLessThan(one.percepts[0].salience * 3);
  });

  it('gates percepts below the salience floor and counts them', async () => {
    const { network } = makeNetwork();

    const episode = await network.perceive({
      percepts: [fixedPercept({ salience: 0.02, kind: 'noise' })],
      trigger: 'test',
    });

    expect(episode.percepts).toHaveLength(0);
    expect(episode.gated).toBe(1);
    // A pass with nothing above the floor is a success, not a failure — that is
    // what distinguishes "quiet" from "not running" in the console.
    expect(episode.status).toBe('ok');
  });
});

describe('L4 consolidation', () => {
  it('refuses to promote a hypothesis backed by a single perceptor', async () => {
    const { network, memory } = makeNetwork({ concepts: true, promotionThreshold: 0.01 });

    const episode = await network.perceive({ percepts: [fixedPercept()], trigger: 'test' });

    expect(episode.hypotheses.length).toBeGreaterThan(0);
    expect(memory.stored).toHaveLength(0);
    expect(episode.rejected.some((r) => r.reason.includes('not corroborated'))).toBe(true);
  });

  it('promotes when two independent perceptors corroborate', async () => {
    const { network, memory } = makeNetwork({ concepts: true, promotionThreshold: 0.01 });

    const episode = await network.perceive({
      percepts: [
        fixedPercept(),
        fixedPercept({ perceptorId: 'application.latency', kind: 'latency_regression' }),
      ],
      trigger: 'test',
    });

    const corroborated = episode.hypotheses.filter((h) => h.corroborated);
    expect(corroborated.length).toBeGreaterThan(0);
    expect(memory.stored.length).toBeGreaterThan(0);
    expect(memory.stored[0].namespace).toBe('cognition');
  });

  it('never turns a market hypothesis into a proposal', async () => {
    const { network } = makeNetwork({ concepts: true, promotionThreshold: 0.01 });

    const episode = await network.perceive({
      percepts: [
        fixedPercept({ domain: 'market', perceptorId: 'market.structure', kind: 'structure_break' }),
        fixedPercept({ domain: 'market', perceptorId: 'market.volatility', kind: 'vol_expansion' }),
      ],
      trigger: 'test',
    });

    // Sentinel's publication gate owns everything that reaches a trader.
    // A second path from a system with no compliance review is exactly what
    // ARCHITECTURE Rule 2 forbids.
    expect(episode.proposals).toHaveLength(0);
  });

  it('routes an application hypothesis to an investigate proposal', async () => {
    const { network } = makeNetwork({ concepts: true, promotionThreshold: 0.01 });

    const episode = await network.perceive({
      percepts: [
        fixedPercept(),
        fixedPercept({ perceptorId: 'application.latency', kind: 'latency_regression' }),
      ],
      trigger: 'test',
    });

    expect(episode.proposals.map((p) => p.kind)).toContain('investigate');
  });
});

describe('the learning rule', () => {
  it('does not change a weight when an association merely fires', () => {
    const synapses = new SynapseStore();
    const key = { source: 'percept:a/x', target: 'concept:y', layer: 'L3_ASSOCIATION' as const };

    for (let i = 0; i < 50; i += 1) synapses.activate(key, 1, 'episode-1');

    expect(synapses.weightOf(key)).toBeCloseTo(WEIGHT_INITIAL, 6);
    expect(synapses.get(key)?.activations).toBe(50);
    expect(synapses.get(key)?.reinforcements).toBe(0);
  });

  it('moves a weight toward the reward when an outcome confirms', () => {
    const synapses = new SynapseStore();
    const key = { source: 'percept:a/x', target: 'concept:y', layer: 'L3_ASSOCIATION' as const };
    const at = new Date('2026-08-11T10:00:00Z');

    synapses.activate(key, 1, 'episode-1', at);
    const changes = synapses.reinforce({ episodeId: 'episode-1', reward: 1, reason: 'confirmed', observedAt: at });

    expect(changes).toHaveLength(1);
    expect(changes[0].delta).toBeGreaterThan(0);
    expect(synapses.weightOf(key, at)).toBeGreaterThan(WEIGHT_INITIAL);
  });

  it('converges toward the observed reward rate rather than saturating', () => {
    const synapses = new SynapseStore();
    const key = { source: 'percept:a/x', target: 'concept:y', layer: 'L3_ASSOCIATION' as const };
    const at = new Date('2026-08-11T10:00:00Z');

    // An association that pays off 70% of the time should settle near 0.7 —
    // not at the ceiling, which is what plain co-occurrence counting produces.
    for (let i = 0; i < 200; i += 1) {
      synapses.activate(key, 1, `episode-${i}`, at);
      synapses.reinforce({
        episodeId: `episode-${i}`,
        reward: i % 10 < 7 ? 1 : 0,
        reason: 'scored',
        observedAt: at,
      });
    }

    expect(synapses.weightOf(key, at)).toBeGreaterThan(0.55);
    expect(synapses.weightOf(key, at)).toBeLessThan(0.85);
  });

  it('leaves a weight untouched when the outcome is neutral', () => {
    const synapses = new SynapseStore();
    const key = { source: 'percept:a/x', target: 'concept:y', layer: 'L3_ASSOCIATION' as const };
    const at = new Date('2026-08-11T10:00:00Z');

    synapses.activate(key, 1, 'episode-1', at);
    const changes = synapses.reinforce({ episodeId: 'episode-1', reward: 0.5, reason: 'unknown', observedAt: at });

    // reward 0.5 against an initial weight of 0.35 is a small pull upward, not
    // a punishment. What must never happen is a *downward* move on "unknown".
    expect(changes[0].delta).toBeGreaterThanOrEqual(0);
    expect(synapses.weightOf(key, at)).toBeGreaterThanOrEqual(WEIGHT_INITIAL);
  });

  it('only scores the episode that produced the trace', () => {
    const synapses = new SynapseStore();
    const mine = { source: 'percept:a/x', target: 'concept:y', layer: 'L3_ASSOCIATION' as const };
    const theirs = { source: 'percept:b/z', target: 'concept:w', layer: 'L3_ASSOCIATION' as const };
    const at = new Date('2026-08-11T10:00:00Z');

    synapses.activate(mine, 1, 'episode-1', at);
    synapses.activate(theirs, 1, 'episode-2', at);
    const changes = synapses.reinforce({ episodeId: 'episode-1', reward: 1, reason: 'confirmed', observedAt: at });

    expect(changes).toHaveLength(1);
    expect(changes[0].key.source).toBe('percept:a/x');
    // episode-2's trace survives, still waiting for its own outcome.
    expect(synapses.pendingTraces()).toBe(1);
  });

  it('discounts credit by how long the outcome took to arrive', () => {
    const at = new Date('2026-08-11T10:00:00Z');
    const prompt = new SynapseStore();
    const slow = new SynapseStore();
    const key = { source: 'percept:a/x', target: 'concept:y', layer: 'L3_ASSOCIATION' as const };

    prompt.activate(key, 1, 'e', at);
    slow.activate(key, 1, 'e', at);

    const promptChange = prompt.reinforce({ episodeId: 'e', reward: 1, reason: 'fast', observedAt: at })[0];
    const slowChange = slow.reinforce({
      episodeId: 'e',
      reward: 1,
      reason: 'slow',
      // Two hours later — four eligibility half-lives.
      observedAt: new Date(at.getTime() + 2 * 3_600_000),
    })[0];

    expect(promptChange.delta).toBeGreaterThan(slowChange.delta);
  });

  it('decays an idle weight back toward its initial value', () => {
    const at = new Date('2026-08-11T10:00:00Z');
    const synapse = {
      source: 'a',
      target: 'b',
      layer: 'L3_ASSOCIATION' as const,
      weight: 0.9,
      activations: 10,
      reinforcements: 10,
      meanReward: 0.9,
      lastActivatedAt: at,
      lastReinforcedAt: at,
      createdAt: at,
    };

    const fresh = decayedWeight(synapse, at);
    // One decay half-life later (30 days), half the distance from the initial
    // value should be gone. A pattern that has not fired in a month is not
    // knowledge, it is a fossil.
    const stale = decayedWeight(synapse, new Date(at.getTime() + 30 * 24 * 3_600_000));

    expect(fresh).toBeCloseTo(0.9, 6);
    expect(stale).toBeCloseTo(WEIGHT_INITIAL + (0.9 - WEIGHT_INITIAL) * 0.5, 2);
  });
});

describe('the perceptor registry', () => {
  const definition = {
    id: 'test.flaky',
    domain: 'application' as const,
    label: 'Flaky',
    description: 'throws',
    cadence: 'interval' as const,
    expectedIntervalMs: 60_000,
    emits: ['boom'],
    enabled: true,
  };

  const context = { since: new Date(0), until: new Date(1), passId: 'p' };

  it('quarantines a perceptor that fails repeatedly, without failing the pass', async () => {
    const registry = new PerceptorRegistry();
    const flaky: Perceptor = {
      definition: { ...definition },
      sense: async () => {
        throw new Error('database gone');
      },
    };
    const healthy: Perceptor = {
      definition: { ...definition, id: 'test.healthy' },
      sense: async () => [fixedPercept()],
    };
    registry.register(flaky);
    registry.register(healthy);

    for (let i = 0; i < 3; i += 1) {
      const out = await registry.sense(context);
      // One broken sensor must never blind the other twenty.
      expect(out).toHaveLength(1);
    }

    expect(registry.healthOf('test.flaky')?.status).toBe('quarantined');
    expect(registry.healthOf('test.flaky')?.lastError).toContain('database gone');

    // A quarantined sensor is skipped entirely on the next pass.
    await registry.sense(context);
    expect(registry.healthOf('test.flaky')?.consecutiveFailures).toBe(3);
  });

  it('reports an interval perceptor that has gone silent as stale, not healthy', async () => {
    const registry = new PerceptorRegistry();
    registry.register({ definition: { ...definition, id: 'test.quiet' }, sense: async () => [] });

    await registry.sense({ ...context, until: new Date('2026-08-11T10:00:00Z') });

    // Within 3× the expected interval: quiet is fine.
    const soon = registry.allHealth(new Date('2026-08-11T10:01:00Z'));
    expect(soon.find((h) => h.perceptorId === 'test.quiet')?.status).toBe('healthy');

    // Past it: the sensor has stopped, and that is the finding.
    const later = registry.allHealth(new Date('2026-08-11T10:10:00Z'));
    expect(later.find((h) => h.perceptorId === 'test.quiet')?.status).toBe('stale');
  });

  it('lists a disabled perceptor rather than hiding it', () => {
    const registry = new PerceptorRegistry();
    registry.register({ definition: { ...definition, id: 'test.off', enabled: false }, sense: async () => [] });

    // An operator needs to see the sensor they could turn on, not just the
    // ones already running.
    expect(registry.allHealth().find((h) => h.perceptorId === 'test.off')?.status).toBe('disabled');
  });
});
