import { describe, expect, it } from 'vitest';
import { RequestParserService, yearForNearestOccurrence } from './request-parser.service';
import type { ReasoningGraphService } from '../knowledge/reasoning-graph.service';
import type { ReasonRequest } from '../types';

/**
 * The parser's job is to be boringly correct. Four of these cases are
 * regressions for bugs the assistant control layer actually shipped
 * (`knowledge/Patterns/2026-07-26 - TradeW AI assistant control layer`) — they
 * read fine on the page and only surfaced against real utterances, which is
 * exactly why they are pinned here.
 */

/** The parser only uses the graph for strategy detection. */
const graphStub = { detect: () => [] } as unknown as ReasoningGraphService;
const parser = new RequestParserService(graphStub);

/** A fixed "now" so expiry resolution is deterministic. */
const NOW = new Date(Date.UTC(2026, 6, 26, 6, 0, 0)); // Sun 26 Jul 2026

function parse(query: string, overrides: Partial<ReasonRequest> = {}) {
  return parser.parse({ userId: 'u1', query, ...overrides }, NOW);
}

describe('market resolution', () => {
  it('matches the longest alias first so "bank nifty" is not read as NIFTY', () => {
    // Ordering is load-bearing: a shortest-first table silently opens the
    // wrong instrument, and a wrong-instrument answer is worse than none.
    expect(parse('read bank nifty for me').market.symbol).toBe('BANKNIFTY');
    expect(parse('what is nifty doing').market.symbol).toBe('NIFTY');
    expect(parse('fin nifty structure').market.symbol).toBe('FINNIFTY');
  });

  it('resolves a bare uppercase symbol', () => {
    expect(parse('how does RELIANCE look').market.symbol).toBe('RELIANCE');
  });

  it('does not read a domain abbreviation as a symbol', () => {
    expect(parse('show me the VWAP and RSI').market.symbol).toBe('NIFTY');
  });

  it('records an assumption when it falls back to the default market', () => {
    const understood = parse('what is happening');
    expect(understood.market.symbol).toBe('NIFTY');
    expect(understood.assumptions.some((a) => a.field === 'market')).toBe(true);
  });

  it('lets a structured symbol override free text', () => {
    expect(parse('what is nifty doing', { symbol: 'BANKNIFTY' }).market.symbol).toBe('BANKNIFTY');
  });
});

describe('strike resolution', () => {
  it('does not read the digits inside an index name as a strike', () => {
    // "NIFTY 50 24300" contains two numbers; only one is a strike.
    const understood = parse('NIFTY 50 24300 call');
    expect(understood.market.symbol).toBe('NIFTY');
    expect(understood.strike).toBe(24300);
  });

  it('ignores indicator periods when picking the strike', () => {
    const understood = parse('NIFTY 24300 CE with EMA 20 and RSI 14 on the 15m');
    expect(understood.strike).toBe(24300);
  });

  it('records an assumption when several numbers competed', () => {
    const understood = parse('NIFTY 24300 or 24500 call');
    expect(understood.strike).toBe(24500);
    expect(understood.assumptions.some((a) => a.field === 'strike')).toBe(true);
  });

  it('returns null rather than guessing when no number is present', () => {
    expect(parse('what is NIFTY doing').strike).toBeNull();
  });
});

describe('right resolution', () => {
  it('treats "call" as contract syntax, not a request for a tip', () => {
    // An early advice-refusal pattern matched `calls? (for|on|today)` and
    // refused legitimate contract commands. call/put must stay parseable.
    const understood = parse('NIFTY 24300 call for 21st July');
    expect(understood.right).toBe('CE');
    expect(understood.strike).toBe(24300);
  });

  it('resolves puts', () => {
    expect(parse('BANKNIFTY 52000 put').right).toBe('PE');
  });

  it('pins neither side when both are mentioned, and says so', () => {
    const understood = parse('compare the 24300 call and the 24300 put');
    expect(understood.right).toBeNull();
    expect(understood.assumptions.some((a) => a.field === 'right')).toBe(true);
  });
});

