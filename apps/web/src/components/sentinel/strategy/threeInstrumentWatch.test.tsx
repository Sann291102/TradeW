/**
 * "Start watching" watches THREE instruments: the index, a call and a put.
 *
 * ── THE STATE THIS PINS ────────────────────────────────────────────────────
 *
 * Two separate failures lived here, and the screen hid both:
 *
 *   1. The layout put two large CE/PE cards under a heading called "Option
 *      pair under observation", below the market dropdown. It read as "pick
 *      your contracts, the index is a setting above them". The index is the
 *      MARKET instrument — the series the engine takes direction from — so the
 *      layout asserted the opposite of the architecture.
 *
 *   2. The CE/PE toggle is labelled FOCUS and has been non-destructive since
 *      2026-08-18, but nothing rendered said the index was watched at all.
 *
 * Both halves are asserted here: what the form RENDERS (three dropdowns of one
 * kind, in one row, saying all three are watched) and what the form SENDS (a
 * request naming the index, the call and the put, unchanged by the toggle).
 *
 * `renderToStaticMarkup` renders the initial closed state and runs no effects,
 * so what is asserted is the resting form — which is the state the operator
 * reads before clicking anything.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { WatchCreator } from './WatchCreator';
import {
  DEFAULT_SELECTION,
  buildWatchRequest,
  resolveWatchContext,
  selectSide,
  type OptionInstrument,
  type WatchSelection,
} from '@/lib/sentinel/watchState';
import type { UserStrategy } from '@/lib/sentinel/strategyApi';

const EXPIRY = '2026-09-01';

function instrument(strike: number, optionType: 'CE' | 'PE'): OptionInstrument {
  return {
    securityId: optionType === 'CE' ? '46993' : '46994',
    exchangeSegment: 'NSE_FNO',
    dhanInstrument: 'OPTIDX',
    tradingSymbol: `NIFTY-Sep2026-${strike}-${optionType}`,
    displayName: `NIFTY ${strike} ${optionType}`,
    underlying: 'NIFTY',
    expiry: EXPIRY,
    strike,
    optionType,
    lotSize: 75,
    tickSize: 0.05,
  };
}

const SELECTION: WatchSelection = {
  ...DEFAULT_SELECTION,
  symbol: 'NIFTY',
  expiry: EXPIRY,
  focusedSide: 'CE',
  callStrike: 24_200,
  putStrike: 24_200,
  callInstrument: instrument(24_200, 'CE'),
  putInstrument: instrument(24_200, 'PE'),
};

const CE_ROWS = [
  { strike: 24_150, ltp: 121.0 },
  { strike: 24_200, ltp: 97.2 },
  { strike: 24_250, ltp: 78.4 },
];
const PE_ROWS = [
  { strike: 24_150, ltp: 55.1 },
  { strike: 24_200, ltp: 70.0 },
  { strike: 24_250, ltp: 89.3 },
];

const watchContext = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/lib/sentinel/WatchContext', () => ({
  useSentinelWatch: () => watchContext.current,
}));

// The market head is the existing dropdown and is not what is under test; it
// is stubbed so this file does not pull in the 220-symbol universe.
vi.mock('@/components/sentinel/MarketSelector', () => ({
  MarketSelector: ({ value }: { value: string }) => (
    <button type="button">MARKET {value} Nifty 50</button>
  ),
}));

const STRATEGY: UserStrategy = {
  id: 'strat_1',
  userId: 'user_1',
  name: 'A prevailing trend loses its structure and…',
  rules: { timeframe: '15m', levels: [], rules: [], entry: {}, riskManagement: { targets: [] } },
  rawInput: null,
  inputType: 'text',
  status: 'active',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

function render(over: Partial<WatchSelection> = {}) {
  const selection = { ...SELECTION, ...over };
  watchContext.current = {
    selection,
    mode: selection.underlyingOnly ? 'underlying' : 'option',
    instruments: resolveWatchContext(selection),
    expiries: { status: 'ready', expiries: [EXPIRY], unreadableReason: null },
    chain: {
      status: 'live',
      expiry: EXPIRY,
      spot: 24_175.65,
      ce: CE_ROWS,
      pe: PE_ROWS,
      atmIndex: 1,
      fetchedAt: Date.now(),
    },
    legs: { ce: { status: 'resolved' }, pe: { status: 'resolved' } },
    ladders: { status: 'live', ce: CE_ROWS, pe: PE_ROWS, fetchedAt: Date.now() },
    setMarket: () => {},
    setExpiry: () => {},
    setSide: () => {},
    setCallStrike: () => {},
    setPutStrike: () => {},
    setUnderlying: () => {},
    adoptWatch: () => {},
    syncWatches: () => {},
  };
  return renderToStaticMarkup(
    <WatchCreator strategy={STRATEGY} onStart={async () => ({}) as never} />,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The row: one market and two contracts, all three as the same kind of control
// ─────────────────────────────────────────────────────────────────────────────

describe('the Watch row names three instruments', () => {
  it('renders the index, the call and the put side by side', () => {
    const html = render();
    expect(html).toContain('MARKET NIFTY');
    expect(html).toContain('24200 CE');
    expect(html).toContain('24200 PE');
  });

  it('shows each contract’s own resolved identity, not just a strike number', () => {
    const html = render();
    expect(html).toContain('NIFTY-Sep2026-24200-CE');
    expect(html).toContain('id 46993');
    expect(html).toContain('NIFTY-Sep2026-24200-PE');
    expect(html).toContain('id 46994');
  });

  it('reads each leg’s premium from its OWN ladder', () => {
    // 24200 trades at 97.20 as a call and 70.00 as a put. A control reading the
    // wrong column would show a plausible number for the wrong contract.
    const html = render();
    expect(html).toContain('97.20');
    expect(html).toContain('70.00');
  });

  it('says outright that all three are watched, and which one sets direction', () => {
    // The claim the old two-card layout left to be inferred, and inferred wrong.
    const html = render();
    expect(html).toContain('All three are watched together');
    expect(html).toContain('market instrument');
    expect(html).toContain('tradable legs');
  });

  it('no longer presents the contracts as the thing being observed', () => {
    // The heading the two large cards sat under. Its absence is the point: the
    // contracts are not the market.
    expect(render()).not.toContain('Option pair under observation');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Side in focus: preserved, and still incapable of dropping a contract
// ─────────────────────────────────────────────────────────────────────────────

describe('Side in focus is kept, and says what it does', () => {
  it('still offers both sides', () => {
    const html = render();
    expect(html).toContain('Side in focus');
    expect(html).toContain('aria-label="Side in focus"');
  });

  it('states that the other leg stays watched', () => {
    expect(render()).toContain('both legs stay watched');
  });

  it('renders BOTH contracts whichever side is focused', () => {
    for (const focusedSide of ['CE', 'PE'] as const) {
      const html = render({ focusedSide });
      expect(html).toContain('24200 CE');
      expect(html).toContain('24200 PE');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The other controls survived the reshape
// ─────────────────────────────────────────────────────────────────────────────

describe('nothing was removed to compact the layout', () => {
  it('keeps the expiry selector, and says it applies to both contracts', () => {
    const html = render();
    expect(html).toContain('aria-label="Expiry"');
    expect(html).toContain('applies to both contracts');
  });

  it('keeps the underlying-only escape hatch', () => {
    expect(render()).toContain('Watch NIFTY itself instead of an option');
  });

  it('keeps Start watching and the strategy it applies', () => {
    const html = render();
    expect(html).toContain('Start watching');
    expect(html).toContain('A prevailing trend loses its structure and…');
  });

  it('drops the option legs from the screen on an underlying watch', () => {
    const html = render({ underlyingOnly: true });
    expect(html).toContain('no option legs are part of this watch');
    expect(html).not.toContain('24200 CE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What is actually SENT — the half a UI test cannot see
// ─────────────────────────────────────────────────────────────────────────────

describe('the request names all three instruments', () => {
  const build = (s: WatchSelection) => buildWatchRequest(s, 'strat_1', '15m');

  it('carries the index as the symbol and both contracts as legs', () => {
    const req = build(SELECTION);
    expect(req.symbol).toBe('NIFTY');
    expect(req.ce?.securityId).toBe('46993');
    expect(req.pe?.securityId).toBe('46994');
    expect(req.expiry).toBe(EXPIRY);
  });

  it('resolves three addressable instruments from the one selection', () => {
    const ctx = resolveWatchContext(SELECTION);
    expect(ctx.underlying.symbol).toBe('NIFTY');
    expect(ctx.call?.instrument?.optionType).toBe('CE');
    expect(ctx.put?.instrument?.optionType).toBe('PE');
  });

  it('sends the SAME two legs whichever side is in focus', () => {
    // The property the toggle's name has to earn: focus selects nothing and
    // unsubscribes nothing.
    const ce = build(selectSide(SELECTION, 'CE'));
    const pe = build(selectSide(SELECTION, 'PE'));
    expect(ce.ce).toEqual(pe.ce);
    expect(ce.pe).toEqual(pe.pe);
    expect(ce.symbol).toBe(pe.symbol);
    // Only the declared focus differs.
    expect([ce.focusedSide, pe.focusedSide]).toEqual(['CE', 'PE']);
  });
});
