/**
 * The autonomous scanner: the flag, the port routing, and the guarantee that
 * a fault is never reported as a quiet market.
 *
 * These use fake sources rather than the network, so they assert the SCANNER's
 * behaviour — which source is chosen, which venue clock is applied, what a
 * data fault becomes. The decision logic itself is already pinned in
 * `@tradew/strategy-core`'s own suite and is deliberately not re-tested here.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { CandleInterval } from '@tradew/types';
import type { ExperimentMarket } from '@tradew/market-data';
import { emaCrossLongFixture } from '@tradew/strategy-core';
import { SetupScannerService, autonomousExecutionEnabled } from './setup-scanner.service';
import { MarketDataUnavailable, type MarketDataRead, type MarketDataSource } from './market-data.port';

/** A source that returns whatever the test hands it. */
class FakeSource implements MarketDataSource {
  readonly calls: { symbol: string; interval: CandleInterval }[] = [];
  constructor(
    readonly id: string,
    readonly markets: readonly ExperimentMarket[],
    private readonly behaviour: (symbol: string) => MarketDataRead,
  ) {}
  async read(symbol: string, interval: CandleInterval): Promise<MarketDataRead> {
    this.calls.push({ symbol, interval });
    return this.behaviour(symbol);
  }
}

/**
 * Bars that produce a real, validated setup.
 *
 * Reuses the strategy-core fixture rather than inventing a second one — if the
 * two drifted, this suite could pass against a market the engine would never
 * actually trade.
 */
const liveBars = (symbol: string): MarketDataRead => {
  const snapshot = emaCrossLongFixture();
  return {
    symbol,
    interval: '15m',
    candles: snapshot.candles,
    lastPrice: snapshot.lastPrice,
    lastDataAt: new Date(),
    marketOpen: true,
    source: 'fake',
  };
};

const build = (dhan: MarketDataSource, binance: MarketDataSource) =>
  new SetupScannerService(dhan as never, binance as never);

