import { describe, expect, it } from 'vitest';
import { clauses, evaluateCompliance, isExempt, normalize } from './compliance.rules';

/**
 * The advice boundary's test suite.
 *
 * Both directions are load-bearing and neither is optional:
 *
 *   MUST BLOCK — a leak here is a compliance failure (SEBI posture,
 *                TRADEW-OS.md §1).
 *   MUST ALLOW — a false positive here makes the product unable to describe
 *                the market, which is the entire feature. A gate that blocks
 *                "long buildup in RELIANCE" has not been made safe, it has
 *                been made useless.
 */

const block = (t: string) => expect(evaluateCompliance(t).decision, t).toBe('block');
const allow = (t: string) => expect(evaluateCompliance(t).decision, t).toBe('allow');

describe('normalize', () => {
  it('strips zero-width characters used to split keywords', () => {
    expect(normalize('b​uy')).toBe('buy');
  });

  it('folds Cyrillic homoglyphs to Latin', () => {
    expect(normalize('buу')).toBe('buy'); // Cyrillic у
  });

  it('strips markdown emphasis', () => {
    expect(normalize('**buy**')).toBe('buy');
  });

  it('normalises rupee amounts and thousands separators', () => {
    expect(normalize('₹1,400')).toBe('1400');
  });
});

describe('clauses', () => {
  it('splits on contrastive conjunctions so a refusal cannot launder a directive', () => {
    expect(clauses(normalize("I can't give advice, but buy RELIANCE"))).toEqual([
      "i can't give advice",
      'buy reliance',
    ]);
  });

  it('splits on sentence terminators', () => {
    expect(clauses('one. two! three?')).toEqual(['one', 'two', 'three']);
  });
});

describe('MUST BLOCK — direct recommendations', () => {
  it('second-person modal recommendations', () => {
    block('You should buy RELIANCE here.');
    block('You must sell before expiry.');
    block('You need to exit this position.');
    block('You might want to accumulate around 1400.');
    block("You'd better book profits now.");
  });

  it('first-person endorsement', () => {
    block("I'd buy NIFTY at this level.");
    block('I would short Bank NIFTY here.');
    block('I recommend entering RELIANCE.');
    block('I suggest you avoid this stock.');
    block('My recommendation is to hold.');
  });

  it('rating-style verdicts', () => {
    block('RELIANCE is a strong buy at these levels.');
    block('TCS is a buy.');
    block('This is worth buying.');
    block("It's a good time to sell.");
  });
});

describe('MUST BLOCK — imperatives', () => {
  it('bare imperative trade instructions', () => {
    block('Buy RELIANCE.');
    block('Sell half your position.');
    block('Go long above 24300.');
    block('Go short on Bank NIFTY.');
    block('Just exit now.');
    block('Book profits at 24500.');
  });
});

describe('MUST BLOCK — levels that carry instruction', () => {
  it('stop-loss instructions', () => {
    block('Keep a stop-loss at 24200.');
    block('Stop loss at 1380.');
    block('SL at 24150.');
    block('Place your stop below the day low.');
    block('Trail your stop as it moves.');
  });

  it('price targets issued as calls', () => {
    block('Target of 25000 on this move.');
    block('Target: 1450.');
    block('Aim for 24600.');
    block('First target 24450, second 24600.');
  });

  it('entry and exit instructions', () => {
    block('Entry above 24300.');
    block('Buy on dips near support.');
    block('Add at 1390.');
    block('Accumulate on declines.');
    block('Cut your losses here.');
  });

  it('position directives', () => {
    block('Take a long position in NIFTY.');
    block('Initiate a short here.');
    block('Square off before close.');
    block('Stay out of this one.');
  });
});

describe('MUST BLOCK — certainty', () => {
  it('outcomes stated as guaranteed', () => {
    block('NIFTY will definitely hit 25000.');
    block('This is guaranteed to bounce.');
    block("It's going to hit 1450 this week.");
  });
});

