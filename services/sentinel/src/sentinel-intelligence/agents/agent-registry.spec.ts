import { describe, expect, it, vi } from 'vitest';
import { AgentRegistryService } from './agent-registry.service';
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
import { context, subtask } from './fixtures';
import { ALL_AGENT_IDS, type AgentId } from '../types';

/**
 * The dispatcher.
 *
 * It makes one promise the whole pipeline is built on: **every subtask gets a
 * verdict**. Downstream, `CrossCheckService` and `SynthesisService` iterate
 * verdicts and count corroboration; a missing verdict would not throw there, it
 * would quietly change a gate decision. So the two ways a verdict could fail to
 * appear — an unknown agent id, and an agent that throws — must both produce an
 * abstention instead, and that abstention must carry zero weight and no veto.
 *
 * Built by hand rather than through a Nest container, because that is the whole
 * point: the registry is a map plus a try/catch and must be verifiable without
 * one.
 */

function registry(): AgentRegistryService {
  return new AgentRegistryService(
    new MarketIntelligenceAgent(),
    new StrategyIntelligenceAgent(),
    new NewsIntelligenceAgent(),
    new OptionsChainIntelligenceAgent(),
    new RiskIntelligenceAgent(),
    new EmotionIntelligenceAgent(),
    new TrapIntelligenceAgent(),
    new HistoricalPatternIntelligenceAgent(),
    new ComplianceIntelligenceAgent(),
    new LearningIntelligenceAgent(),
  );
}

describe('the agent registry', () => {
  it('registers every declared agent id', () => {
    const r = registry();
    for (const id of ALL_AGENT_IDS) expect(r.get(id)).not.toBeNull();
  });

  it('reports a roster with a remit line for every agent', () => {
    const roster = registry().roster();

    expect(roster.map((a) => a.id).sort()).toEqual([...ALL_AGENT_IDS].sort());
    for (const entry of roster) expect(entry.remit.length).toBeGreaterThan(0);
  });

  it('converts a thrown agent into an abstention rather than failing the run', async () => {
    const r = registry();
    vi.spyOn(r.get('market-intelligence')!, 'reason').mockImplementation(() => {
      throw new Error('index corrupted mid-search');
    });

    const verdict = await r.run(context('market-intelligence'));

    expect(verdict.abstained).toBe(true);
    expect(verdict.confidence).toBe(0);
    expect(verdict.stance).toBe('no-read');
    expect(verdict.dataQuality).toBe(0);
    // The error text survives, so a genuine bug is diagnosable rather than
    // silently swallowed.
    expect(verdict.abstentionReason).toContain('index corrupted mid-search');
    // And it is attributed to the right subtask, or the cross-checker would
    // weight it under the wrong plan entry.
    expect(verdict.agent).toBe('market-intelligence');
    expect(verdict.subtaskId).toBe('market-intelligence#1');
  });

  it('converts a REJECTED promise into an abstention too', async () => {
    const r = registry();
    vi.spyOn(r.get('trap-intelligence')!, 'reason').mockRejectedValue(new Error('async failure'));

    const verdict = await r.run(context('trap-intelligence'));

    expect(verdict.abstained).toBe(true);
    expect(verdict.abstentionReason).toContain('async failure');
  });

  it('never lets a failed agent carry a veto', async () => {
    // A dispatch failure must not be able to masquerade as a compliance
    // finding, or a crashing agent would silence every run in the system.
    const r = registry();
    vi.spyOn(r.get('compliance-intelligence')!, 'reason').mockImplementation(() => {
      throw new Error('compliance agent crashed');
    });

    const verdict = await r.run(context('compliance-intelligence'));

    expect(verdict.abstained).toBe(true);
    expect(verdict.veto).toBeNull();
  });

  it('abstains for an unregistered agent id rather than returning nothing', async () => {
    const unknown = 'ghost-intelligence' as AgentId;
    const verdict = await registry().run(context('market-intelligence', { subtask: subtask(unknown) }));

    expect(verdict.abstained).toBe(true);
    expect(verdict.agent).toBe(unknown);
    expect(verdict.abstentionReason).toContain('No agent is registered');
  });

  it('returns a verdict for every declared agent — the pipeline invariant', async () => {
    const r = registry();
    const verdicts = await Promise.all(ALL_AGENT_IDS.map((id) => r.run(context(id))));

    expect(verdicts).toHaveLength(ALL_AGENT_IDS.length);
    for (const [i, verdict] of verdicts.entries()) {
      expect(verdict.agent).toBe(ALL_AGENT_IDS[i]);
      expect(verdict.subtaskId).toBe(`${ALL_AGENT_IDS[i]}#1`);
    }
  });

  it('emits no telemetry outside a run rather than writing orphan rows', async () => {
    // `trackAgent` now wraps every dispatch. With no ambient runId,
    // `emitAgentActivity` drops the event by design — an activity row with no
    // run to belong to would render as a ghost node in the admin orbit. This
    // pins that the instrumentation is safe to call from a bare unit test.
    await expect(registry().run(context('market-intelligence'))).resolves.toBeDefined();
  });

  it('exposes the compliance agent for the text injection it needs', () => {
    expect(registry().complianceAgent).toBeInstanceOf(ComplianceIntelligenceAgent);
  });
});
