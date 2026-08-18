import { describe, expect, it } from 'vitest';
import type { OptionChainEntry } from '@tradew/types';
import {
  DEFAULT_STRIKE_POLICY,
  evaluateStrikeCandidates,
  inferStrikeStep,
  nearestListedStrike,
} from './strike-candidates';

const EXPIRY = new Date('2026-08-20T00:00:00Z');

/** A healthy NIFTY-shaped chain: 50-point steps, every leg priced and liquid. */
function chain(
  strikes: number[],
  over: Partial<Record<number, Partial<OptionChainEntry>>> = {},
): OptionChainEntry[] {
  return strikes.map((strike) => ({
    strike,
    expiry: EXPIRY,
    callOI: 50_000,
    putOI: 50_000,
    callVolume: 10_000,
    putVolume: 10_000,
    callIV: 12.5,
    putIV: 13.1,
    callLtp: 120,
    putLtp: 110,
    ...(over[strike] ?? {}),
  }));
}

const LADDER = [24_700, 24_750, 24_800, 24_850, 24_900, 24_950, 25_000];

describe('inferStrikeStep', () => {
  it('takes the modal gap from the chain rather than a hard-coded table', () => {
    // A symbol absent from the interval table still resolves, because the
    // chain itself is the authority on what is listed.
    expect(inferStrikeStep('SOMETHING_NEW', [100, 125, 150, 175, 200])).toBe(25);
  });

  it('survives a chain with a few missing rows by preferring the smaller gap', () => {
    // 24800 is absent, producing one 100-gap among 50-gaps. The listing
    // increment is still 50 — picking 100 would place ITM/OTM on strikes that
    // may not trade.
    expect(inferStrikeStep('NIFTY', [24_700, 24_750, 24_900, 24_950, 25_000])).toBe(50);
  });

  it('falls back to the index convention when the chain is too sparse to infer', () => {
    expect(inferStrikeStep('BANKNIFTY', [52_000])).toBe(100);
  });

  it('returns null for an unknown symbol with an uninferable chain', () => {
    expect(inferStrikeStep('MYSTERY', [123])).toBeNull();
  });
});

describe('nearestListedStrike', () => {
  it('snaps to a strike that actually exists, not a rounded number', () => {
    // 24_912 rounds to 24_900 on a 50-step, and 24_900 is listed here.
    expect(nearestListedStrike(LADDER, 24_912)).toBe(24_900);
  });

  it('never invents a strike the chain does not list', () => {
    const sparse = [24_700, 25_000];
    expect(sparse).toContain(nearestListedStrike(sparse, 24_880));
  });
});

describe('evaluateStrikeCandidates — the three candidates', () => {
  it('evaluates exactly three strikes, one step apart, around ATM', () => {
    const result = evaluateStrikeCandidates({
      symbol: 'NIFTY',
      spot: 24_902,
      side: 'CE',
      chain: chain(LADDER),
    });

    expect(result.atmStrike).toBe(24_900);
    expect(result.strikeStep).toBe(50);
    expect(result.candidates.map((c) => c.strike)).toEqual([24_850, 24_900, 24_950]);
    expect(result.candidates.map((c) => c.role)).toEqual(['ITM', 'ATM', 'OTM']);
  });

  it('puts a CALL in-the-money BELOW spot and a PUT in-the-money ABOVE it', () => {
    const ce = evaluateStrikeCandidates({ symbol: 'NIFTY', spot: 24_902, side: 'CE', chain: chain(LADDER) });
    const pe = evaluateStrikeCandidates({ symbol: 'NIFTY', spot: 24_902, side: 'PE', chain: chain(LADDER) });

    // Getting this backwards would select the contract with the OPPOSITE
    // exposure to the read Sentinel published — the single most damaging
    // possible error in this module.
    expect(ce.candidates.find((c) => c.role === 'ITM')!.strike).toBe(24_850);
    expect(ce.candidates.find((c) => c.role === 'OTM')!.strike).toBe(24_950);
    expect(pe.candidates.find((c) => c.role === 'ITM')!.strike).toBe(24_950);
    expect(pe.candidates.find((c) => c.role === 'OTM')!.strike).toBe(24_850);
  });

  it('signs moneyness positive for in-the-money on either side', () => {
    const ce = evaluateStrikeCandidates({ symbol: 'NIFTY', spot: 24_900, side: 'CE', chain: chain(LADDER) });
    const pe = evaluateStrikeCandidates({ symbol: 'NIFTY', spot: 24_900, side: 'PE', chain: chain(LADDER) });

    expect(ce.candidates.find((c) => c.role === 'ITM')!.moneyness).toBe(50);
    expect(pe.candidates.find((c) => c.role === 'ITM')!.moneyness).toBe(50);
  });

  it('reads premium, OI, volume and IV from the correct leg of the chain', () => {
    const result = evaluateStrikeCandidates({
      symbol: 'NIFTY',
      spot: 24_900,
      side: 'PE',
      chain: chain(LADDER, { 24_900: { putLtp: 88.5, putOI: 41_000, putVolume: 9_100, putIV: 14.2 } }),
    });

    const atm = result.candidates.find((c) => c.role === 'ATM')!;
    expect(atm.premium).toBe(88.5); // the PUT leg, not the call's 120
    expect(atm.openInterest).toBe(41_000);
    expect(atm.volume).toBe(9_100);
    expect(atm.impliedVol).toBe(14.2);
  });
});

