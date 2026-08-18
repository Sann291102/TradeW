/**
 * The two strike selectors, and the property that makes them a PAIR rather
 * than one control with a side switch:
 *
 *     A CONTROL CAN ONLY EVER RETURN A STRIKE FROM THE LADDER IT WAS GIVEN.
 *
 * The CE box is handed `chain.ce`, the PE box `chain.pe`. `strikeOptions` is
 * the only source of anything either one offers, and `resolveTypedStrike` the
 * only thing that accepts typed input — both take that single array. So the
 * isolation is a property of two pure functions plus one prop, and it is
 * asserted that way rather than by driving a DOM.
 *
 * `renderToStaticMarkup` never runs effects and renders the initial state, so
 * the dropdown itself is closed in these renders. What IS rendered from props —
 * the selected strike, its premium, and the resolved contract identity — is
 * asserted here; the list contents are asserted through `strikeOptions`.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StrikeCombobox, strikeOptions } from './StrikeCombobox';
import { resolveTypedStrike, type StrikeRow } from '@/lib/sentinel/optionChain';
import type { OptionInstrument } from '@/lib/sentinel/watchState';

/**
 * Two DELIBERATELY different ladders.
 *
 * Real chains are usually symmetric, which is exactly why a test must not be:
 * with identical ladders every cross-side bug passes. Here 24500 is listed only
 * as a call and 23900 only as a put, so any leakage between the two controls is
 * visible rather than coincidentally correct.
 */
const CE_ROWS: StrikeRow[] = [
  { strike: 24_200, ltp: 210.5 },
  { strike: 24_250, ltp: 180.25 },
  { strike: 24_300, ltp: 152.0 },
  { strike: 24_350, ltp: 128.75 },
  { strike: 24_400, ltp: 104.1 },
  { strike: 24_450, ltp: 83.4 },
  { strike: 24_500, ltp: 65.9 },
];

const PE_ROWS: StrikeRow[] = [
  { strike: 23_900, ltp: 41.2 },
  { strike: 24_200, ltp: 96.3 },
  { strike: 24_250, ltp: 112.8 },
  { strike: 24_300, ltp: 133.45 },
  { strike: 24_350, ltp: 158.0 },
  { strike: 24_400, ltp: 186.6 },
  { strike: 24_450, ltp: 218.2 },
];

const CE_ATM = CE_ROWS.findIndex((r) => r.strike === 24_350);
const PE_ATM = PE_ROWS.findIndex((r) => r.strike === 24_350);

function instrument(strike: number, optionType: 'CE' | 'PE'): OptionInstrument {
  return {
    securityId: `${optionType}-${strike}`,
    exchangeSegment: 'NSE_FNO',
    dhanInstrument: 'OPTIDX',
    tradingSymbol: `NIFTY 18AUG ${strike} ${optionType}`,
    displayName: `NIFTY ${strike} ${optionType}`,
    underlying: 'NIFTY',
    expiry: '2026-08-18',
    strike,
    optionType,
    lotSize: 75,
    tickSize: 0.05,
  };
}

