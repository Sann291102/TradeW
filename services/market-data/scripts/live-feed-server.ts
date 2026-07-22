import 'dotenv/config';
import * as http from 'node:http';
import WebSocket = require('ws');
import { DhanMarketFeed, MarketTick, WebSocketLike } from '@tradew/market-data';

/**
 * Standalone live-quote server — deliberately outside services/api and
 * services/market-data's NestJS/Prisma apps.
 *
 * Purpose: prove and demo that DHAN_ACCESS_TOKEN/DHAN_CLIENT_ID deliver real
 * ticks end-to-end into the browser, without waiting on Postgres (unavailable
 * on this machine) or the auth-gated `/market-data/*` routes on services/api.
 * Not a replacement for the Phase 4 pipeline in
 * docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md (no persistence,
 * no reconciliation, no Candle/Quote writes) — a read-only bridge from the
 * already-working DhanMarketFeed client to the dashboard.
 */

const PORT = Number(process.env.DHAN_LIVE_PORT || 4600);

type InstrumentMeta = { symbol: string; displayName: string; securityId: string; exchangeSegment: 'IDX_I' | 'NSE_EQ' | 'MCX_COMM' };

// Security ids confirmed against Dhan's own published scrip master
// (api-scrip-master-detailed.csv), NSE/BSE index segment.
const INDEX_INSTRUMENTS: InstrumentMeta[] = [
  { symbol: 'NIFTY', displayName: 'Nifty 50', securityId: '13', exchangeSegment: 'IDX_I' },
  { symbol: 'BANKNIFTY', displayName: 'Nifty Bank', securityId: '25', exchangeSegment: 'IDX_I' },
  { symbol: 'FINNIFTY', displayName: 'Fin Nifty', securityId: '27', exchangeSegment: 'IDX_I' },
  { symbol: 'SENSEX', displayName: 'BSE Sensex', securityId: '51', exchangeSegment: 'IDX_I' },
  { symbol: 'INDIAVIX', displayName: 'India VIX', securityId: '21', exchangeSegment: 'IDX_I' },
];

// NSE cash-equity security ids, same scrip master. Two names reflect real
// corporate actions the scrip master already carries: Tata Motors demerged
// into Tata Motors Limited (commercial vehicles, ticker TMCV) and Tata Motors
// Passenger Vehicles (TMPV); Zomato renamed to Eternal Limited. Mapped under
// the app's pre-existing symbol keys so TATAMOTORS/ZOMATO widgets light up
// without a data-model rename.
const STOCK_INSTRUMENTS: InstrumentMeta[] = [
  { symbol: 'RELIANCE', displayName: 'Reliance Ind.', securityId: '2885', exchangeSegment: 'NSE_EQ' },
  { symbol: 'INFY', displayName: 'Infosys', securityId: '1594', exchangeSegment: 'NSE_EQ' },
  { symbol: 'TCS', displayName: 'Tata Consultancy Services', securityId: '11536', exchangeSegment: 'NSE_EQ' },
  { symbol: 'HDFCBANK', displayName: 'HDFC Bank', securityId: '1333', exchangeSegment: 'NSE_EQ' },
  { symbol: 'SBIN', displayName: 'State Bank', securityId: '3045', exchangeSegment: 'NSE_EQ' },
  { symbol: 'BAJFINANCE', displayName: 'Bajaj Finance', securityId: '317', exchangeSegment: 'NSE_EQ' },
  { symbol: 'ADANIENT', displayName: 'Adani Ent.', securityId: '25', exchangeSegment: 'NSE_EQ' },
  { symbol: 'HINDUNILVR', displayName: 'HUL', securityId: '1394', exchangeSegment: 'NSE_EQ' },
  { symbol: 'ASIANPAINT', displayName: 'Asian Paints', securityId: '236', exchangeSegment: 'NSE_EQ' },
  { symbol: 'TITAN', displayName: 'Titan Co.', securityId: '3506', exchangeSegment: 'NSE_EQ' },
  { symbol: 'TATAMOTORS', displayName: 'Tata Motors', securityId: '759782', exchangeSegment: 'NSE_EQ' },
  { symbol: 'ZOMATO', displayName: 'Eternal (Zomato)', securityId: '5097', exchangeSegment: 'NSE_EQ' },
  { symbol: 'IRFC', displayName: 'IRFC', securityId: '2029', exchangeSegment: 'NSE_EQ' },
  { symbol: 'YESBANK', displayName: 'Yes Bank', securityId: '11915', exchangeSegment: 'NSE_EQ' },
];