describe('SetupScannerService', () => {
  let dhan: FakeSource;
  let binance: FakeSource;
  let scanner: SetupScannerService;

  beforeEach(() => {
    delete process.env.AUTONOMOUS_ENGINE_ENABLED;
    dhan = new FakeSource('dhan-bridge', ['INDIA', 'GOLD'], liveBars);
    binance = new FakeSource('binance', ['CRYPTO'], liveBars);
    scanner = build(dhan, binance);
  });

  describe('observation is not gated by the execution switch', () => {
    it('scans and decides with the ORDER switch absent', async () => {
      // The property the parallel brain depends on. An earlier version refused
      // to scan here, which meant the only way to collect a decision dataset
      // was to grant the brain authority to trade.
      const result = await scanner.scanSymbol('BTCUSDT');
      expect(result.status).toBe('scanned');
      expect(result.candidates.some((c) => c.accepted)).toBe(true);
      expect(binance.calls.map((c) => c.symbol)).toEqual(['BTCUSDT']);
    });

    it('scans identically whatever the execution switch says', async () => {
      const off = await scanner.scanSymbol('BTCUSDT');
      process.env.AUTONOMOUS_ENGINE_ENABLED = 'true';
      const on = await scanner.scanSymbol('BTCUSDT');
      // Same decision either way: the switch is about orders, not about sight.
      expect(on.status).toBe(off.status);
      expect(on.candidates.length).toBe(off.candidates.length);
    });

    it('reports the execution switch as OFF for anything but exactly "true"', () => {
      for (const value of ['1', 'yes', 'TRUE', 'on', '']) {
        process.env.AUTONOMOUS_ENGINE_ENABLED = value;
        expect(autonomousExecutionEnabled()).toBe(false);
      }
      process.env.AUTONOMOUS_ENGINE_ENABLED = 'true';
      expect(autonomousExecutionEnabled()).toBe(true);
    });
  });

  describe('market-data port routing', () => {
    it('routes crypto to Binance and never to the Dhan bridge', async () => {
      await scanner.scanSymbol('BTCUSDT');
      expect(binance.calls.map((c) => c.symbol)).toEqual(['BTCUSDT']);
      expect(dhan.calls).toEqual([]);
    });

    it('routes gold to the Dhan bridge and never to Binance', async () => {
      // MCX runs late, so a mid-session instant is open for it.
      await scanner.scanSymbol('GOLD', new Date('2026-09-09T09:00:00.000Z'));
      expect(dhan.calls.map((c) => c.symbol)).toEqual(['GOLD']);
      expect(binance.calls).toEqual([]);
    });

    it('refuses a symbol the registry marks not tradable, naming why', async () => {
      // GOLDM is registered but has no resolved bridge feed.
      const result = await scanner.scanSymbol('GOLDM');
      expect(result.status).toBe('not-tradable');
      expect(result.detail).toContain('not tradable');
      expect(dhan.calls).toEqual([]);
    });

    it('refuses a symbol that is not in the universe at all', async () => {
      const result = await scanner.scanSymbol('DOGECOIN');
      expect(result.status).toBe('not-tradable');
      expect(result.detail).toContain('not in the tradable universe');
    });

    it('asks each venue its OWN clock rather than one calendar for all three', async () => {
      // 03:00 UTC = 08:30 IST: before the NSE open, but crypto never closes.
      const preOpen = new Date('2026-09-09T03:00:00.000Z');
      expect((await scanner.scanSymbol('NIFTY', preOpen)).status).toBe('skipped-closed');
      expect((await scanner.scanSymbol('BTCUSDT', preOpen)).status).toBe('scanned');
    });
  });

  describe('faults are not quiet markets', () => {
    it('reports a source fault as data-unavailable, not as "no setups"', async () => {
      const broken = new FakeSource('binance', ['CRYPTO'], () => {
        throw new MarketDataUnavailable('BTCUSDT', 'binance', 'provider refused the credential');
      });
      const s = build(dhan, broken);

      const result = await s.scanSymbol('BTCUSDT');
      expect(result.status).toBe('data-unavailable');
      expect(result.candidates).toEqual([]);
      // The distinction the 2026-08-17 incident was made of: this must name
      // OUR failure to find out, not assert a fact about the market.
      expect(result.detail).toContain('provider refused the credential');
    });

    it('treats a genuinely short history as a decision, not a fault', async () => {
      const thin = new FakeSource('binance', ['CRYPTO'], (symbol) => ({
        ...liveBars(symbol),
        candles: liveBars(symbol).candles.slice(-5),
      }));
      const s = build(dhan, thin);

      const result = await s.scanSymbol('BTCUSDT');
      expect(result.status).toBe('scanned');
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].rejectionReason).toBe('insufficient-history');
    });
  });

  describe('the decision it reaches', () => {
    it('finds its own setup and derives a 3R plan, with no Sentinel involved', async () => {
      const result = await scanner.scanSymbol('BTCUSDT');
      const taken = result.candidates.find((c) => c.accepted);

      expect(taken).toBeDefined();
      expect(taken!.plan!.plannedRR).toBe(3);
      expect(taken!.market).toBe('CRYPTO');
      // The explanation traces to rules that fired, not to a template.
      expect(taken!.explanation).toContain('Entered long on BTCUSDT');
    });

    it('reports how fresh the data was', async () => {
      const result = await scanner.scanSymbol('BTCUSDT');
      expect(result.dataAgeSeconds).not.toBeNull();
      expect(result.dataAgeSeconds!).toBeLessThan(5);
    });

    it('decides on the last CLOSED bar, never on the live ticker', async () => {
      // Architectural decision (A): the decision price is the last closed bar.
      // A live ticker does not exist in historical data, so a brain deciding on
      // one could never be replayed by the backtester — and "backtest and live
      // call the same core" would be false in the only way that matters.
      const snapshot = emaCrossLongFixture();
      const closedClose = snapshot.candles[snapshot.candles.length - 1].close;

      const wildTicker = new FakeSource('binance', ['CRYPTO'], (symbol) => ({
        ...liveBars(symbol),
        // A ticker miles away from the bar. If the decision read it, the entry
        // would follow it.
        lastPrice: closedClose * 1.5,
      }));
      const s = build(dhan, wildTicker);
      const result = await s.scanSymbol('BTCUSDT');
      const taken = result.candidates.find((c) => c.accepted);

      expect(taken).toBeDefined();
      expect(taken!.plan!.entry).toBeCloseTo(closedClose, 2);
      expect(taken!.features.lastPrice).toBeCloseTo(closedClose, 2);
    });

    it('still uses the live ticker for FRESHNESS, which is a different question', async () => {
      // Discarding it would lose the only signal that says whether the feed is
      // alive as opposed to merely reachable.
      const result = await scanner.scanSymbol('BTCUSDT');
      expect(result.dataAgeSeconds).not.toBeNull();
    });

    it('reaches the same decision however many times the same bar is polled', async () => {
      // The property the learning dataset depends on: one bar, one market
      // state, one answer. Poll timing must not be able to change it.
      const decisions: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const r = await scanner.scanSymbol('BTCUSDT');
        decisions.push(
          r.candidates.map((c) => `${c.setupId}:${c.accepted}:${c.plan?.entry ?? '-'}`).join('|'),
        );
      }
      expect(new Set(decisions).size).toBe(1);
    });

    it('scans several instruments in one pass', async () => {
      const results = await scanner.scanAll(['BTCUSDT', 'NIFTY'], new Date('2026-09-09T06:00:00.000Z'));
      expect(results.map((r) => r.symbol)).toEqual(['BTCUSDT', 'NIFTY']);
      expect(results.every((r) => r.status === 'scanned')).toBe(true);
    });
  });
});

