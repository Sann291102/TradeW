import { describe, expect, it } from 'vitest';
import { formatBreadth, formatCashFlow, formatPositioning, resolveFlowQuestion } from './flows';
import { resolveUtterance } from './router';
import type { BreadthSnapshot, FiiDiiFlow, ParticipantOi } from '../sentinel/nse';

/**
 * The institutional-data resolver. Two things are being pinned here:
 *
 *  1. It classifies only what it can answer completely — a judgement question
 *     that happens to mention FIIs must fall through to the analysis fallback
 *     rather than being answered with a flow number.
 *  2. Every answer carries its SESSION. FII/DII is an end-of-day publication
 *     with no intraday equivalent, so an undated answer given during market
 *     hours silently describes the wrong day.
 */

describe('resolveFlowQuestion — what it claims', () => {
  it('classifies cash-flow questions', () => {
    for (const q of [
      'were FIIs buying today',
      'did DIIs sell yesterday',
      'what was the FII activity',
      'FII inflow',
      'show me institutional flows',
    ]) {
      expect(resolveFlowQuestion(q)?.ask).toBe('cash');
    }
  });

  it('classifies breadth questions without needing a participant named', () => {
    for (const q of ['what is the market breadth', 'advance decline ratio', 'how many stocks are advancing']) {
      expect(resolveFlowQuestion(q)?.ask).toBe('breadth');
    }
  });

  it('classifies derivatives positioning', () => {
    for (const q of [
      'how are FIIs positioned in index futures',
      'FII open interest',
      'are DIIs long or short',
      'FII oi',
    ]) {
      expect(resolveFlowQuestion(q)?.ask).toBe('positioning');
    }
  });

  it('prefers positioning over cash when a question contains both', () => {
    // "did FIIs buy futures" has a cash verb and a derivatives noun. The
    // derivatives reading is the more specific answer.
    expect(resolveFlowQuestion('did FIIs buy index futures')?.ask).toBe('positioning');
  });
});

describe('resolveFlowQuestion — what it refuses to claim', () => {
  it('declines judgement questions even when they name FIIs', () => {
    for (const q of [
      'should I follow the FII flow',
      'is the FII buying bullish',
      'what does FII selling mean for nifty',
      'will FIIs keep buying',
    ]) {
      expect(resolveFlowQuestion(q)).toBeNull();
    }
  });

  it('answers a factual question about selling rather than refusing the verb', () => {
    // The distinction this file exists to hold. "Sell" in a PRICE question
    // signals advice-seeking; here it is what the dataset records. Refusing
    // these would decline to report a published number because the number is
    // about selling. Regression cover for exactly that over-refusal.
    expect(resolveFlowQuestion('did DIIs sell yesterday')?.ask).toBe('cash');
    expect(resolveFlowQuestion('how much did FIIs buy last session')?.ask).toBe('cash');
  });

  it('still declines a forward-looking question whatever its subject', () => {
    // "will (?:it|the market|nifty)" would have missed "will FIIs…" — any
    // "will X" question about flow is a prediction, not a lookup.
    expect(resolveFlowQuestion('will FIIs keep buying')).toBeNull();
    expect(resolveFlowQuestion('will DIIs support the market')).toBeNull();
  });

  it('declines an open-interest question with no participant named', () => {
    // "open interest on the 24400 CE" is an option-chain question about one
    // strike. Claiming it would answer a different question confidently.
    expect(resolveFlowQuestion('what is the open interest on NIFTY 24400 CE')).toBeNull();
    expect(resolveFlowQuestion('show me open interest')).toBeNull();
  });

  it('declines unrelated utterances', () => {
    for (const q of ['open the option chain', 'what is NIFTY trading at', 'what is a fair value gap']) {
      expect(resolveFlowQuestion(q)).toBeNull();
    }
  });
});

describe('router integration', () => {
  it('routes an institutional question to a single marketFlow action', () => {
    const plan = resolveUtterance('were FIIs net buyers today');
    expect(plan.intent).toBe('quote');
    expect(plan.actions).toEqual([{ type: 'marketFlow', ask: 'cash' }]);
  });

  it('still refuses a trade-advice question that mentions FIIs', () => {
    // The hard boundaries run ABOVE this resolver; that ordering is the
    // contract, and a flow question must not be a way around it.
    const plan = resolveUtterance('should I buy nifty because FIIs are buying');
    expect(plan.intent).toBe('refusal');
  });

  it('does not shadow a price question', () => {
    // Quotes resolve first. "what is the FII price" is nonsense, but
    // "what is NIFTY trading at" must never reach the flow resolver.
    expect(resolveUtterance('what is NIFTY 50 trading at').actions[0]?.type).toBe('quote');
  });

  it('carries no URL, path or dataset name in the action', () => {
    // The whole boundary in one assertion: the agent names an ASK, never a
    // destination, so nothing it emits can decide what the server fetches.
    const action = resolveUtterance('FII open interest').actions[0];
    expect(Object.keys(action!).sort()).toEqual(['ask', 'type']);
  });
});

