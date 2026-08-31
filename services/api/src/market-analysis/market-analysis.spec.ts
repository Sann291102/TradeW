import { describe, expect, it, vi, afterEach } from 'vitest';
import { classifySymbol, isNseIndex, NSE_INDEX_SYMBOLS } from './symbol-coverage';
import { assertNoPremiumFields, MarketAnalysisApiService } from './market-analysis.service';

/**
 * The two properties this module exists for.
 *
 *  1. **A crypto symbol never reaches the NSE engine.** Sentinel's provider is
 *     Dhan-only with no simulator fallback, and `apps/web` charts BTC from
 *     Binance through a cross-origin TradingView iframe. Running NSE indicators
 *     over one market and presenting the result beside the other market's chart
 *     is a fabrication, and the test below is a *structural* guard: it asserts
 *     no fetch was made at all, not merely that the answer was refused.
 *
 *  2. **A premium field cannot cross this route.** The free/premium boundary is
 *     "measurements yes, verdict no", and this service is the second of two
 *     independent checks on it.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classifySymbol — NSE coverage', () => {
  it('routes the named indices to the canonical Sentinel snapshot', () => {
    for (const symbol of NSE_INDEX_SYMBOLS) {
      const c = classifySymbol(symbol);
      expect(c.kind, symbol).toBe('nse-canonical');
      expect(c.analysable, symbol).toBe(true);
      expect(c.reason, symbol).toBeNull();
      expect(c.dataSource, symbol).toMatch(/Sentinel canonical MarketSnapshot/);
    }
  });

  it('covers NIFTY and SENSEX specifically', () => {
    expect(isNseIndex('NIFTY')).toBe(true);
    expect(isNseIndex('sensex')).toBe(true);
    expect(classifySymbol('NIFTY').analysable).toBe(true);
    expect(classifySymbol('SENSEX').analysable).toBe(true);
  });

  it('offers an unrecognised equity to the engine rather than guessing at a universe', () => {
    // The Dhan scrip master resolves ~550 symbols and changes; a hardcoded list
    // here would refuse real instruments. If the bridge does not carry it, the
    // provider's own 503 is the answer, and it names the actual reason.
    const c = classifySymbol('RELIANCE');
    expect(c.kind).toBe('nse-canonical');
    expect(c.analysable).toBe(true);
  });

  it('normalises case and whitespace', () => {
    expect(classifySymbol('  nifty ').symbol).toBe('NIFTY');
  });

  it('refuses an empty symbol', () => {
    expect(classifySymbol('   ').analysable).toBe(false);
  });
});

describe('classifySymbol — crypto and FX are a separate data path', () => {
  it('marks every default crypto pair and bare ticker as not analysable', () => {
    for (const symbol of ['BTCUSDT', 'BTC', 'bitcoin', 'ETHUSDT', 'ETH', 'SOL', 'DOGE']) {
      const c = classifySymbol(symbol);
      expect(c.analysable, symbol).toBe(false);
      expect(c.kind, symbol).toBe('crypto');
      expect(c.dataSource, symbol).toMatch(/Binance/);
    }
  });

  it('explains WHY rather than claiming the capability does not exist', () => {
    const c = classifySymbol('BTCUSDT');
    expect(c.reason).toMatch(/NSE\/Dhan/);
    expect(c.reason).toMatch(/Binance/);
    // The refusal has to be about the data path, not about the feature, or the
    // user reasonably concludes analysis is broken.
    expect(c.reason).not.toMatch(/not supported|coming soon|next phase/i);
  });

  it('marks spot-FX pairs as not analysable', () => {
    for (const symbol of ['EURUSD', 'USDINR', 'GBPUSD']) {
      const c = classifySymbol(symbol);
      expect(c.analysable, symbol).toBe(false);
      expect(c.kind, symbol).toBe('fx');
    }
  });
});

describe('MarketAnalysisApiService — BTC never reaches the NSE engine', () => {
  it('short-circuits a crypto request with NO outbound call at all', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const svc = new MarketAnalysisApiService();
    const result = await svc.analyse({ symbol: 'BTCUSDT', timeframe: '15m' });

    // The structural guarantee: not "it refused", but "it never asked".
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.observation).toBeUndefined();
    expect(result.coverage.kind).toBe('crypto');
    expect(result.reason).toMatch(/Binance/);
  });

  it('does call the engine for a supported NSE symbol, with the requested timeframe', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, observation: { symbol: 'NIFTY', timeframe: '15m' } }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const svc = new MarketAnalysisApiService();
    const result = await svc.analyse({ symbol: 'NIFTY', timeframe: '5m' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/market-observation');
    expect(JSON.parse(init.body)).toMatchObject({ symbol: 'NIFTY', timeframe: '5m' });
    expect(result.ok).toBe(true);
    expect(result.coverage.kind).toBe('nse-canonical');
  });

  it('passes a timeframe refusal through as an answer, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, reason: '"4h" is not a timeframe the analysis engine reads.' }),
      }),
    );

    const svc = new MarketAnalysisApiService();
    const result = await svc.analyse({ symbol: 'NIFTY', timeframe: '4h' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('4h');
  });

  it('raises rather than fabricating when the engine has no real data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ message: 'the Dhan bridge is unreachable' }),
      }),
    );

    const svc = new MarketAnalysisApiService();
    await expect(svc.analyse({ symbol: 'NIFTY', timeframe: '15m' })).rejects.toThrow(
      /Dhan bridge is unreachable/,
    );
  });
});

describe('assertNoPremiumFields — the second half of a two-sided check', () => {
  it('strips Sentinel verdict fields and reports which it found', () => {
    const payload: Record<string, unknown> = {
      symbol: 'NIFTY',
      indicators: { rsi14: 63.4 },
      sideInFocus: { side: 'CE' },
      strategyAdvice: { strategyId: 'x' },
      publication: { publish: true },
    };

    const found = assertNoPremiumFields(payload);

    expect(found.sort()).toEqual(['publication', 'sideInFocus', 'strategyAdvice']);
    expect(payload).not.toHaveProperty('sideInFocus');
    expect(payload).not.toHaveProperty('strategyAdvice');
    expect(payload).not.toHaveProperty('publication');
    // Measurements are untouched — the check removes the verdict, it does not
    // discard the read.
    expect(payload.indicators).toEqual({ rsi14: 63.4 });
  });

  it('is a no-op on a clean observation', () => {
    const payload: Record<string, unknown> = { symbol: 'NIFTY', indicators: { rsi14: 63.4 } };
    expect(assertNoPremiumFields(payload)).toEqual([]);
    expect(payload).toEqual({ symbol: 'NIFTY', indicators: { rsi14: 63.4 } });
  });

  it('removes a leaked verdict before it can reach the assistant', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          observation: { symbol: 'NIFTY', indicators: { rsi14: 63.4 }, synthesis: { content: 'buy calls' } },
        }),
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const svc = new MarketAnalysisApiService();
    const result = await svc.analyse({ symbol: 'NIFTY', timeframe: '15m' });

    expect(result.ok).toBe(true);
    expect(result.observation).not.toHaveProperty('synthesis');
    expect(JSON.stringify(result.observation)).not.toContain('buy calls');
  });
});
