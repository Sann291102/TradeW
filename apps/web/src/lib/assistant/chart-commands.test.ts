import { describe, expect, it } from 'vitest';
import { planUtterance, splitUtterance } from './planner';
import { resolveUtterance } from './router';
import { guardHardBoundaries } from './domain-guard';

/**
 * The multi-action chart commands, and the refusal-poisoning bug they exposed.
 *
 * ── THE OBSERVED FAILURE (2026-08-31) ──────────────────────────────────────
 *
 *   > "Find FVG in BTC crypto and draw"
 *
 * resolved perfectly on the whole utterance — `matchDetect` produced a
 * two-action plan. The planner then split it on `and draw` (because `draw` is
 * one of the connective verbs), the bare fragment "draw" carried no market
 * vocabulary of its own, `guardDomain` refused it as off-topic, and that
 * refusal discarded the whole working plan. The user was told the analysis
 * agents were not connected, for a detector sitting right there.
 *
 * The fix distinguishes the two kinds of refusal: a HARD BOUNDARY on a fragment
 * still poisons the plan (that is the whole reason poisoning exists), while an
 * out-of-domain COMPREHENSION guess falls back to the whole-utterance
 * resolution — which is exactly what the split was meant to improve on.
 *
 * The boundary tests below are not optional colour. Adding grammar that matches
 * a previously unmatched phrasing is precisely how a dormant boundary gap goes
 * live, which is the lesson in the Tara chart-drawing note §6.
 */

describe('the "and draw" regression', () => {
  it('"Find FVG in BTC crypto and draw" survives the split and detects', () => {
    const plan = planUtterance('Find FVG in BTC crypto and draw');
    expect(plan.intent).not.toBe('refusal');
    expect(plan.steps.some((s) => s.action.type === 'chartDetect')).toBe(true);
  });

  it('"Find FVG in BTC and draw it" survives the split and detects', () => {
    const plan = planUtterance('Find FVG in BTC and draw it');
    expect(plan.intent).not.toBe('refusal');
    expect(plan.steps.some((s) => s.action.type === 'chartDetect')).toBe(true);
  });

  it('"Find FVG and draw it" survives the split and detects', () => {
    const plan = planUtterance('Find FVG and draw it');
    expect(plan.intent).not.toBe('refusal');
    expect(plan.steps.some((s) => s.action.type === 'chartDetect')).toBe(true);
  });

  it('the split itself is unchanged — the fix is in how a refused fragment is handled', () => {
    // Pinned so a future "fix" that stops splitting on `draw` does not quietly
    // replace this one. The planner still splits; it just no longer lets an
    // out-of-domain fragment veto a plan the whole utterance already produced.
    expect(splitUtterance('Find FVG in BTC crypto and draw')).toEqual([
      'Find FVG in BTC crypto',
      'draw',
    ]);
  });
});

describe('FVG detection behaviour is intact', () => {
  it('"Detect FVG" produces a chartDetect action', () => {
    const plan = planUtterance('Detect FVG');
    expect(plan.steps.some((s) => s.action.type === 'chartDetect')).toBe(true);
  });

  it('"Clear drawings" clears the fvg tag and detects nothing', () => {
    const plan = planUtterance('Clear the fvg drawings');
    expect(plan.steps.map((s) => s.action.type)).toEqual(['chartClearDrawings']);
    expect(plan.steps[0].action).toEqual({ type: 'chartClearDrawings', tag: 'fvg' });
  });

  it('"mark the fair value gaps" still navigates to /trade then detects', () => {
    const plan = planUtterance('mark the fair value gaps');
    expect(plan.steps.map((s) => s.action.type)).toEqual(['navigate', 'chartDetect']);
  });

  it('still refuses to answer an explain-question by drawing rectangles', () => {
    const plan = resolveUtterance('what is a fair value gap');
    expect(plan.actions).toEqual([]);
    expect(plan.intent).toBe('analysis');
  });
});

describe('refusal poisoning still protects the hard boundaries', () => {
  it('an order fragment still poisons a plan whose other half is valid', () => {
    const plan = planUtterance('open the chart then buy 50 lots');
    expect(plan.intent).toBe('refusal');
    expect(plan.refusalReason).toBe('order-boundary');
    expect(plan.steps).toEqual([]);
  });

  it('the bare-"and" order phrasing that once slipped through is still refused', () => {
    const plan = planUtterance('show me the fvg and buy 50 lots of nifty');
    expect(plan.intent).toBe('refusal');
    expect(plan.refusalReason).toBe('order-boundary');
    expect(plan.steps).toEqual([]);
  });

  it('an advice fragment still poisons the plan', () => {
    const plan = planUtterance('open the NIFTY chart then what should I buy');
    expect(plan.intent).toBe('refusal');
    expect(plan.refusalReason).toBe('advice-boundary');
    expect(plan.steps).toEqual([]);

    const recommend = planUtterance('open the chart then recommend a trade');
    expect(recommend.intent).toBe('refusal');
    expect(recommend.steps).toEqual([]);
  });
});