// ------------------------------------------------------------------ answers

const flow: FiiDiiFlow = {
  session: '14-Aug-2026',
  rows: [
    { category: 'FII', date: '14-Aug-2026', buy: 12854.44, sell: 12346.32, net: 508.12 },
    { category: 'DII', date: '14-Aug-2026', buy: 14295.49, sell: 13939.09, net: 356.4 },
  ],
  fetchedAt: '2026-08-16T00:12:54.311Z',
};

describe('formatCashFlow', () => {
  it('names the session the figures belong to', () => {
    expect(formatCashFlow(flow)).toContain('14-Aug-2026');
  });

  it('states plainly that there is no intraday equivalent', () => {
    // Without this, an answer given at 11am reads as today's flow.
    expect(formatCashFlow(flow)).toContain('no intraday');
  });

  it('reports the direction as what happened, not as a read', () => {
    const text = formatCashFlow(flow);
    expect(text).toContain('net buyers');
    // "Net buyers" is a fact about a completed session. "Bullish" would be an
    // interpretation, which belongs to the analysis agents.
    expect(text).not.toMatch(/bullish|bearish|expect|should/i);
  });

  it('reports a null net as not published, never as zero', () => {
    const text = formatCashFlow({
      ...flow,
      rows: [{ category: 'FII', date: '14-Aug-2026', buy: null, sell: null, net: null }],
    });
    expect(text).toContain('not published');
    expect(text).not.toContain('0 Cr');
  });

  it('says so when nothing has been published at all', () => {
    expect(formatCashFlow({ session: null, rows: [], fetchedAt: '' })).toContain("hasn't published");
  });
});

describe('formatBreadth', () => {
  const breadth: BreadthSnapshot = {
    index: 'NIFTY 50',
    last: 24366,
    percentChange: -0.12,
    advances: 10,
    declines: 39,
    unchanged: 1,
    fetchedAt: '2026-08-16T00:12:54.356Z',
  };

  it('reports the constituent counts', () => {
    const text = formatBreadth(breadth);
    expect(text).toContain('10 advancing');
    expect(text).toContain('39 declining');
  });

  it('draws no conclusion from a lopsided count', () => {
    // 10 up against 39 down is exactly where a formatter is tempted to add
    // "weak breadth". That is a read.
    expect(formatBreadth(breadth)).not.toMatch(/weak|strong|negative|poor|healthy/i);
  });

  it('says so rather than reporting zero when the counts are missing', () => {
    const text = formatBreadth({ ...breadth, advances: null, declines: null });
    expect(text).toContain("didn't return");
    expect(text).not.toContain('0 advancing');
  });
});

describe('formatPositioning', () => {
  const oi: ParticipantOi = {
    session: 'Aug 14, 2026',
    rows: [
      {
        participant: 'FII',
        futureIndexLong: 25537,
        futureIndexShort: 202235,
        optionIndexCallLong: 537355,
        optionIndexPutLong: 975053,
        totalLong: 5668106,
        totalShort: 5031758,
      },
    ],
    fetchedAt: '2026-08-16T00:12:54.400Z',
  };

  it('reports both sides and their ratio', () => {
    const text = formatPositioning(oi);
    expect(text).toContain('25,537 long');
    // Lakh grouping, not thousands — `en-IN` renders 202235 as "2,02,235".
    // Pinned because it is a real product decision for an Indian platform and
    // the two groupings are easy to "correct" into each other by accident.
    expect(text).toContain('2,02,235 short');
    expect(text).toContain('7.9× short');
  });

  it('names the session and the unit', () => {
    const text = formatPositioning(oi);
    expect(text).toContain('Aug 14, 2026');
    // Contracts, not rupees — conflating the two would misstate the size by
    // orders of magnitude.
    expect(text).toContain('contracts');
  });

  it('does not interpret a short-heavy book', () => {
    expect(formatPositioning(oi)).not.toMatch(/bearish|bullish|expect|likely|suggests/i);
  });

  it('skips a participant whose futures columns were not published', () => {
    const text = formatPositioning({
      ...oi,
      rows: [{ ...oi.rows[0], futureIndexLong: null, futureIndexShort: null }],
    });
    expect(text).not.toContain('FII —');
  });
});
