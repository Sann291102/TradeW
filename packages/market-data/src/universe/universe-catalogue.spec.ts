import { describe, expect, it } from 'vitest';
import { BinanceCatalogueSource, toBinanceRecord } from './sources/binance.catalogue';
import { DhanCatalogueSource, classify, toDhanRecord } from './sources/dhan.catalogue';
import { TwelveDataCatalogueSource, toEquityRecord } from './sources/twelvedata.catalogue';
import { describeAvailability } from './sources/registry';
import { dedupe, normalise, preferRecord } from './normalise';
import { buildSearchText, parseUniverseRef, universeRef, type CatalogueRecord } from './universe.contracts';

/**
 * Catalogue ingestion, against fixtures rather than the live providers.
 *
 * The fixtures below are the response shapes each vendor documents, trimmed to
 * the fields the adapters read. Testing against them rather than the network is
 * what makes these assertions reproducible: a provider being slow, rate-limited
 * or unreachable must never be the reason a build fails.
 */

const DHAN_COMPACT = [
  'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_TRADING_SYMBOL,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_SERIES',
  'NSE,E,2885,RELIANCE,EQUITY,0,0,NA,0.05,NA,1,"Reliance Industries Ltd",NA,EQ',
  'BSE,E,500325,RELIANCE,EQUITY,0,0,NA,0.05,NA,1,"Reliance Industries Ltd",NA,A',
  'NSE,E,15083,SGBAUG28,EQUITY,0,0,NA,0.01,NA,1,"Sovereign Gold Bond 2028",NA,SG',
  'NSE,E,1660,NIFTYBEES,ETF,0,0,NA,0.01,NA,1,"Nippon India ETF Nifty 50",NA,EQ',
  'NSE,I,13,NIFTY,INDEX,0,0,NA,0.05,NA,1,"Nifty 50",NA,NA',
].join('\n');

const DHAN_DETAILED = [
  'EXCH_ID,SEGMENT,SECURITY_ID,DISPLAY_NAME,ISIN,INSTRUMENT,SYMBOL_NAME,SERIES',
  'NSE,E,2885,"RELIANCE INDUSTRIES LTD",INE002A01018,EQUITY,RELIANCE,EQ',
  'BSE,E,500325,"RELIANCE INDUSTRIES LTD",INE002A01018,EQUITY,RELIANCE,A',
].join('\n');

function csvFetch(): typeof fetch {
  let call = 0;
  return (async () => {
    const body = call++ === 0 ? DHAN_COMPACT : DHAN_DETAILED;
    return { ok: true, status: 200, statusText: 'OK', text: async () => body } as Response;
  }) as unknown as typeof fetch;
}

async function collect(source: { pages: (o?: never) => AsyncGenerator<{ records: CatalogueRecord[] }> }, options?: never) {
  const out: CatalogueRecord[] = [];
  for await (const page of source.pages(options)) out.push(...page.records);
  return out;
}

describe('universe refs', () => {
  it('round-trips a fully-qualified address', () => {
    const ref = universeRef({ market: 'USA', exchange: 'NASDAQ', symbol: 'aapl' });
    expect(ref).toBe('USA:NASDAQ:AAPL');
    expect(parseUniverseRef(ref)).toEqual({ market: 'USA', exchange: 'NASDAQ', symbol: 'AAPL' });
  });

  it('rejects malformed refs rather than half-parsing them', () => {
    expect(parseUniverseRef('AAPL')).toBeNull();
    expect(parseUniverseRef('MARS:NASDAQ:AAPL')).toBeNull();
    expect(parseUniverseRef('USA::AAPL')).toBeNull();
  });

  it('distinguishes the same ticker on two venues — the reason this table exists', () => {
    // RELIANCE is listed on both NSE and BSE. Instrument.symbol is globally
    // unique and cannot represent both; the universe ref can.
    expect(universeRef({ market: 'INDIA', exchange: 'NSE', symbol: 'RELIANCE' })).not.toBe(
      universeRef({ market: 'INDIA', exchange: 'BSE', symbol: 'RELIANCE' }),
    );
  });
});