describe('existing navigation and control still work', () => {
  it('resolves a plain navigation command', () => {
    const plan = planUtterance('open Research');
    expect(plan.steps.map((s) => s.action.type)).toEqual(['navigate']);
  });

  it('still splits a genuine multi-command utterance into its parts', () => {
    const plan = planUtterance('open the NIFTY chart then show the option chain');
    expect(plan.steps.length).toBeGreaterThan(1);
  });

  it('still treats "price of nifty and banknifty" as ONE quote for two symbols', () => {
    const plan = planUtterance('price of nifty and banknifty');
    expect(plan.steps.map((s) => s.action.type)).toEqual(['quote']);
  });

  it('still switches theme, opens overlays and toggles panels', () => {
    expect(planUtterance('switch to dark mode').steps[0].action).toEqual({ type: 'setTheme', theme: 'dark' });
    expect(planUtterance('open the command palette').steps[0].action).toEqual({
      type: 'openOverlay',
      overlay: 'commandPalette',
    });
    // Resolves to the Trade workspace route rather than a panel toggle —
    // pre-existing behaviour, pinned so the analyze grammar (which sits above
    // the nav matchers) is shown not to have taken it over.
    expect(planUtterance('show the option chain').steps[0].action.type).toBe('navigate');
  });

  it('still asks before replacing a layout', () => {
    const plan = planUtterance('apply the scalping layout');
    expect(plan.risk).toBe('confirm');
  });
});

// ---------------------------------------------------------------------------
// The policy boundary
// ---------------------------------------------------------------------------

describe('the Sentinel boundary — measurements pass, verdicts do not', () => {
  it('still refuses a request for Sentinel\'s conclusion', () => {
    for (const utterance of [
      'what is Sentinel recommending',
      'explain Sentinel\'s reasoning',
      'summarise what Sentinel detected',
      'what is Sentinel\'s call on NIFTY',
      // Two phrasings that reached NO guard before this change: neither
      // contains an explain phrasing, and both plainly ask for the verdict.
      'what strategy is Sentinel using',
      'sentinel setups today',
      'what is Sentinel\'s confidence',
    ]) {
      const plan = guardHardBoundaries(utterance);
      expect(plan, utterance).not.toBeNull();
      expect(plan!.refusalReason, utterance).toBe('sentinel-boundary');
    }
  });

  it('no longer refuses a pure measurement question that happens to name Sentinel', () => {
    for (const utterance of [
      'what VWAP is Sentinel seeing on NIFTY',
      'what RSI is Sentinel reading',
      'what is the support level Sentinel is observing',
    ]) {
      expect(guardHardBoundaries(utterance), utterance).toBeNull();
    }
  });

  it('refuses when a request reaches for BOTH a measurement and a verdict', () => {
    // The conclusion is the part that would leak, so its presence decides.
    const plan = guardHardBoundaries('what is the RSI and what does Sentinel recommend');
    expect(plan).not.toBeNull();
    expect(plan!.refusalReason).toBe('sentinel-boundary');
  });

  it('the refusal points the user at what they CAN have', () => {
    const plan = guardHardBoundaries('explain what Sentinel is doing');
    expect(plan!.reply).toMatch(/analyse/i);
    expect(plan!.reply).toMatch(/measurements/i);
  });

  it('still lets the user NAVIGATE to Sentinel, verdict vocabulary included', () => {
    // The guard runs above command resolution, so widening it on verdict words
    // could have started refusing a page the user is entitled to open.
    for (const utterance of ['open Sentinel', 'take me to Sentinel', 'open Sentinel strategies']) {
      expect(guardHardBoundaries(utterance), utterance).toBeNull();
    }
    expect(planUtterance('open Sentinel').steps.map((s) => s.action.type)).toEqual(['navigate']);
  });

  it('a navigation verb does NOT rescue an explain-phrasing', () => {
    const plan = guardHardBoundaries('open Sentinel and explain what it found');
    expect(plan).not.toBeNull();
    expect(plan!.refusalReason).toBe('sentinel-boundary');
  });

  it('order and advice boundaries are untouched by the narrowing', () => {
    expect(guardHardBoundaries('place an order for 50 lots')!.refusalReason).toBe('order-boundary');
    expect(guardHardBoundaries('should I buy NIFTY')!.refusalReason).toBe('advice-boundary');
  });
});