// MCX front-month futures as of the scrip master snapshot taken 2026-07-22 —
// these roll monthly, so the security id here goes stale at each contract's
// expiry (no roll-forward logic yet; a real integration would re-resolve the
// nearest unexpired contract from the scrip master, same as Phase 1's
// instrument sync). Units match COMMODITIES in lib/mock/market.ts.
const COMMODITY_INSTRUMENTS: InstrumentMeta[] = [
  { symbol: 'GOLD', displayName: 'Gold (Aug fut)', securityId: '466583', exchangeSegment: 'MCX_COMM' },
  { symbol: 'SILVER', displayName: 'Silver (Sep fut)', securityId: '471725', exchangeSegment: 'MCX_COMM' },
  { symbol: 'CRUDEOIL', displayName: 'Crude Oil (Aug fut)', securityId: '560977', exchangeSegment: 'MCX_COMM' },
  { symbol: 'NATURALGAS', displayName: 'Natural Gas (Jul fut)', securityId: '538685', exchangeSegment: 'MCX_COMM' },
  { symbol: 'COPPER', displayName: 'Copper (Jul fut)', securityId: '562048', exchangeSegment: 'MCX_COMM' },
];

const ALL_INSTRUMENTS = [...INDEX_INSTRUMENTS, ...STOCK_INSTRUMENTS, ...COMMODITY_INSTRUMENTS];

interface LiveQuote {
  instrumentId: string;
  symbol: string;
  displayName: string;
  ltp: number;
  change: number;
  changePct: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  bid: number;
  ask: number;
  volume: number;
  marketStatus: 'open' | 'closed';
  updatedAt: string;
  source: 'dhan';
}

const byKey = new Map<string, LiveQuote>(); // key: `${kind}:${symbol}`
const sseClients = new Set<http.ServerResponse>();

/** NSE cash session: 09:15-15:30 IST, Mon-Fri. No holiday calendar available
 *  (DHAN-MARKET-DATA-INTEGRATION.md §12 open question 5) — a trading holiday
 *  will show OPEN here when the exchange is actually closed. MCX runs a
 *  separate, longer session (until ~23:30 IST); this flag is reported only
 *  for the NSE-listed indices/stocks, not the commodities. */
function isMarketOpen(now = new Date()): boolean {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

function toLiveQuote(tick: MarketTick, meta: InstrumentMeta): LiveQuote {
  const prevClose = tick.previousClose ?? tick.open ?? tick.ltp ?? 0;
  const ltp = tick.ltp ?? prevClose;
  const change = ltp - prevClose;
  return {
    instrumentId: meta.securityId,
    symbol: meta.symbol,
    displayName: meta.displayName,
    ltp,
    change,
    changePct: prevClose ? (change / prevClose) * 100 : 0,
    open: tick.open ?? null,
    high: tick.high ?? null,
    low: tick.low ?? null,
    close: tick.close ?? null,
    bid: tick.bid ?? 0,
    ask: tick.ask ?? 0,
    volume: tick.volume ?? 0,
    marketStatus: isMarketOpen() ? 'open' : 'closed',
    updatedAt: tick.at.toISOString(),
    source: 'dhan',
  };
}

function snapshot() {
  const indices: LiveQuote[] = [];
  const stocks: LiveQuote[] = [];
  const commodities: LiveQuote[] = [];
  for (const [key, q] of byKey) {
    if (key.startsWith('index:')) indices.push(q);
    else if (key.startsWith('stock:')) stocks.push(q);
    else commodities.push(q);
  }
  return { marketOpen: isMarketOpen(), indices, stocks, commodities };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of sseClients) res.write(payload);
}

let feedStatus = 'idle';
let feedReason: string | undefined;

function kindOf(meta: InstrumentMeta): 'index' | 'stock' | 'commodity' {
  if (INDEX_INSTRUMENTS.includes(meta)) return 'index';
  if (STOCK_INSTRUMENTS.includes(meta)) return 'stock';
  return 'commodity';
}