describe('Dhan catalogue (India)', () => {
  it('imports NSE and BSE listings of the same company as two distinct rows', async () => {
    const source = new DhanCatalogueSource();
    const records: CatalogueRecord[] = [];
    for await (const page of source.pages({ fetchImpl: csvFetch() })) records.push(...page.records);

    const reliance = records.filter((r) => r.symbol === 'RELIANCE');
    expect(reliance).toHaveLength(2);
    expect(new Set(reliance.map((r) => r.exchange))).toEqual(new Set(['NSE', 'BSE']));
    // Both are rupee-quoted and rupee-settled: no conversion anywhere in India.
    for (const row of reliance) {
      expect(row.quoteCurrency).toBe('INR');
      expect(normalise(row).accountCurrency).toBe('INR');
      expect(normalise(row).requiresFxConversion).toBe(false);
    }
  });

  it('carries the broker addressing needed to actually fetch a quote', async () => {
    const source = new DhanCatalogueSource();
    const records: CatalogueRecord[] = [];
    for await (const page of source.pages({ fetchImpl: csvFetch() })) records.push(...page.records);

    const nse = records.find((r) => r.symbol === 'RELIANCE' && r.exchange === 'NSE')!;
    // Dhan addresses every call by (exchangeSegment, securityId), never by
    // ticker — a row without these cannot be quoted at all.
    expect(nse.securityId).toBe('2885');
    expect(nse.exchangeSegment).toBe('NSE_EQ');
    expect(nse.providerSymbol).toBe('2885');
    expect(nse.isin).toBe('INE002A01018');
  });

  it('classifies rather than discards the non-equity rows in the equity segment', async () => {
    const source = new DhanCatalogueSource();
    const records: CatalogueRecord[] = [];
    for await (const page of source.pages({ fetchImpl: csvFetch() })) records.push(...page.records);

    // A sovereign gold bond is a real listed instrument. The old importer
    // dropped it with the EQ/BE series filter; the universe files it as a bond.
    expect(records.find((r) => r.symbol === 'SGBAUG28')?.assetClass).toBe('BOND');
    expect(records.find((r) => r.symbol === 'NIFTY')?.assetClass).toBe('INDEX');
  });

  it('files an ETF as an ETF even though it trades under series EQ', () => {
    // Most NSE ETFs carry series EQ. A series-first lookup would call every one
    // of them an ordinary share.
    expect(
      classify({
        securityId: '1660',
        exchangeSegment: 'NSE_EQ',
        exchange: 'NSE',
        segment: 'E',
        tradingSymbol: 'NIFTYBEES',
        displayName: 'Nippon India ETF',
        symbolName: 'NIFTYBEES',
        instrument: 'ETF',
        series: 'EQ',
      }),
    ).toBe('ETF');
  });

  it('drops a row from a segment it cannot place rather than guessing a venue', () => {
    expect(
      toDhanRecord({
        securityId: '1',
        exchangeSegment: 'UNKNOWN_SEG' as never,
        exchange: 'XXX',
        segment: 'E',
        tradingSymbol: 'FOO',
        displayName: 'Foo',
        symbolName: 'FOO',
      }),
    ).toBeNull();
  });
});

