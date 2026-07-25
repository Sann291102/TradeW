import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import type { CandleInterval } from '@tradew/types';

/**
 * Historical candle backfill — Dhan REST → Postgres `Candle` (Migration 2).
 *
 * Fills the gap that blocked Sentinel's Trap Detection, Charts, and the
 * TradingView datafeed: OHLC+volume *history* at a timeframe, not a single
 * Quote snapshot (MARKET-DATA-ARCHITECTURE.md §3/§5, DHAN-...-INTEGRATION.md
 * Phase 3). Runs fine while the market is closed — historical/intraday REST
 * returns past sessions regardless of market hours, so tonight's backfill is
 * real data even though the live tick feed only wakes at 09:15 IST.
 *
 * Deliberately a standalone script (like live-feed-server.ts), not part of the
 * NestJS ingestor: idempotent, safe to re-run, addresses instruments the DB
 * already maps to a Dhan (exchangeSegment, securityId).
 *
 *   npm run backfill:candles                                  # defaults below
 *   npm run backfill:candles -- --symbols NIFTY,RELIANCE --timeframes 15m,1d --days 60
 *
 * Idempotent: every bar is upserted on @@unique([instrumentId, timeframe,
 * bucketStart]); re-running refreshes values without creating duplicates.
 */

const DHAN_BASE = 'https://api.dhan.co/v2';
const ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN;
const CLIENT_ID = process.env.DHAN_CLIENT_ID;

// Dhan addresses intraday and daily through two different endpoints. Map each
// @tradew/types CandleInterval to the endpoint + the minute-interval Dhan wants.
const INTRADAY_INTERVAL: Partial<Record<CandleInterval, string>> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
};

interface DhanCandles {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  timestamp: number[]; // epoch seconds, UTC
}

interface InstrumentRow {
  id: string;
  symbol: string;
  securityId: string | null;
  exchangeSegment: string | null;
  dhanInstrument: string | null;
}

function parseArgs(argv: string[]): { symbols: string[]; timeframes: CandleInterval[]; days: number } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const symbols = (get('--symbols') ?? 'NIFTY,BANKNIFTY,FINNIFTY,RELIANCE,COALINDIA')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const timeframes = (get('--timeframes') ?? '15m,1d')
    .split(',')
    .map((s) => s.trim() as CandleInterval)
    .filter(Boolean);
  const days = Number.parseInt(get('--days') ?? '90', 10);
  return { symbols, timeframes, days };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchDhanCandles(
  inst: InstrumentRow,
  timeframe: CandleInterval,
  fromDate: string,
  toDate: string,
): Promise<DhanCandles> {
  const isDaily = timeframe === '1d';
  const url = `${DHAN_BASE}/charts/${isDaily ? 'historical' : 'intraday'}`;
  const body: Record<string, unknown> = {
    securityId: inst.securityId,
    exchangeSegment: inst.exchangeSegment,
    instrument: inst.dhanInstrument,
    fromDate,
    toDate,
    oi: false,
  };
  if (isDaily) {
    body.expiryCode = 0; // required for non-derivative daily history
  } else {
    body.interval = INTRADAY_INTERVAL[timeframe];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'access-token': ACCESS_TOKEN!,
      'client-id': CLIENT_ID!,
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as Partial<DhanCandles> & { errorMessage?: string; errorType?: string };
  if (!res.ok || !Array.isArray(json.timestamp)) {
    const detail = json.errorMessage ?? json.errorType ?? JSON.stringify(json).slice(0, 200);
    throw new Error(`Dhan ${res.status} for ${inst.symbol} ${timeframe}: ${detail}`);
  }
  return json as DhanCandles;
}

/** A bar with equal OHLC and zero volume is Dhan's non-traded placeholder
 *  (holiday/pre-open/forming trailing bar), not a real doji — drop it. */
function isPlaceholder(c: DhanCandles, i: number): boolean {
  return (
    c.volume[i] === 0 &&
    c.open[i] === c.high[i] &&
    c.high[i] === c.low[i] &&
    c.low[i] === c.close[i]
  );
}

async function main() {
  if (!ACCESS_TOKEN || !CLIENT_ID) {
    console.error('Missing DHAN_ACCESS_TOKEN / DHAN_CLIENT_ID in services/market-data/.env');
    process.exit(1);
  }

  const { symbols, timeframes, days } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const fromDate = ymd(from);
  const toDate = ymd(to);

  console.log(`Backfill window: ${fromDate} → ${toDate} (${days}d)`);
  console.log(`Symbols:    ${symbols.join(', ')}`);
  console.log(`Timeframes: ${timeframes.join(', ')}\n`);

  const instruments = await prisma.instrument.findMany({
    where: { symbol: { in: symbols } },
    select: { id: true, symbol: true, securityId: true, exchangeSegment: true, dhanInstrument: true },
  });
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i as InstrumentRow]));

  let totalWritten = 0;
  for (const symbol of symbols) {
    const inst = bySymbol.get(symbol);
    if (!inst) {
      console.warn(`  ! ${symbol}: not in Instrument table — skipped`);
      continue;
    }
    if (!inst.securityId || !inst.exchangeSegment || !inst.dhanInstrument) {
      console.warn(`  ! ${symbol}: missing Dhan mapping (securityId/exchangeSegment/instrument) — skipped`);
      continue;
    }

    for (const timeframe of timeframes) {
      if (timeframe !== '1d' && !INTRADAY_INTERVAL[timeframe]) {
        console.warn(`  ! ${symbol} ${timeframe}: unsupported timeframe — skipped`);
        continue;
      }
      try {
        const c = await fetchDhanCandles(inst, timeframe, fromDate, toDate);
        const n = c.timestamp.length;
        let written = 0;
        let skipped = 0;

        for (let i = 0; i < n; i++) {
          if (isPlaceholder(c, i)) {
            skipped++;
            continue;
          }
          const bucketStart = new Date(c.timestamp[i] * 1000);
          await prisma.candle.upsert({
            where: {
              instrumentId_timeframe_bucketStart: { instrumentId: inst.id, timeframe, bucketStart },
            },
            create: {
              instrumentId: inst.id,
              timeframe,
              bucketStart,
              open: c.open[i],
              high: c.high[i],
              low: c.low[i],
              close: c.close[i],
              volume: BigInt(Math.round(c.volume[i] ?? 0)),
              source: 'dhan',
            },
            update: {
              open: c.open[i],
              high: c.high[i],
              low: c.low[i],
              close: c.close[i],
              volume: BigInt(Math.round(c.volume[i] ?? 0)),
              source: 'dhan',
            },
          });
          written++;
        }
        totalWritten += written;
        const span =
          n > 0 ? `${new Date(c.timestamp[0] * 1000).toISOString().slice(0, 16)} … ${new Date(c.timestamp[n - 1] * 1000).toISOString().slice(0, 16)}` : '—';
        console.log(`  ✓ ${symbol.padEnd(10)} ${timeframe.padEnd(4)} ${String(written).padStart(4)} bars (${skipped} placeholder)  ${span}`);
      } catch (err) {
        console.error(`  ✗ ${symbol.padEnd(10)} ${timeframe.padEnd(4)} ${(err as Error).message}`);
      }
      await sleep(400); // stay well under Dhan's data-API rate ceiling
    }
  }

  console.log(`\nDone. ${totalWritten} candle rows written/updated (source=dhan).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