function startFeed() {
  const accessToken = process.env.DHAN_ACCESS_TOKEN;
  const clientId = process.env.DHAN_CLIENT_ID;
  if (!accessToken || !clientId) {
    console.error('Missing DHAN_ACCESS_TOKEN / DHAN_CLIENT_ID — set them in services/market-data/.env');
    process.exit(1);
  }

  const feed = new DhanMarketFeed({
    accessToken,
    clientId,
    url: process.env.DHAN_FEED_URL,
    webSocketFactory: (url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike,
  });

  feed.onStatus((event) => {
    feedStatus = event.status;
    feedReason = event.reason;
    console.log(`[dhan] ${event.status}${event.reason ? ' — ' + event.reason : ''}`);
  });

  feed.onTick((tick) => {
    const meta = ALL_INSTRUMENTS.find((i) => i.securityId === tick.ref.securityId && i.exchangeSegment === tick.ref.exchangeSegment);
    if (!meta) return;
    byKey.set(`${kindOf(meta)}:${meta.symbol}`, toLiveQuote(tick, meta));
    broadcast();
  });

  feed
    .start()
    .then(() => feed.subscribe(ALL_INSTRUMENTS, 'quote'))
    .catch((err) => console.error('feed failed to start:', err));

  return feed;
}

const feed = startFeed();

// Market can flip open/closed with no tick in between (e.g. right at 15:30);
// re-broadcast on a timer too so the badge in the browser stays honest.
setInterval(broadcast, 30_000);

// ---------------------------------------------------------------------------
// Historical candles — Dhan Data API (REST), the real OHLC history behind the
// TradingView (lightweight-charts) charts. Separate from the live WS feed:
// this is the charged, rate-limited (5 req/sec) Data API, so responses are
// cached briefly to survive a user flipping timeframes and React StrictMode's
// double-mount without burning the daily budget.
// ---------------------------------------------------------------------------

const DHAN_API = 'https://api.dhan.co/v2';
const CANDLE_CACHE_TTL_MS = 60_000;

interface CandleJson {
  timestamp: number; // epoch ms — frontend wraps in new Date()
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
interface DhanChartResponse {
  timestamp?: number[];
  open?: number[];
  high?: number[];
  low?: number[];
  close?: number[];
  volume?: number[];
}

const candleCache = new Map<string, { at: number; candles: CandleJson[] }>();

// App CandleInterval -> Dhan intraday interval (minutes). '1d' uses the
// separate /charts/historical (daily) endpoint instead of /charts/intraday.
const INTRADAY_INTERVAL: Record<string, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60' };

function instrumentTypeFor(meta: InstrumentMeta): string {
  if (meta.exchangeSegment === 'IDX_I') return 'INDEX';
  if (meta.exchangeSegment === 'NSE_EQ') return 'EQUITY';
  return 'FUTCOM';
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Columnar Dhan response -> array-of-candle objects (Candle-shaped, ms ts). */
function toCandles(data: DhanChartResponse): CandleJson[] {
  const { timestamp, open, high, low, close, volume } = data;
  if (!Array.isArray(timestamp) || !open || !high || !low || !close) return [];
  return timestamp.map((t, i) => ({
    timestamp: t * 1000,
    open: open[i],
    high: high[i],
    low: low[i],
    close: close[i],
    volume: volume?.[i] ?? 0,
  }));
}

async function fetchDhanCandles(meta: InstrumentMeta, interval: string, from: Date, to: Date): Promise<CandleJson[]> {
  const accessToken = process.env.DHAN_ACCESS_TOKEN!;
  const isDaily = interval === '1d';
  const body: Record<string, string> = {
    securityId: meta.securityId,
    exchangeSegment: meta.exchangeSegment,
    instrument: instrumentTypeFor(meta),
    fromDate: ymd(from),
    toDate: ymd(to),
  };
  if (!isDaily) body.interval = INTRADAY_INTERVAL[interval] ?? '5';

  const endpoint = isDaily ? `${DHAN_API}/charts/historical` : `${DHAN_API}/charts/intraday`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access-token': accessToken },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Dhan historical ${resp.status}`);
  return toCandles((await resp.json()) as DhanChartResponse);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ marketOpen: isMarketOpen(), feedStatus, feedReason, now: new Date().toISOString() }));
    return;
  }

  if (url.pathname === '/quotes') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(snapshot()));
    return;
  }

  if (url.pathname === '/candles') {
    res.setHeader('Content-Type', 'application/json');
    const symbol = url.searchParams.get('symbol') ?? '';
    const interval = url.searchParams.get('interval') ?? '5m';
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') || 5)));
    const meta = ALL_INSTRUMENTS.find((i) => i.symbol === symbol);
    if (!meta) {
      // Not a symbol the bridge covers — frontend falls back to mock candles.
      res.end(JSON.stringify({ candles: [], source: 'none' }));
      return;
    }
    const cacheKey = `${symbol}:${interval}:${days}`;
    const cached = candleCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CANDLE_CACHE_TTL_MS) {
      res.end(JSON.stringify({ candles: cached.candles, source: 'dhan', cached: true }));
      return;
    }
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    fetchDhanCandles(meta, interval, from, to)
      .then((candles) => {
        candleCache.set(cacheKey, { at: Date.now(), candles });
        res.end(JSON.stringify({ candles, source: 'dhan' }));
      })
      .catch((err) => {
        res.end(JSON.stringify({ candles: [], source: 'error', error: err instanceof Error ? err.message : String(err) }));
      });
    return;
  }

  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`Dhan live-feed bridge listening on http://localhost:${PORT} (no DB, no auth — demo bridge only)`);
});

process.on('SIGINT', async () => {
  await feed.stop();
  server.close();
  process.exit(0);
});