function render(props: Partial<Parameters<typeof StrikeCombobox>[0]> = {}) {
  return renderToStaticMarkup(
    <StrikeCombobox
      side="CE"
      rows={CE_ROWS}
      atmIndex={CE_ATM}
      value={24_350}
      onChange={() => {}}
      instrumentStatus="resolved"
      instrument={instrument(24_350, 'CE')}
      {...props}
    />,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 & 3. Neither control can reach the other side's ladder
// ─────────────────────────────────────────────────────────────────────────────

describe('2 — the CE control cannot offer or accept a PE contract', () => {
  it('never offers a strike that is listed only as a put', () => {
    const offered = strikeOptions(CE_ROWS, CE_ATM, '').map((r) => r.strike);
    expect(offered).not.toContain(23_900);
    expect(PE_ROWS.map((r) => r.strike)).toContain(23_900);
  });

  it('never surfaces a put-only strike through the SEARCH either', () => {
    // The search widens the list to the whole ladder, so it is the path most
    // likely to leak. It searches the same single array.
    expect(strikeOptions(CE_ROWS, CE_ATM, '23900')).toEqual([]);
    expect(strikeOptions(PE_ROWS, PE_ATM, '23900').map((r) => r.strike)).toEqual([23_900]);
  });

  it('refuses a put-only strike typed into the call box', () => {
    expect(resolveTypedStrike(CE_ROWS, '23900')).toEqual({ ok: false, reason: 'not-listed' });
  });

  it('reads the CALL premium for the selected strike, never the put’s', () => {
    // 24350 trades at 128.75 as a call and 158.00 as a put. A control reading
    // the wrong column would show a plausible number for the wrong contract.
    const html = render();
    expect(html).toContain('128.75');
    expect(html).not.toContain('158.00');
  });
});

describe('3 — the PE control cannot offer or accept a CE contract', () => {
  const pe = (props: Partial<Parameters<typeof StrikeCombobox>[0]> = {}) =>
    render({
      side: 'PE',
      rows: PE_ROWS,
      atmIndex: PE_ATM,
      value: 24_350,
      instrument: instrument(24_350, 'PE'),
      ...props,
    });

  it('never offers a strike that is listed only as a call', () => {
    const offered = strikeOptions(PE_ROWS, PE_ATM, '').map((r) => r.strike);
    expect(offered).not.toContain(24_500);
    expect(CE_ROWS.map((r) => r.strike)).toContain(24_500);
  });

  it('never surfaces a call-only strike through the search', () => {
    expect(strikeOptions(PE_ROWS, PE_ATM, '24500')).toEqual([]);
  });

  it('refuses a call-only strike typed into the put box', () => {
    expect(resolveTypedStrike(PE_ROWS, '24500')).toEqual({ ok: false, reason: 'not-listed' });
  });

  it('reads the PUT premium for the selected strike, never the call’s', () => {
    const html = pe();
    expect(html).toContain('158.00');
    expect(html).not.toContain('128.75');
  });

  it('labels itself PE and names its own contract', () => {
    const html = pe();
    expect(html).toContain('24350 PE');
    expect(html).toContain('NIFTY 18AUG 24350 PE');
    expect(html).toContain('PE-24350');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The default window and the readout
// ─────────────────────────────────────────────────────────────────────────────

describe('the default window is the six strikes the brief specifies', () => {
  it('opens on three below the ATM, the ATM, and two above', () => {
    expect(strikeOptions(CE_ROWS, CE_ATM, '').map((r) => r.strike)).toEqual([
      24_200, 24_250, 24_300, 24_350, 24_400, 24_450,
    ]);
  });

  it('searching reaches a listed strike OUTSIDE that window', () => {
    // Otherwise the search box would be decorative and the six-row default a cap.
    expect(strikeOptions(CE_ROWS, CE_ATM, '24500').map((r) => r.strike)).toEqual([24_500]);
  });
});

describe('the readout states what is selected and whether it is addressable', () => {
  it('names the strike, its side and its resolved contract', () => {
    const html = render();
    expect(html).toContain('24350 CE');
    expect(html).toContain('NIFTY 18AUG 24350 CE');
    expect(html).toContain('CE-24350');
  });

  it('says the contract is still resolving rather than showing a stale one', () => {
    expect(render({ instrumentStatus: 'resolving', instrument: null })).toContain('resolving contract');
  });

  it('says a contract could NOT be resolved instead of falling back to the number', () => {
    const html = render({ instrumentStatus: 'unresolvable', instrument: null });
    expect(html).toContain('could not be resolved');
  });

  it('shows an em dash, never a fabricated price, for an unselected leg', () => {
    const html = render({ value: null, instrument: null, instrumentStatus: 'idle' });
    expect(html).toContain('no strike selected');
    expect(html).not.toContain('128.75');
  });

  it('reports how many strikes are genuinely listed', () => {
    expect(render()).toContain('7 listed strikes');
    expect(render({ rows: [], atmIndex: -1, value: null, instrument: null, instrumentStatus: 'idle' })).toContain(
      'no strikes',
    );
  });
});