describe('evaluateStrikeCandidates — selection', () => {
  it('selects the at-the-money contract when it passes every check', () => {
    const result = evaluateStrikeCandidates({ symbol: 'NIFTY', spot: 24_902, side: 'CE', chain: chain(LADDER) });

    expect(result.selected?.role).toBe('ATM');
    expect(result.selected?.strike).toBe(24_900);
    expect(result.unavailableReason).toBeNull();
  });

  it('records the two rejected candidates rather than dropping them', () => {
    const result = evaluateStrikeCandidates({ symbol: 'NIFTY', spot: 24_902, side: 'CE', chain: chain(LADDER) });

    // "Why this strike" is only answerable if the alternatives survive.
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.filter((c) => c.selected)).toHaveLength(1);
    for (const other of result.candidates.filter((c) => !c.selected)) {
      expect(other.reason).not.toBe('');
    }
  });

  it('falls back to the nearest surviving strike when ATM is unpriced', () => {
    const result = evaluateStrikeCandidates({
      symbol: 'NIFTY',
      spot: 24_902,
      side: 'CE',
      chain: chain(LADDER, { 24_900: { callLtp: undefined } }),
    });

    expect(result.selected).not.toBeNull();
    expect(result.selected!.role).not.toBe('ATM');
    const atm = result.candidates.find((c) => c.role === 'ATM')!;
    expect(atm.tradable).toBe(false);
    expect(atm.checks.find((c) => c.id === 'priced')!.passed).toBe(false);
  });

  it('distinguishes an unpriced leg from a leg priced at zero', () => {
    const unpriced = evaluateStrikeCandidates({
      symbol: 'NIFTY', spot: 24_900, side: 'CE',
      chain: chain(LADDER, { 24_900: { callLtp: undefined } }),
    }).candidates.find((c) => c.role === 'ATM')!;
    const zero = evaluateStrikeCandidates({
      symbol: 'NIFTY', spot: 24_900, side: 'CE',
      chain: chain(LADDER, { 24_900: { callLtp: 0 } }),
    }).candidates.find((c) => c.role === 'ATM')!;

    // A data gap and a real (disqualifying) market price are different facts.
    expect(unpriced.premium).toBeNull();
    expect(unpriced.checks.find((c) => c.id === 'priced')!.passed).toBe(false);
    expect(zero.premium).toBe(0);
    expect(zero.checks.find((c) => c.id === 'priced')!.passed).toBe(true);
    expect(zero.checks.find((c) => c.id === 'premium-band')!.passed).toBe(false);
  });

  it('rejects an illiquid leg and names open interest as the failing check', () => {
    const result = evaluateStrikeCandidates({
      symbol: 'NIFTY',
      spot: 24_902,
      side: 'CE',
      chain: chain(LADDER, { 24_900: { callOI: 12 } }),
    });

    const atm = result.candidates.find((c) => c.role === 'ATM')!;
    expect(atm.tradable).toBe(false);
    expect(atm.checks.find((c) => c.id === 'open-interest')!.passed).toBe(false);
    expect(atm.reason).toContain('open interest');
    expect(result.selected!.role).not.toBe('ATM');
  });

  it('rejects a premium outside the policy band', () => {
    const result = evaluateStrikeCandidates({
      symbol: 'NIFTY',
      spot: 24_902,
      side: 'CE',
      chain: chain(LADDER, { 24_900: { callLtp: DEFAULT_STRIKE_POLICY.maxPremium + 1 } }),
    });

    expect(result.candidates.find((c) => c.role === 'ATM')!.tradable).toBe(false);
  });

  it('marks a strike the chain does not list as not-listed rather than guessing', () => {
    // 24_950 is missing, so the OTM leg for a CE read has no row at all.
    const result = evaluateStrikeCandidates({
      symbol: 'NIFTY',
      spot: 24_902,
      side: 'CE',
      chain: chain([24_700, 24_750, 24_800, 24_850, 24_900, 25_000]),
    });

    const otm = result.candidates.find((c) => c.role === 'OTM')!;
    expect(otm.strike).toBe(24_950);
    expect(otm.premium).toBeNull();
    expect(otm.tradable).toBe(false);
    expect(otm.checks.find((c) => c.id === 'listed')!.passed).toBe(false);
  });
});

describe('evaluateStrikeCandidates — honest degradation', () => {
  it('selects nothing and explains why when every candidate fails', () => {
    const dead = chain(LADDER).map((e) => ({ ...e, callOI: 0, callVolume: 0, callLtp: undefined }));
    const result = evaluateStrikeCandidates({ symbol: 'NIFTY', spot: 24_902, side: 'CE', chain: dead });

    expect(result.selected).toBeNull();
    expect(result.unavailableReason).toBeTruthy();
    // The candidates and their failing checks are still returned — a rejection
    // must be inspectable, not merely a null.
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((c) => !c.tradable)).toBe(true);
  });

  it('reports no chain rather than inventing strikes', () => {
    const result = evaluateStrikeCandidates({ symbol: 'NIFTY', spot: 24_902, side: 'CE', chain: [] });

    expect(result.selected).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.unavailableReason).toContain('No option chain');
  });

  it('refuses to locate a strike without a usable spot price', () => {
    for (const spot of [0, Number.NaN, -1]) {
      const result = evaluateStrikeCandidates({ symbol: 'NIFTY', spot, side: 'CE', chain: chain(LADDER) });
      expect(result.selected).toBeNull();
      expect(result.unavailableReason).toContain('spot');
    }
  });

  it('is deterministic — the same chain and spot always select the same strike', () => {
    const args = { symbol: 'NIFTY', spot: 24_902, side: 'CE' as const, chain: chain(LADDER) };
    const first = evaluateStrikeCandidates(args);
    const second = evaluateStrikeCandidates(args);
    expect(second.selected!.strike).toBe(first.selected!.strike);
  });
});
