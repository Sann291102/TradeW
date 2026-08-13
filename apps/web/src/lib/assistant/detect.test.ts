import { describe, expect, it } from 'vitest';
import { resolveUtterance } from './router';
import { planUtterance } from './planner';
import type { AssistantAction } from './types';

/**
 * Routing for chart detection.
 *
 * The whole point of this file is one collision. `router.ts` resolves commands
 * BEFORE concept questions, so "mark the fair value gaps" and "what is a fair
 * value gap" arrive at the same matcher containing the same words. Getting
 * that wrong answers a question by drawing rectangles on a chart — the exact
 * regression `concepts.ts` was written to fix, reintroduced from the other end
 * of the pipeline. Both directions are pinned here.
 */

function typesOf(text: string): AssistantAction['type'][] {
  return resolveUtterance(text).actions.map((a) => a.type);
}

describe('detection commands', () => {
  it('resolves a bare "FVG" to navigate + detect', () => {
    expect(typesOf('FVG')).toEqual(['navigate', 'chartDetect']);
  });

  it.each([
    'fvg',
    'fvgs',
    'show fvg',
    'mark the fair value gaps',
    'find fair value gaps',
    'show me the imbalances',
    'draw the fair value gap',
  ])('resolves %j as a detection command', (utterance) => {
    expect(typesOf(utterance)).toContain('chartDetect');
  });

  it('names the detector rather than inventing coordinates', () => {
    // The resolver is pure and has no candles — a plan carrying zone prices
    // here would be a plan carrying made-up numbers.
    const action = resolveUtterance('FVG').actions.find((a) => a.type === 'chartDetect');
    expect(action).toEqual({ type: 'chartDetect', detector: 'fvg' });
  });

  it('stays in the free tier — drawing is annotation, not workspace surgery', () => {
    expect(planUtterance('FVG').risk).toBe('free');
  });

  it('describes the step in plain language for the trace', () => {
    expect(planUtterance('FVG').steps.map((s) => s.describe)).toContain('Mark fair value gaps');
  });
});

describe('clearing', () => {
  it.each(['clear the fvgs', 'remove the fair value gaps', 'get rid of the imbalances', 'hide the fvg'])(
    'resolves %j to a tag-scoped clear',
    (utterance) => {
      expect(resolveUtterance(utterance).actions).toEqual([{ type: 'chartClearDrawings', tag: 'fvg' }]);
    },
  );

  it('never clears more than the one tag', () => {
    const [action] = resolveUtterance('clear the fvgs').actions;
    expect(action).toMatchObject({ tag: 'fvg' });
  });
});

describe('the concept collision', () => {
  it.each([
    'what is a fair value gap',
    'what is an fvg',
    "what's an imbalance",
    'how does FVG work',
    'explain fair value gaps',
    'define fvg',
    'teach me about fair value gaps',
  ])('leaves %j to the concept explainer, not the chart', (utterance) => {
    const plan = resolveUtterance(utterance);
    expect(plan.actions).toHaveLength(0);
    expect(plan.intent).toBe('analysis');
  });

  it('still draws when the chart is named as the subject', () => {
    // "what are the FVGs on this chart" is a request to look, not to be taught.
    expect(typesOf('what are the fvgs on this chart')).toContain('chartDetect');
    expect(typesOf('any fair value gaps on screen right now')).toContain('chartDetect');
  });

  it('does not hijack an unrelated utterance that merely rhymes', () => {
    expect(typesOf('open research')).not.toContain('chartDetect');
    expect(typesOf('what is NIFTY trading at')).not.toContain('chartDetect');
  });
});

describe('boundaries still win', () => {
  it('refuses an order even when a detection keyword is present', () => {
    // Hard boundaries are checked on the whole utterance above command
    // resolution; a new command must not become a way around them.
    const plan = resolveUtterance('show me the fvg and buy 50 lots of nifty');
    expect(plan.intent).toBe('refusal');
    expect(plan.actions).toHaveLength(0);
  });

  it('refuses a trade call dressed as a detection request', () => {
    const plan = resolveUtterance('should i buy the fair value gap');
    expect(plan.intent).toBe('refusal');
  });
});
