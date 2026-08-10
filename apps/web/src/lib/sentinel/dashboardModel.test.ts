import { describe, expect, it } from 'vitest';
import { buildDashboardModel } from './dashboardModel';
import type { ObserveResponse } from './types';

/**
 * The dashboard model must map the real /observe response into card
 * view-models without inventing anything. These tests assert that a null
 * response degrades to honest empty states and that a populated response is
 * mapped field-for-field.
 */

describe('buildDashboardModel', () => {
  it('degrades to honest empty states on a null response', () => {
    const m = buildDashboardModel(null, false);
    expect(m.confidence.score).toBeNull();
    expect(m.risk.score).toBeNull();
    expect(m.observationCount).toBe(0);
    expect(m.radar).toEqual([]);
    expect(m.timeline).toEqual([]);
    expect(m.marketActive).toBe(false);
  });

  it('maps real observe fields into the cards', () => {
    const res = {
      synthesis: null,
      observations: [
        { agent: 'market-technical', category: 'market_structure_observation', content: 'MACD histogram is -3.02', evidence: [], confidence: 0.6 },
      ],
      signals: [],
      marketProfile: { type: 'High Volatility Range', description: '', trend: 'choppy', volatility: 'high', structure: 'ranging', evidence: [] },
      risk: {
        overallRisk: 47,
        level: 'moderate',
        factors: [
          { name: 'market_risk', score: 85, weight: 0.2, evidence: [] },
          { name: 'time_risk', score: 85, weight: 0.2, evidence: [] },
          { name: 'liquidity_risk', score: 60, weight: 0.12, evidence: [] },
        ],
        assessedAt: new Date().toISOString(),
      },
      confidence: { score: 38.5, weightedScore: 38.5, threshold: 72, meetsThreshold: false, factors: [], deductions: [], computedAt: new Date().toISOString() },
      marketState: { current: 'PRE_MARKET', previous: null, since: new Date().toISOString(), sessionPhase: 'pre-market', history: [] },
      timeline: [{ at: new Date().toISOString(), time: '09:15', event: 'Market open: NIFTY opened at 24581.3', level: 'info' }],
    } as unknown as ObserveResponse;

    const m = buildDashboardModel(res, false);
    expect(m.regime.label).toBe('RANGING');
    expect(m.confidence.score).toBe(39); // rounded
    expect(m.confidence.threshold).toBe(72);
    expect(m.risk.score).toBe(47);
    expect(m.risk.detail).toBe('Moderate Risk');
    expect(m.state.label).toBe('PRE-MARKET');
    expect(m.observationCount).toBe(1);
    expect(m.radar).toHaveLength(3);
    expect(m.radar[0].label).toBe('Market Volatility'); // market_risk relabeled
    expect(m.observation.headline).toBe('OBSERVING');
    expect(m.timeline[0].time).toBe('09:15');
    expect(m.timeline[0].detail).toContain('Market open');
  });
});