describe('MUST ALLOW — descriptive market structure', () => {
  it('participant descriptions', () => {
    allow('Buyers are in control above 24300.');
    allow('Sellers stepped in near the day high.');
    allow('Buying pressure picked up in the last hour.');
    allow('Selling pressure eased after 2pm.');
    allow('The stock sold off into the close.');
  });

  it('Indian F&O positioning vocabulary', () => {
    allow('Long buildup in RELIANCE — open interest rose with price.');
    allow('Short covering drove the move in Bank NIFTY.');
    allow('Short buildup is visible in the 24500 call.');
    allow('Long unwinding in the weekly series.');
    allow('Call writers added at 24500, put writers at 24000.');
  });

  it('institutional flow', () => {
    allow('FIIs bought 1,200 crore in the cash segment.');
    allow('DIIs sold into the rally.');
  });

  it('levels described, not instructed', () => {
    allow('Support at 24300 has held three times this week.');
    allow('Resistance near 24500 coincides with the 20-EMA.');
    allow('Price is consolidating above the 20-EMA with below-average volume.');
  });
});

describe('MUST ALLOW — education', () => {
  it('definitions of the very concepts the rules watch for', () => {
    allow('A stop-loss is an order that closes a position at a set price.');
    allow('A target is the price level a trader plans to exit at.');
    allow('Traders often use VWAP as an intraday reference.');
    allow('Some traders go long when price reclaims VWAP — that is the pattern, not a suggestion.');
  });
});

describe('MUST ALLOW — third-party attribution', () => {
  it('reporting what others say is market information', () => {
    allow('Analysts have a target of 1500 on the stock.');
    allow('According to brokerages, consensus estimates moved higher.');
  });
});

describe('MUST ALLOW — the assistant refusing', () => {
  /**
   * The gate blocking its own refusal is a real and easy bug: refusal copy
   * necessarily contains "buy or sell". If these fail, every boundary probe
   * returns a fail-closed error instead of a clean refusal.
   */
  it('does not block its own refusal copy', () => {
    allow("I can't tell you whether to buy or sell — that's outside what I do.");
    allow('I share observations only, never investment advice.');
    allow("I don't give trade calls, targets or stop-losses.");
    allow("That's not something I can help with — I explain, I don't advise.");
    allow('TradeW AI shares observations only — never investment advice.');
  });
});

describe('evasion', () => {
  it('a refusal prefix does not launder a directive that follows', () => {
    block("I can't give advice, but buy RELIANCE at 1400.");
    block("I'm not able to recommend anything. Buy NIFTY calls.");
  });

  it('descriptive vocabulary elsewhere does not exempt a directive clause', () => {
    block('Buyers are in control. You should buy here.');
    block('Long buildup is visible; go long above 24300.');
  });

  it('zero-width and homoglyph obfuscation still blocks', () => {
    block('You should b​uy RELIANCE.');
    block('Keep a stop-loss at 24200'.replace('o', 'о'));
  });

  it('markdown emphasis does not hide a directive', () => {
    block('**Buy** RELIANCE now.');
  });
});

describe('verdict shape', () => {
  it('reports which rules fired, for audit', () => {
    const v = evaluateCompliance('You should buy RELIANCE. Keep a stop-loss at 1380.');
    expect(v.decision).toBe('block');
    const ids = v.findings.map((f) => f.ruleId);
    expect(ids).toContain('advice.recommendation');
    expect(ids).toContain('advice.stop-loss');
  });

  it('stamps version and timestamp so a stored verdict is interpretable later', () => {
    const v = evaluateCompliance('Support at 24300 held.');
    expect(v.gateVersion).toBeTruthy();
    expect(() => new Date(v.evaluatedAt).toISOString()).not.toThrow();
  });

  it('handles empty and nullish input without throwing', () => {
    expect(evaluateCompliance('').decision).toBe('allow');
    expect(evaluateCompliance(undefined as unknown as string).decision).toBe('allow');
  });
});

describe('isExempt', () => {
  it('treats participant description as exempt', () => {
    expect(isExempt('buyers are in control')).toBe(true);
  });

  it('does not treat a bare directive as exempt', () => {
    expect(isExempt('buy reliance at 1400')).toBe(false);
  });
});