describe('expiry resolution', () => {
  it('picks the NEAREST occurrence, not the next future one', () => {
    // Said on 26 Jul 2026, a bare "21st July" must resolve to Jul 2026 (five
    // days ago), never Jul 2027 — a contract with no liquidity.
    const understood = parse('NIFTY 24300 call for 21st July');
    expect(understood.expiry?.getUTCFullYear()).toBe(2026);
    expect(understood.expiry?.getUTCMonth()).toBe(6);
    expect(understood.expiry?.getUTCDate()).toBe(21);
  });

  it('flags an expiry that has already passed as settled', () => {
    const understood = parse('NIFTY 24300 call for 21st July');
    const assumption = understood.assumptions.find((a) => a.field === 'expiry');
    expect(assumption?.reason).toMatch(/already passed/);
  });

  it('resolves a weekly expiry to the coming Thursday', () => {
    const understood = parse('NIFTY weekly expiry view');
    expect(understood.expiry?.getUTCDay()).toBe(4);
    expect(understood.expiryPhrase).toBe('weekly');
  });

  it('handles month-first phrasing', () => {
    expect(parse('NIFTY calls for July 30').expiry?.getUTCDate()).toBe(30);
  });

  describe('yearForNearestOccurrence', () => {
    it('rolls back to the prior year when that is closer', () => {
      // 2 Jan asked about on 30 Dec: the nearby date is next year's.
      expect(yearForNearestOccurrence(new Date(Date.UTC(2026, 11, 30)), 0, 2)).toBe(2027);
      // 30 Dec asked about on 2 Jan: the nearby date is last year's.
      expect(yearForNearestOccurrence(new Date(Date.UTC(2026, 0, 2)), 11, 30)).toBe(2025);
    });
  });
});

describe('timeframe, style and risk', () => {
  it('reads an explicit timeframe', () => {
    expect(parse('NIFTY on the 5 min').timeframe).toBe('5m');
    expect(parse('NIFTY daily chart').timeframe).toBe('1d');
  });

  it('defaults to 15m and records that it did', () => {
    const understood = parse('what is NIFTY doing');
    expect(understood.timeframe).toBe('15m');
    expect(understood.assumptions.some((a) => a.field === 'timeframe')).toBe(true);
  });

  it('infers style from the timeframe when none is stated', () => {
    expect(parse('NIFTY on the 1 min').style).toBe('scalping');
    expect(parse('NIFTY daily').style).toBe('swing');
  });

  it('prefers a stated style over the inferred one', () => {
    expect(parse('swing view of NIFTY on the 5 min').style).toBe('swing');
  });

  it('reads a stated risk profile', () => {
    expect(parse('conservative read on NIFTY').riskProfile).toBe('conservative');
    expect(parse('aggressive NIFTY setup').riskProfile).toBe('aggressive');
  });
});

describe('indicators and intent', () => {
  it('normalises indicator names', () => {
    const understood = parse('show NIFTY with VWAP, RSI and fibonacci');
    expect(understood.indicators).toEqual(expect.arrayContaining(['vwap', 'rsi', 'fibonacci']));
  });

  it('classifies intent from the phrasing', () => {
    expect(parse('draw the NIFTY chart').intent).toBe('visual-workspace');
    expect(parse('why did you say that').intent).toBe('explain');
    expect(parse('am I revenge trading').intent).toBe('behaviour-review');
    expect(parse('how risky is NIFTY right now').intent).toBe('risk-review');
    expect(parse('what is happening at the 24300 strike').intent).toBe('option-context');
  });

  it('classifies a structured-only request with no query text', () => {
    const understood = parser.parse({ userId: 'u1', symbol: 'NIFTY', strike: 24300 }, NOW);
    expect(understood.intent).toBe('option-context');
    expect(understood.strike).toBe(24300);
  });
});

describe('parse confidence', () => {
  it('is higher for a fully-specified request than a vague one', () => {
    const specific = parse('BANKNIFTY 52000 put weekly expiry 5 min aggressive with VWAP and RSI');
    const vague = parse('what is happening');
    expect(specific.parseConfidence).toBeGreaterThan(vague.parseConfidence);
  });
});
