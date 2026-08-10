import { describe, expect, it } from 'vitest';
import { classify, routeSpecialist } from './intent';

const intentOf = (t: string) => classify(t).intent;
const reasonOf = (t: string) => classify(t).refusalReason;

describe('hard boundaries come first', () => {
  it('refuses requests for a trade decision', () => {
    for (const t of [
      'Should I buy RELIANCE?',
      'should i sell my nifty calls',
      'What should I buy today?',
      'Is NIFTY a good buy here?',
      'Give me a trade for tomorrow',
      'any tips for banknifty',
      'What is the entry point for TCS?',
      'target price for reliance',
      'where should I enter nifty',
      'which strike should I buy',
    ]) {
      expect(intentOf(t), t).toBe('refusal');
      expect(reasonOf(t), t).toBe('advice-boundary');
    }
  });

  it('refuses order requests', () => {
    for (const t of [
      'Place an order for 50 shares of RELIANCE',
      'buy 100 shares of TCS',
      'cancel my order',
      'square off my position',
    ]) {
      expect(intentOf(t), t).toBe('refusal');
      expect(reasonOf(t), t).toBe('order-boundary');
    }
  });

  it('refuses narrating Sentinel but still allows navigating to it', () => {
    expect(reasonOf('explain what Sentinel is saying')).toBe('sentinel-boundary');
    expect(reasonOf('summarise Sentinel’s analysis')).toBe('sentinel-boundary');
    // "Open Sentinel" is a route like any other — must NOT be refused.
    expect(intentOf('open Sentinel')).toBe('command');
  });

  it('boundaries beat in-domain vocabulary', () => {
    // Dense with legitimate market words, still a request for a call.
    expect(intentOf('Given the VWAP and OI structure on NIFTY, should I buy?')).toBe('refusal');
  });

  /**
   * REGRESSION. These reached the analysis path in a live probe against the
   * running API — they ask for the trade parameters without ever using the
   * word "buy", and every pattern in the original set missed them. The output
   * gate would still have caught any advice the model produced, but the
   * request should never have got that far.
   */
  it('refuses requests for trade parameters that never say "buy"', () => {
    for (const t of [
      'Give me an entry, target and stop for NIFTY',
      'give me an entry for banknifty',
      'what is the entry for RELIANCE',
      "what's your target on TCS",
      'show me the stop loss',
      'entry and target for nifty please',
      'entry, target, sl for banknifty',
      'tell me the setup',
    ]) {
      expect(intentOf(t), t).toBe('refusal');
      expect(reasonOf(t), t).toBe('advice-boundary');
    }
  });

  it('still allows the educational questions those words appear in', () => {
    // The rule must not swallow the Learning Assistant's whole remit.
    expect(intentOf('what does stop-loss mean')).toBe('analysis');
    expect(intentOf('how does a target order work')).toBe('analysis');
    expect(intentOf('explain what an entry is in trading')).toBe('analysis');
  });
});

describe('capability', () => {
  it('recognises the capability question', () => {
    expect(intentOf('what can you do')).toBe('capability');
    expect(intentOf('who are you?')).toBe('capability');
  });

  it('treats empty input as a capability prompt rather than an error', () => {
    expect(intentOf('')).toBe('capability');
    expect(intentOf('   ')).toBe('capability');
  });
});

describe('commands', () => {
  it('classifies navigation as a command', () => {
    for (const t of ['open Research', 'show the dashboard', 'go to settings', 'switch to light mode', 'apply the scalping layout']) {
      expect(intentOf(t), t).toBe('command');
    }
  });

  it('classifies instrument navigation as a command, not analysis', () => {
    expect(intentOf('open the NIFTY chart')).toBe('command');
    expect(intentOf('show me the option chain')).toBe('command');
  });
});

describe('analysis', () => {
  it('classifies market questions as analysis', () => {
    for (const t of [
      'What is NIFTY doing today?',
      'How is market breadth looking?',
      'Why did RELIANCE fall?',
      'What does the option chain say about 24500?',
      'Is volatility elevated?',
    ]) {
      expect(intentOf(t), t).toBe('analysis');
    }
  });

  it('flags deictic questions as needing page context', () => {
    expect(classify('explain this').needsPageContext).toBe(true);
    expect(classify('what is this chart showing').needsPageContext).toBe(true);
    expect(classify('what is NIFTY doing').needsPageContext).toBe(false);
  });

  it('treats a bare deictic question as in-domain rather than out-of-remit', () => {
    // "explain this" has no market vocabulary at all, but refers to a TradeW
    // surface. Refusing it would break the headline context-awareness feature.
    expect(intentOf('explain this')).toBe('analysis');
  });
});

describe('remit fence', () => {
  it('refuses questions with nothing to do with markets or the app', () => {
    for (const t of ['What is the capital of France?', 'Write me a poem about cats', 'How do I cook pasta?']) {
      expect(intentOf(t), t).toBe('refusal');
      expect(reasonOf(t), t).toBe('out-of-domain');
    }
  });

  it('allows questions about the application itself', () => {
    expect(intentOf('how do I change the theme in TradeW')).toBe('analysis');
  });
});

describe('specialist routing', () => {
  it('routes to the right specialist', () => {
    expect(routeSpecialist('what is the PCR on NIFTY')).toBe('options');
    expect(routeSpecialist('explain my portfolio allocation')).toBe('portfolio');
    expect(routeSpecialist('why did the market fall, any news?')).toBe('news');
    expect(routeSpecialist('what does VWAP mean')).toBe('learning');
    expect(routeSpecialist('is NIFTY holding support')).toBe('technical');
  });

  it('falls back to general when nothing matches strongly', () => {
    expect(routeSpecialist('how is the market')).toBe('general');
  });

  /**
   * REGRESSION. A bare "what is" used to match the learning lens, so "what is
   * NIFTY doing today" — a live market question — was routed to the concept
   * explainer. Caught against the running API, where the response came back
   * tagged `specialist: "learning"`.
   */
  it('does not treat a market-state question as a concept question', () => {
    expect(routeSpecialist('what is NIFTY doing today')).not.toBe('learning');
    expect(routeSpecialist('what is the market doing')).not.toBe('learning');
    // …while genuine concept questions still land there.
    expect(routeSpecialist('what does VWAP mean')).toBe('learning');
    expect(routeSpecialist('what is a stop-loss order')).toBe('learning');
    expect(routeSpecialist('difference between CNC and MIS')).toBe('learning');
  });
});