describe('Twelve Data catalogue (USA / UK / forex)', () => {
  it('refuses to run without a key, instead of reporting an empty catalogue', async () => {
    const source = new TwelveDataCatalogueSource({ apiKey: '' });
    expect(source.isConfigured()).toBe(false);
    // An empty result from a "successful" run is what a sync reads as a mass
    // delisting. Failing loudly is the only safe behaviour.
    await expect(async () => {
      for await (const _ of source.pages()) void _;
    }).rejects.toThrow(/TWELVEDATA_API_KEY/);
  });

  it('reports an unconfigured source as unavailable with a reason', () => {
    const availability = describeAvailability([new TwelveDataCatalogueSource({ apiKey: '' })]);
    expect(availability[0].configured).toBe(false);
    expect(availability[0].reason).toMatch(/TWELVEDATA_API_KEY/);
  });

  it('quotes an LSE line in pence and settles it in dollars', () => {
    const record = toEquityRecord('UK', { exchange: 'LSE', mic: 'XLON' }, 'EQUITY', {
      symbol: 'VOD',
      name: 'Vodafone Group plc',
      currency: 'GBp',
      country: 'United Kingdom',
      type: 'Common Stock',
    });
    expect(record.quoteCurrency).toBe('GBX');

    const normalised = normalise(record);
    expect(normalised.accountCurrency).toBe('USD');
    expect(normalised.requiresFxConversion).toBe(true);
  });

  it('honours a US-quoted LSE line rather than forcing pence on the whole venue', () => {
    const record = toEquityRecord('UK', { exchange: 'LSE', mic: 'XLON' }, 'EQUITY', {
      symbol: 'FOO',
      name: 'Dollar-quoted line',
      currency: 'USD',
    });
    expect(record.quoteCurrency).toBe('USD');
    expect(normalise(record).requiresFxConversion).toBe(false);
  });

  it('quotes a US listing in dollars with no conversion', () => {
    const record = normalise(
      toEquityRecord('USA', { exchange: 'NASDAQ', mic: 'XNAS' }, 'EQUITY', {
        symbol: 'AAPL',
        name: 'Apple Inc',
        currency: 'USD',
        type: 'Common Stock',
      }),
    );
    expect(record.quoteCurrency).toBe('USD');
    expect(record.accountCurrency).toBe('USD');
    expect(record.requiresFxConversion).toBe(false);
    expect(record.ref).toBe('USA:NASDAQ:AAPL');
  });

  it('maps the vendor type vocabulary onto the platform asset classes', () => {
    const asClass = (type: string) =>
      toEquityRecord('USA', { exchange: 'NYSE', mic: 'XNYS' }, 'EQUITY', { symbol: 'X', type }).assetClass;
    expect(asClass('Exchange Traded Fund')).toBe('ETF');
    expect(asClass('American Depositary Receipt')).toBe('DEPOSITARY_RECEIPT');
    expect(asClass('REIT')).toBe('REIT');
    // Unrecognised types fall back to the feed's own class, not to a guess.
    expect(asClass('Something New')).toBe('EQUITY');
  });
});

