import { describe, expect, it } from 'vitest';
import { ComplianceIntelligenceAgent } from './compliance-intelligence.agent';
import { EmotionIntelligenceAgent } from './emotion-intelligence.agent';
import { HistoricalPatternIntelligenceAgent } from './historical-pattern-intelligence.agent';
import { LearningIntelligenceAgent } from './learning-intelligence.agent';
import { MarketIntelligenceAgent } from './market-intelligence.agent';
import { NewsIntelligenceAgent } from './news-intelligence.agent';
import { OptionsChainIntelligenceAgent } from './options-chain-intelligence.agent';
import { RiskIntelligenceAgent } from './risk-intelligence.agent';
import { StrategyIntelligenceAgent } from './strategy-intelligence.agent';
import { TrapIntelligenceAgent } from './trap-intelligence.agent';
import type { AgentContext, IntelligenceAgent } from './agent.contract';
import {
  baseRate,
  candles,
  context,
  emptyGraph,
  emptyIndex,
  optionChain,
  riskAssessment,
  signal,
  snapshot,
  trades,
  understood,
} from './fixtures';
import { ALL_AGENT_IDS, type AgentId, type AgentVerdict } from '../types';

/**
 * The ten reasoning agents.
 *
 * These were entirely uncovered: ten production reasoning components, each
 * stating safety properties in its own header that nothing enforced. The
 * properties pinned here are the ones whose absence would be invisible in
 * production and dangerous:
 *
 *  1. **Abstention on missing input.** An agent that cannot answer must say so.
 *     "I have no data" silently becoming "I found nothing wrong" is the single
 *     worst failure available to this system, because an abstention carries
 *     zero weight while a neutral verdict corroborates.
 *  2. **No knowledge evidence without a citation.** `VerdictBuilder.knowledge()`
 *     throws on an empty citation list — a stated invariant that no test
 *     exercised. Every agent is run against an EMPTY corpus here, which is the
 *     condition that would trip it.
 *  3. **A stance and a confidence for a healthy fixture**, so an agent that
 *     silently degrades to permanent no-read is caught.
 *
 * Every agent is constructed directly and run over a stubbed `AgentContext`.
 * No Nest container, no Postgres, no network, no market data.
 */

/** Every agent, paired with the context that makes it abstain. */
const AGENTS: {
  id: AgentId;
  make: () => IntelligenceAgent;
  /** Context override that starves this agent of the one input it needs. */
  starved: Partial<AgentContext>;
  /** Context override that gives it enough to form a real view. */
  healthy?: Partial<AgentContext>;
}[] = [
  { id: 'market-intelligence', make: () => new MarketIntelligenceAgent(), starved: { snapshot: null } },
  { id: 'strategy-intelligence', make: () => new StrategyIntelligenceAgent(), starved: { snapshot: null } },
  {
    id: 'news-intelligence',
    make: () => new NewsIntelligenceAgent(),
    // The news agent reads one named signal; without it there is no event read.
    starved: { signals: [] },
    healthy: {
      signals: [
        signal({ name: 'news_driven_volatility', agent: 'news', evidence: ['RBI policy in 20 minutes'] }),
      ],
    },
  },
  {
    id: 'options-chain-intelligence',
    make: () => new OptionsChainIntelligenceAgent(),
    starved: { snapshot: snapshot({ optionChain: null }) },
    healthy: { snapshot: snapshot({ optionChain: optionChain() as never }) },
  },
  {
    id: 'risk-intelligence',
    make: () => new RiskIntelligenceAgent(),
    starved: { risk: null },
    healthy: { risk: riskAssessment() },
  },
  {
    id: 'emotion-intelligence',
    make: () => new EmotionIntelligenceAgent(),
    starved: { trades: [] },
    healthy: {
      trades: trades(),
      signals: [signal({ name: 'revenge_trading', agent: 'emotion', evidence: ['three losses, sizing up each time'] })],
    },
  },
  {
    id: 'trap-intelligence',
    make: () => new TrapIntelligenceAgent(),
    starved: { snapshot: null },
    healthy: {
      signals: [
        signal({ name: 'low_volume_breakout', agent: 'trap-safety', evidence: ['break on 0.4x average volume'] }),
      ],
    },
  },
  {
    id: 'historical-pattern-intelligence',
    make: () => new HistoricalPatternIntelligenceAgent(),
    // Too few bars for a precedent search, and no live record to fall back on.
    starved: { snapshot: snapshot({ candles: candles(5) }), baseRates: new Map() },
  },
  {
    id: 'learning-intelligence',
    make: () => new LearningIntelligenceAgent(),
    // Nothing specific enough to retrieve against.
    starved: {
      understood: understood({ rawText: '', indicators: [] }),
      snapshot: snapshot({ marketProfile: null }),
      detections: [],
    },
  },
];