/**
 * Module source files only.
 *
 * A `.spec` naming a forbidden symbol inside its own assertion is not a
 * dependency on it — without this the test below fails on itself, which is a
 * false positive that would eventually be silenced by weakening the rule.
 */
const isModuleFile = (f: string): boolean => f.endsWith('.ts') && !f.endsWith('.spec.ts');

describe('Sentinel independence', () => {
  it('no file in the module imports anything OUTSIDE it that names Sentinel', async () => {
    // A structural assertion, not a behavioural one. The requirement is that
    // this engine decides with Sentinel switched off, and the way that stays
    // true under future edits is that nothing here can reach a Sentinel
    // service, client or DTO.
    //
    // A LOCAL file may be named for Sentinel — `sentinel-benchmark.service.ts`
    // records what the production brain concluded, by reading a table Sentinel
    // already writes. That is an observation of its output, not a dependency
    // on it: with Sentinel off the query returns nothing and the brain is
    // unaffected. What must never appear is an import that leaves this
    // directory and lands in Sentinel.
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = __dirname;

    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter(isModuleFile)) {
      const body = readFileSync(join(dir, file), 'utf8');
      for (const match of body.matchAll(/from\s+'([^']+)'/g)) {
        const spec = match[1];
        if (!/sentinel/i.test(spec)) continue;
        // Permitted only if it is a sibling file in this same directory.
        const isLocalSibling =
          spec.startsWith('./') && existsSync(join(dir, `${spec.slice(2)}.ts`));
        if (!isLocalSibling) offenders.push(`${file}: ${spec}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('constructs no Sentinel client anywhere in the module', async () => {
    // The old path's coupling was a single injected client
    // (`SentinelExecutionClient`). Naming it here means a future edit that
    // reintroduces it fails a test rather than passing review.
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    for (const file of readdirSync(__dirname).filter(isModuleFile)) {
      const body = readFileSync(join(__dirname, file), 'utf8');
      expect(body).not.toMatch(/SentinelExecutionClient|SentinelApiService/);
    }
  });
});