describe('Binance catalogue (crypto)', () => {
  const sample = (over: Record<string, unknown> = {}) => ({
    symbol: 'BTCUSDT',
    status: 'TRADING',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    isSpotTradingAllowed: true,
    permissions: ['SPOT'],
    filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
      { filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000' },
    ],
    ...over,
  });

  it('reads the exchange lot and tick filters as the exchange states them', () => {
    const record = toBinanceRecord(sample(), 'BTCUSDT', 'BTC', 'USDT');
    expect(record.tickSize).toBe(0.01);
    expect(record.stepSize).toBe(0.00001);
    expect(record.minQty).toBe(0.00001);
    expect(record.assetClass).toBe('CRYPTO_PAIR');
  });

  it('does not declare a stablecoin to be the US dollar', () => {
    const record = normalise(toBinanceRecord(sample(), 'BTCUSDT', 'BTC', 'USDT'));
    expect(record.quoteCurrency).toBe('USDT');
    expect(record.accountCurrency).toBe('USD');
    expect(record.requiresFxConversion).toBe(true);
  });

  it('keeps a BTC-quoted book with its real quote asset', () => {
    const record = normalise(toBinanceRecord(sample({ symbol: 'ETHBTC' }), 'ETHBTC', 'ETH', 'BTC'));
    expect(record.quoteCurrency).toBe('BTC');
    expect(record.displayName).toBe('ETH/BTC');
  });

  it('maps a halted pair to SUSPENDED rather than dropping or delisting it', () => {
    expect(toBinanceRecord(sample({ status: 'BREAK' }), 'BTCUSDT', 'BTC', 'USDT').status).toBe('SUSPENDED');
    expect(toBinanceRecord(sample({ status: 'PENDING_TRADING' }), 'X', 'B', 'Q').status).toBe('INACTIVE');
    // An unrecognised status is UNKNOWN, never optimistically ACTIVE.
    expect(toBinanceRecord(sample({ status: 'SOMETHING_NEW' }), 'X', 'B', 'Q').status).toBe('UNKNOWN');
  });

  it('imports every quote asset, not only USDT', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          symbols: [sample(), sample({ symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC' })],
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const records: CatalogueRecord[] = [];
    for await (const page of new BinanceCatalogueSource().pages({ fetchImpl })) records.push(...page.records);
    // Restricting to USDT would drop the BTC- and ETH-quoted books entirely,
    // which is how most small-cap pairs actually trade.
    expect(records.map((r) => r.symbol)).toEqual(['BTCUSDT', 'ETHBTC']);
  });

  it('excludes a symbol with no spot book', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          symbols: [sample({ symbol: 'FOOUP', isSpotTradingAllowed: false, permissions: ['LEVERAGED'] })],
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    for await (const page of new BinanceCatalogueSource().pages({ fetchImpl })) {
      expect(page.records).toHaveLength(0);
      expect(page.rejected[0].reason).toBe('not spot-tradable');
    }
  });
});

describe('normalisation and de-duplication', () => {
  const base: CatalogueRecord = {
    market: 'USA',
    exchange: 'NASDAQ',
    symbol: 'aapl',
    displayName: '  Apple Inc  ',
    assetClass: 'EQUITY',
    status: 'ACTIVE',
    quoteCurrency: 'USD',
    provider: 'twelvedata',
    providerSymbol: 'AAPL',
  };

  it('upper-cases the ticker, trims the name and derives the ref and search text', () => {
    const record = normalise({ ...base, isin: ' US0378331005 ' });
    expect(record.symbol).toBe('AAPL');
    expect(record.displayName).toBe('Apple Inc');
    expect(record.ref).toBe('USA:NASDAQ:AAPL');
    expect(record.isin).toBe('US0378331005');
    // One lower-cased column so a single trigram index serves ticker, name and
    // ISIN lookups alike.
    expect(record.searchText).toContain('aapl');
    expect(record.searchText).toContain('apple inc');
    expect(record.searchText).toContain('us0378331005');
  });

  it('includes the pair legs in search text so "usdt" finds every USDT book', () => {
    const text = buildSearchText({
      ...base,
      market: 'CRYPTO',
      exchange: 'BINANCE',
      symbol: 'BTCUSDT',
      displayName: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
    });
    expect(text).toContain('usdt');
    expect(text).toContain('btc');
  });

  it('collapses duplicates onto one row per ref and counts them', () => {
    const { records, duplicates } = dedupe([normalise(base), normalise(base), normalise({ ...base, symbol: 'MSFT' })]);
    expect(records).toHaveLength(2);
    // Counted, not silently swallowed: a jump in duplicates is a finding.
    expect(duplicates).toBe(1);
  });

  it('prefers the record that knows more, deterministically', () => {
    const unknown = normalise({ ...base, status: 'UNKNOWN' });
    const known = normalise({ ...base, status: 'ACTIVE' });
    expect(preferRecord(unknown, known)).toBe(known);

    const vague = normalise({ ...base, assetClass: 'OTHER' });
    const specific = normalise({ ...base, assetClass: 'ETF' });
    expect(preferRecord(vague, specific)).toBe(specific);

    const bare = normalise(base);
    const identified = normalise({ ...base, isin: 'US0378331005', figi: 'BBG000B9XRY4' });
    expect(preferRecord(bare, identified)).toBe(identified);

    // Equal candidates leave the incumbent in place — a coin flip would rewrite
    // the row on every sync.
    expect(preferRecord(bare, normalise(base))).toBe(bare);
  });

  it('never lets a source override the account currency for its market', () => {
    // A provider claiming an Indian instrument settles in dollars must not be
    // able to say so: the account currency is product policy, not vendor data.
    const record = normalise({ ...base, market: 'INDIA', exchange: 'NSE', quoteCurrency: 'USD' });
    expect(record.accountCurrency).toBe('INR');
  });
});