async function run(agent: IntelligenceAgent, ctx: AgentContext): Promise<AgentVerdict> {
  return agent.reason(ctx);
}

describe('every agent', () => {
  it('covers the whole declared roster — a new AgentId must arrive with a spec', () => {
    // The compliance agent is exercised in its own block below (it needs text
    // injected before it can run), so it is the one deliberate omission here.
    const covered = new Set([...AGENTS.map((a) => a.id), 'compliance-intelligence']);
    expect([...ALL_AGENT_IDS].sort()).toEqual([...covered].sort());
  });

  for (const spec of AGENTS) {
    describe(spec.id, () => {
      it('abstains rather than reporting a neutral read when its input is missing', async () => {
        const verdict = await run(spec.make(), context(spec.id, spec.starved));

        expect(verdict.abstained).toBe(true);
        expect(verdict.confidence).toBe(0);
        expect(verdict.stance).toBe('no-read');
        // A reason a human can act on, not an empty string.
        expect(verdict.abstentionReason ?? '').not.toHaveLength(0);
      });

      it('emits no knowledge evidence when nothing citable exists', async () => {
        // BOTH citation sources are starved, not just the index: the ontology
        // carries its own grounding, and an agent drawing a cited claim from a
        // concept is behaving correctly, not leaking an uncited one. The real
        // invariant is that with nothing citable anywhere, no knowledge claim
        // is made at all — which is the cold-start state before the corpus is
        // built.
        //
        // `VerdictBuilder.knowledge()` throws on an empty citation list, so a
        // pass here proves the agent guarded the call rather than that a
        // citation happened to be available.
        const verdict = await run(
          spec.make(),
          context(spec.id, { ...spec.healthy, index: emptyIndex(), graph: emptyGraph() }),
        );

        expect(verdict.evidence.filter((e) => e.kind === 'knowledge')).toHaveLength(0);
        expect(verdict.citations).toHaveLength(0);
      });

      it('still reaches a verdict with a cold corpus rather than failing the run', async () => {
        // Grounding modulates confidence; it does not gate the agent. A
        // measured market fact does not become unreportable because no book in
        // the corpus happens to discuss it.
        const verdict = await run(
          spec.make(),
          context(spec.id, { ...spec.healthy, index: emptyIndex(), graph: emptyGraph() }),
        );

        expect(verdict.agent).toBe(spec.id);
        expect(verdict.headline.length).toBeGreaterThan(0);
      });

      it('never attaches a knowledge claim without citations backing it', async () => {
        const verdict = await run(spec.make(), context(spec.id, spec.healthy));

        for (const item of verdict.evidence) {
          if (item.kind === 'knowledge') expect(item.citations.length).toBeGreaterThan(0);
        }
      });

      it('reports a stance and a bounded confidence on a healthy context', async () => {
        const verdict = await run(spec.make(), context(spec.id, spec.healthy));

        expect(verdict.agent).toBe(spec.id);
        expect(verdict.subtaskId).toBe(`${spec.id}#1`);
        expect(verdict.abstained).toBe(false);
        expect(verdict.confidence).toBeGreaterThanOrEqual(0);
        expect(verdict.confidence).toBeLessThanOrEqual(1);
        expect(verdict.dataQuality).toBeGreaterThanOrEqual(0);
        expect(verdict.dataQuality).toBeLessThanOrEqual(1);
        expect(verdict.headline.length).toBeGreaterThan(0);
      });

      it('raises no veto — only compliance may stop a run', async () => {
        const verdict = await run(spec.make(), context(spec.id, spec.healthy));
        expect(verdict.veto).toBeNull();
      });
    });
  }
});

describe('news-intelligence', () => {
  it('never takes a direction from a headline', async () => {
    const verdict = await run(
      new NewsIntelligenceAgent(),
      context('news-intelligence', {
        signals: [
          signal({
            name: 'news_driven_volatility',
            agent: 'news',
            evidence: ['Earnings beat by 40%', '3 high-impact events'],
          }),
        ],
      }),
    );

    // The stance is a volatility/reliability modifier by design. Inferring
    // "earnings beat, so bullish" is exactly the speculative leap the gate
    // exists to prevent, and this agent must not make it.
    expect(['neutral', 'risk-elevated', 'no-read']).toContain(verdict.stance);
  });
});

