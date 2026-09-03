import { describe, expect, it } from 'vitest';
import { traceLine, verifyAction, type WorkspaceSnapshot } from './verify';

/**
 * The verifier is the thing that decides whether a tick in the trace means
 * anything. If it is wrong it launders an unchecked claim into a
 * checked-looking one, which is strictly worse than the honest absence it
 * replaced — so its post-conditions are asserted, including the two historical
 * regressions it exists to have caught.
 */

const BASE: WorkspaceSnapshot = {
  route: '/dashboard',
  selectedSymbol: 'NIFTY',
  chartTimeframe: '15m',
  theme: 'dark',
  visiblePanels: ['chart', 'blotter'],
  drawingTags: [],
};

const snap = (over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({ ...BASE, ...over });

describe('navigate', () => {
  it('passes when the route actually moved', () => {
    const v = verifyAction({ type: 'navigate', href: '/trade' }, snap({ route: '/trade' }));
    expect(v).toEqual({ ok: true, detail: 'On /trade' });
  });

  it('fails when the route did not move', () => {
    const v = verifyAction({ type: 'navigate', href: '/trade' }, snap({ route: '/dashboard' }));
    expect(v?.ok).toBe(false);
    expect(v?.detail).toBe('Asked for /trade, still on /dashboard');
  });

  it('ignores the query string, which is not part of the pathname', () => {
    // The crypto venue href is /markets?cat=crypto; the browser reports /markets.
    const v = verifyAction(
      { type: 'navigate', href: '/markets?cat=crypto' },
      snap({ route: '/markets' }),
    );
    expect(v?.ok).toBe(true);
  });

  it('follows a declared redirect rather than calling it a failure', () => {
    // /home redirects to /dashboard. Verifying against the requested path would
    // report a correct navigation as broken — the same lie, pointed the other
    // way.
    const v = verifyAction({ type: 'navigate', href: '/home' }, snap({ route: '/dashboard' }));
    expect(v?.ok).toBe(true);
  });

  it('declines to judge when the route is unknown', () => {
    expect(verifyAction({ type: 'navigate', href: '/trade' }, snap({ route: null }))).toBeNull();
  });
});

describe('the two regressions this exists to catch', () => {
  it('catches a panel flag that nothing renders', () => {
    // Observed: the model emitted showPanel:'discipline' — not a panel that
    // exists — and the dock reported "✓ Open the Discipline panel" while
    // nothing on screen changed.
    const v = verifyAction(
      { type: 'showPanel', panel: 'portfolio' },
      snap({ visiblePanels: ['chart'] }),
    );
    expect(v?.ok).toBe(false);
    expect(v?.detail).toMatch(/didn't render|doesn't render/i);
  });

  it('catches a symbol change that did not take', () => {
    // The ?view= case in kind: URL moved, mounted component kept its state, and
    // the assistant truthfully reported success because from its side it had.
    const v = verifyAction({ type: 'selectSymbol', symbol: 'BTCUSDT' }, snap());
    expect(v?.ok).toBe(false);
    expect(v?.detail).toBe('Asked for BTCUSDT, chart is on NIFTY');
  });
});

describe('chart control and annotation', () => {
  it('confirms a timeframe that landed', () => {
    const v = verifyAction({ type: 'chartTimeframe', timeframe: '5m' }, snap({ chartTimeframe: '5m' }));
    expect(v).toEqual({ ok: true, detail: 'Chart is on 5m' });
  });

  it('reports a timeframe that did not land, naming what is actually shown', () => {
    const v = verifyAction({ type: 'chartTimeframe', timeframe: '5m' }, snap());
    expect(v?.ok).toBe(false);
    expect(v?.detail).toBe('Asked for 5m, chart is on 15m');
  });

  it('confirms drawings appeared, and that clearing removed them', () => {
    expect(verifyAction({ type: 'chartDetect', detector: 'fvg' }, snap({ drawingTags: ['fvg'] }))?.ok).toBe(true);
    expect(verifyAction({ type: 'chartDetect', detector: 'fvg' }, snap({ drawingTags: [] }))?.ok).toBe(false);
    expect(verifyAction({ type: 'chartClearDrawings', tag: 'fvg' }, snap({ drawingTags: [] }))?.ok).toBe(true);
    expect(verifyAction({ type: 'chartClearDrawings', tag: 'fvg' }, snap({ drawingTags: ['fvg'] }))?.ok).toBe(false);
  });

  it('confirms hidePanel by absence, not by the call having been made', () => {
    expect(verifyAction({ type: 'hidePanel', panel: 'blotter' }, snap())?.ok).toBe(false);
    expect(
      verifyAction({ type: 'hidePanel', panel: 'blotter' }, snap({ visiblePanels: ['chart'] }))?.ok,
    ).toBe(true);
  });
});

describe('actions with nothing observable', () => {
  it('returns null rather than inventing a post-condition', () => {
    // A quote lands as its own turn carrying its own provenance; an overlay the
    // user already dismissed is not a failure. Silence is the honest answer.
    expect(verifyAction({ type: 'quote', symbols: ['NIFTY'], ask: 'price' }, snap())).toBeNull();
    expect(verifyAction({ type: 'openOverlay', overlay: 'commandPalette' }, snap())).toBeNull();
    expect(verifyAction({ type: 'toggleSidebar' }, snap())).toBeNull();
    expect(verifyAction({ type: 'applyLayout', layoutId: 'scalping' }, snap())).toBeNull();
  });
});

describe('traceLine', () => {
  it('only writes a tick when a post-condition was checked and held', () => {
    expect(traceLine('Open Trade', 'done', { ok: true, detail: 'On /trade' })).toBe(
      '✓ Open Trade — On /trade',
    );
    expect(traceLine('Open Trade', 'done', { ok: false, detail: 'still on /dashboard' })).toBe(
      '✕ Open Trade — still on /dashboard',
    );
  });

  it('marks an unverifiable step with a neutral mark, not a tick', () => {
    // The old code wrote ✓ for anything that did not throw, which made the tick
    // meaningless — and a meaningless tick is worse than none, because the user
    // reasonably reads it as evidence.
    expect(traceLine('Read NIFTY', 'done', null)).toBe('· Read NIFTY');
  });

  it('reports an execution failure with its error', () => {
    expect(traceLine('Open Trade', 'failed', null, 'boom')).toBe('✕ Open Trade — boom');
  });
});