describe('historical-pattern-intelligence', () => {
  const agent = () => new HistoricalPatternIntelligenceAgent();

  it('reads the measured live record, not only the candles in hand', async () => {
    const verdict = await run(
      agent(),
      context('historical-pattern-intelligence', {
        baseRates: new Map([['ema_cross', baseRate()]]),
      }),
    );

    expect(verdict.evidence.some((e) => /live-market memory/.test(e.statement))).toBe(true);
    expect(verdict.headline).toMatch(/Measured live/);
  });

  it('says so plainly when no live record exists', async () => {
    const verdict = await run(agent(), context('historical-pattern-intelligence', { baseRates: new Map() }));

    expect(verdict.evidence.some((e) => /No outcome-tagged occurrences/.test(e.statement))).toBe(true);
  });

  it('lets the live record outrank the chart when the two disagree', async () => {
    // The chart fixture rises monotonically, so self-similarity reads bullish.
    // The live record says this setup has mostly failed.
    const bearishLive = baseRate({ distribution: { continued_up: 3, continued_down: 15, unclear: 2 } });
    const verdict = await run(
      agent(),
      context('historical-pattern-intelligence', { baseRates: new Map([['ema_cross', bearishLive]]) }),
    );

    expect(verdict.stance).toBe('bearish');
    // And the disagreement is reported rather than averaged away.
    expect(verdict.evidence.some((e) => /lean/.test(e.statement))).toBe(true);
  });

  it('will not let a thin live sample create a directional read', async () => {
    const thin = baseRate({ distribution: { continued_down: 3 } });
    expect(thin.reliable).toBe(false);

    const verdict = await run(
      agent(),
      context('historical-pattern-intelligence', { baseRates: new Map([['ema_cross', thin]]) }),
    );

    expect(verdict.evidence.some((e) => /below the .* floor/.test(e.statement))).toBe(true);
  });

  it('answers from the live record alone when the chart is too short', async () => {
    const verdict = await run(
      agent(),
      context('historical-pattern-intelligence', {
        snapshot: snapshot({ candles: candles(5) }),
        baseRates: new Map([['ema_cross', baseRate()]]),
      }),
    );

    // The old behaviour was an unconditional abstention here, which threw away
    // a measured base rate because the snapshot happened to be short.
    expect(verdict.abstained).toBe(false);
    expect(verdict.headline).toMatch(/Measured live/);
  });

  it('counts unclear outcomes in the denominator', async () => {
    // 5 up out of 10 total — a coin flip, not a 100% base rate, even though
    // every DECISIVE outcome went the same way.
    const mostlyFlat = baseRate({ distribution: { continued_up: 5, unclear: 5 } });
    const verdict = await run(
      agent(),
      context('historical-pattern-intelligence', { baseRates: new Map([['ema_cross', mostlyFlat]]) }),
    );

    expect(verdict.headline).toMatch(/resolved higher 50%/);
  });
});

describe('compliance-intelligence', () => {
  const agent = () => new ComplianceIntelligenceAgent();
  const ctx = () => context('compliance-intelligence');

  it('reports clean when every statement is observational', () => {
    const verdict = agent()
      .withText(['Structure is consolidating above the opening range.'])
      .reason(ctx());

    expect(verdict.stance).toBe('neutral');
    expect(verdict.veto).toBeNull();
  });

  it('records a rewritten directive as a finding without vetoing the run', () => {
    // The rewriter caught it, so the output is safe; the breach is still worth
    // seeing in the audit trail, because a model that keeps producing
    // directives is a problem worth watching.
    const verdict = agent().withText(['You should buy this breakout.']).reason(ctx());

    expect(verdict.veto).toBeNull();
    expect(verdict.headline).toMatch(/rewritten into observational language/);
  });

  it('produces a neutral, never a directional, stance', () => {
    for (const text of ['You should buy now', 'Nothing to see here', '']) {
      const verdict = agent().withText([text]).reason(ctx());
      expect(['neutral', 'risk-elevated']).toContain(verdict.stance);
    }
  });

  it('clears its injected text between runs so one run cannot audit another', () => {
    const a = agent();
    a.withText(['You should buy this breakout.']).reason(ctx());
    const second = a.reason(ctx());

    expect(second.headline).toMatch(/nothing to audit/);
  });
});
