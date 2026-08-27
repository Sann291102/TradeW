import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') }); // root .env — see .env.example
import * as http from 'node:http';
import WebSocket = require('ws');
import { readFileSync } from 'node:fs';
import {
  DhanCredential,
  DhanMarketFeed,
  DhanUpstreamError,
  MarketTick,
  UpstreamGuard,
  WebSocketLike,
  classifyDhanFault,
  isBrokerAddressable,
  parseScripMaster,
  readEnvFile,
  type ResolvedCredential,
  type ScripMasterRow,
} from '@tradew/market-data';
import {
  describeExpiryResolution,
  liveExpiries,
  resolveActiveExpiry,
  tradingDateIso,
  type ExpiryResolution,
} from '@tradew/types';
// The at-rest format for BrokerCredential.accessToken. Owned by the package that
// owns the schema, so this process and services/api cannot drift into
// incompatible envelopes. Static, not dynamic like the Prisma import below: it
// is a pure crypto module with no database dependency, so importing it costs
// nothing on a machine that runs this bridge without Postgres.
import { decryptCredential } from '@tradew/database';

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

/**
 * Browser origins allowed to read this server cross-origin.
 *
 * Sourced from FRONTEND_URL (comma-separated, same convention as services/api's
 * CORS config) so there is one place that lists the app's origins. Any
 * localhost/127.0.0.1 port is additionally accepted OUTSIDE production, because
 * the web dev server takes whatever port is free and a fixed list would break
 * on every restart.
 *
 * An origin that is not listed simply gets no CORS header — the request still
 * succeeds for non-browser callers, which is the correct behaviour for a
 * read-only public data server: CORS is a browser-side read restriction, not an
 * access control, and pretending otherwise would be security theatre. The real
 * boundary for this process is that it is bound to localhost and reachable
 * publicly only through the web origin's explicit `/feed` route allowlist
 * (apps/web/feed-proxy-routes.mjs).
 */
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedFeedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (process.env.NODE_ENV === 'production') return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * Where the Dhan access token comes from.
 *
 * Preferred source is the `BrokerCredential` row written by the API's
 * app-key consent flow (services/api/src/broker/dhan-auth.service.ts), so a
 * daily renewal is a click in the UI rather than an edit to
 * services/market-data/.env plus a restart of this process.
 *
 * `DHAN_ACCESS_TOKEN` remains the fallback, for two reasons: this bridge is
 * documented above as running without Postgres, and a machine that has never
 * run the consent flow must keep working exactly as before. The Prisma import
 * is therefore dynamic — no database, no crash, just the env value.
 *
 * Note this changes only WHERE the token is read, not how long it lasts. Dhan
 * caps every access token at 24 hours (SEBI rule on API access management), so
 * the app key removes the file edit, not the daily renewal.
 *
 * ── 2026-08-17: WHY THIS IS NO LONGER A MODULE-LEVEL `let` ────────────────
 *
 * It used to be `let DHAN_TOKEN`, assigned once by a `resolveDhanToken()` call
 * at the top of `main()`. Because Dhan's 24h cap is a regulatory ceiling, a
 * process that reads the token once and runs longer than a day is GUARANTEED to
 * end up holding a dead credential — and there was no path from "Dhan is
 * refusing me" back to "read the token again".
 *
 * That is exactly what happened: 18.4h uptime, a token renewed in `.env` 20
 * minutes earlier, api and sentinel both restarted and working, and this bridge
 * still presenting yesterday's token — answering every Sentinel observation
 * with an empty candle array that Sentinel reported to the user as "no real
 * market data available for NIFTY".
 *
 * `DhanCredential` makes the token re-resolvable: rejected once, re-read from
 * source on the next use. See its header for the concurrency conditions.
 */
const ENV_PATH = resolve(__dirname, '../../../.env');

const dhanCredential = new DhanCredential({
  resolve: resolveDhanCredential,
  log: (message) => console.log(message),
});

/**
 * Read the current best credential: the operator-designated DB row if there is
 * one, otherwise `DHAN_ACCESS_TOKEN`.
 *
 * Called on first use AND after every rejection, so it must genuinely re-read
 * both sources. Note `readEnvFile` rather than `process.env`: this process's
 * `process.env` is a snapshot taken at boot, and dotenv would not have
 * overwritten an already-set variable anyway — so the renewed token an operator
 * just wrote to `.env` is only visible by reading the file. That distinction is
 * the whole difference between recovering automatically and needing a restart.
 */
async function resolveDhanCredential(): Promise<ResolvedCredential | null> {
  try {
    const { PrismaClient } = (await import('@prisma/client')) as typeof import('@prisma/client');
    const prisma = new PrismaClient();
    try {
      // SECURITY: reads only the credential explicitly designated
      // `isFeedDefault`, never "the row for this provider".
      //
      // BrokerCredential used to be a single global row, so `provider: 'dhan'`
      // identified it unambiguously. Credentials are now per-user
      // ((provider, userId), see 20260729020000_broker_credential_ownership), so
      // that query would resolve to "whichever user's row came back first" —
      // meaning any user who linked their own broker account could end up
      // powering the shared public feed as a side effect. The designation is an
      // operator action (POST /broker/dhan/admin/feed-default/:userId, gated by
      // ADMIN_API_TOKEN) and is unique per provider by a partial index.
      //
      // No designation set is a normal, expected state: it falls through to
      // DHAN_ACCESS_TOKEN below, exactly as an empty table always did.
      const row = await prisma.brokerCredential.findFirst({
        where: { provider: 'dhan', isFeedDefault: true },
      });
      // An expired stored token is worse than the env one: it is guaranteed to
      // fail on first use, so skip it rather than prefer it for being newer.
      if (row?.accessToken && (!row.expiresAt || row.expiresAt.getTime() > Date.now())) {
        // THE DECRYPTION BOUNDARY for this process.
        //
        // The column is AES-256-GCM ciphertext as of 2026-08-20 — it used to be
        // plaintext, so a stolen database or backup was a working brokerage
        // credential for every linked user. `decryptCredential` is the ONLY
        // place in this file that turns it back into a token, and it happens
        // here rather than at startup so the plaintext lives for as short a span
        // as the design allows.
        //
        // The ciphertext is bound to (provider, userId) as associated data, so
        // this open fails if the row was assembled from someone else's
        // ciphertext — which is the point of passing `row.userId` rather than a
        // constant.
        const opened = decryptCredential(row.accessToken, {
          provider: 'dhan',
          userId: row.userId,
        });

        if (opened.kind === 'decrypted') {
          return {
            accessToken: opened.accessToken,
            source: 'db',
            expiresAt: row.expiresAt,
            detail: `db:${row.source ?? 'unknown'}`,
          };
        }

        if (opened.kind === 'legacy-plaintext') {
          // A row written before encryption shipped. Honoured, so deploying the
          // encrypting build never takes the feed down — and warned loudly,
          // because a half-migrated database that stays quiet is one nobody
          // finishes migrating.
          console.warn(
            '[dhan] SECURITY: the feed credential is stored UNENCRYPTED at rest. ' +
              'Run `npm run credential:migrate -w @tradew/database` to seal it.',
          );
          return {
            accessToken: opened.accessToken,
            source: 'db',
            expiresAt: row.expiresAt,
            detail: `db:${row.source ?? 'unknown'}:plaintext`,
          };
        }

        // Wrong key, rotated-out key, or a tampered row. Never hand a garbage
        // value to Dhan — fall through to DHAN_ACCESS_TOKEN, which is the same
        // path an expired token takes. `code` is a stable enum, never material.
        console.warn(
          `[dhan] stored credential could not be decrypted (${opened.code}) — falling back to DHAN_ACCESS_TOKEN`,
        );
      } else if (row) {
        console.warn('[dhan] stored token has expired — falling back to DHAN_ACCESS_TOKEN');
      }
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    console.warn(`[dhan] BrokerCredential unavailable (${err instanceof Error ? err.message : String(err)}) — using DHAN_ACCESS_TOKEN`);
  }
  // The FILE, not process.env — see the docstring above. `process.env` is kept
  // as a second fallback for deployments that set the variable directly and
  // ship no `.env` at all (containers, systemd).
  const fromFile = readEnvFile(ENV_PATH, readFileSync)['DHAN_ACCESS_TOKEN'];
  const accessToken = fromFile || process.env.DHAN_ACCESS_TOKEN || '';
  if (!accessToken) return null;
  return {
    accessToken,
    source: 'env',
    // Dhan states no expiry on a raw token, and inventing one would make a
    // working credential look dead. The 24h cap is enforced by Dhan refusing
    // it, which `invalidate()` now handles.
    expiresAt: null,
    detail: fromFile ? `env:${ENV_PATH}` : 'env:process',
  };
}

type InstrumentMeta = { symbol: string; displayName: string; securityId: string; exchangeSegment: 'IDX_I' | 'NSE_EQ' | 'MCX_COMM' };

// Security ids confirmed against Dhan's own published scrip master
// (api-scrip-master-detailed.csv), NSE/BSE index segment. Indices are a
// small, stable set (no roll-forward, no renames) so this stays hardcoded —
// everything else below is resolved live from the scrip master at boot.
const INDEX_INSTRUMENTS: InstrumentMeta[] = [
  { symbol: 'NIFTY', displayName: 'Nifty 50', securityId: '13', exchangeSegment: 'IDX_I' },
  { symbol: 'BANKNIFTY', displayName: 'Nifty Bank', securityId: '25', exchangeSegment: 'IDX_I' },
  { symbol: 'FINNIFTY', displayName: 'Fin Nifty', securityId: '27', exchangeSegment: 'IDX_I' },
  { symbol: 'SENSEX', displayName: 'BSE Sensex', securityId: '51', exchangeSegment: 'IDX_I' },
  { symbol: 'INDIAVIX', displayName: 'India VIX', securityId: '21', exchangeSegment: 'IDX_I' },
];

/**
 * The NSE F&O-eligible stock universe — same list (and source: NSE's
 * `NSE_FO_SosScheme.csv` strike-scheme export) as
 * `apps/web/src/lib/mock/foUniverse.ts`. Duplicated rather than imported:
 * this service is deliberately isolated from apps/* (see the module
 * docstring on `FO_STOCK_UNIVERSE` — "Never reached by apps/*" holds in the
 * other direction too, this workspace has no path into apps/web). Symbols
 * only — display names and security ids are resolved live below, so a stock
 * renamed on the exchange (as Tata Motors and Zomato both were, see the
 * aliases below) only needs updating in one direction, not kept in sync.
 */
const FO_STOCK_SYMBOLS = [
  '360ONE', 'ABB', 'ABCAPITAL', 'ADANIENSOL', 'ADANIENT', 'ADANIGREEN', 'ADANIPORTS', 'ADANIPOWER', 'ALKEM', 'AMBER',
  'AMBUJACEM', 'ANGELONE', 'APLAPOLLO', 'APOLLOHOSP', 'ASHOKLEY', 'ASIANPAINT', 'ASTRAL', 'AUBANK', 'AUROPHARMA', 'AXISBANK',
  'BAJAJ-AUTO', 'BAJAJFINSV', 'BAJAJHLDNG', 'BAJFINANCE', 'BANDHANBNK', 'BANKBARODA', 'BANKINDIA', 'BDL', 'BEL', 'BHARATFORG',
  'BHARTIARTL', 'BHEL', 'BIOCON', 'BLUESTARCO', 'BOSCHLTD', 'BPCL', 'BRITANNIA', 'BSE', 'CAMS', 'CANBK',
  'CDSL', 'CGPOWER', 'CHOLAFIN', 'CIPLA', 'COALINDIA', 'COCHINSHIP', 'COFORGE', 'COLPAL', 'CONCOR', 'CROMPTON',
  'CUMMINSIND', 'DABUR', 'DALBHARAT', 'DELHIVERY', 'DIVISLAB', 'DIXON', 'DLF', 'DMART', 'DRREDDY', 'EICHERMOT',
  'ETERNAL', 'EXIDEIND', 'FEDERALBNK', 'FORCEMOT', 'FORTIS', 'GAIL', 'GLENMARK', 'GMRAIRPORT', 'GODFRYPHLP', 'GODREJCP',
  'GODREJPROP', 'GRASIM', 'GVT&D', 'HAL', 'HAVELLS', 'HCLTECH', 'HDFCAMC', 'HDFCBANK', 'HDFCLIFE', 'HEROMOTOCO',
  'HINDALCO', 'HINDPETRO', 'HINDUNILVR', 'HINDZINC', 'HYUNDAI', 'ICICIBANK', 'ICICIGI', 'ICICIPRULI', 'IDEA', 'IDFCFIRSTB',
  'IEX', 'INDHOTEL', 'INDIANB', 'INDIGO', 'INDUSINDBK', 'INDUSTOWER', 'INFY', 'INOXWIND', 'IOC', 'IREDA',
  'IRFC', 'ITC', 'JINDALSTEL', 'JIOFIN', 'JSWENERGY', 'JSWSTEEL', 'JUBLFOOD', 'KALYANKJIL', 'KAYNES', 'KEI',
  'KFINTECH', 'KOTAKBANK', 'KPITTECH', 'LAURUSLABS', 'LICHSGFIN', 'LICI', 'LODHA', 'LT', 'LTF', 'LTM',
  'LUPIN', 'M&M', 'MANAPPURAM', 'MANKIND', 'MARICO', 'MARUTI', 'MAXHEALTH', 'MAZDOCK', 'MCX', 'MFSL',
  'MOTHERSON', 'MOTILALOFS', 'MPHASIS', 'MUTHOOTFIN', 'NAM-INDIA', 'NATIONALUM', 'NAUKRI', 'NBCC', 'NESTLEIND', 'NHPC',
  'NMDC', 'NTPC', 'NUVAMA', 'NYKAA', 'OBEROIRLTY', 'OFSS', 'OIL', 'ONGC', 'PAGEIND', 'PATANJALI',
  'PAYTM', 'PERSISTENT', 'PETRONET', 'PFC', 'PGEL', 'PHOENIXLTD', 'PIDILITIND', 'PIIND', 'PNB', 'PNBHOUSING',
  'POLICYBZR', 'POLYCAB', 'POWERGRID', 'POWERINDIA', 'PREMIERENE', 'PRESTIGE', 'RADICO', 'RBLBANK', 'RECLTD', 'RELIANCE',
  'RVNL', 'SAIL', 'SBICARD', 'SBILIFE', 'SBIN', 'SHREECEM', 'SHRIRAMFIN', 'SIEMENS', 'SOLARINDS', 'SONACOMS',
  'SRF', 'SUNPHARMA', 'SUPREMEIND', 'SUZLON', 'SWIGGY', 'TATACONSUM', 'TATAELXSI', 'TATAPOWER', 'TATASTEEL', 'TCS',
  'TECHM', 'TIINDIA', 'TITAN', 'TMPV', 'TORNTPHARM', 'TRENT', 'TVSMOTOR', 'ULTRACEMCO', 'UNIONBANK', 'UNITDSPR',
  'UNOMINDA', 'UPL', 'VBL', 'VEDL', 'VMM', 'VOLTAS', 'WAAREEENER', 'WIPRO', 'YESBANK', 'ZYDUSLIFE',
];

/**
 * Legacy dashboard symbol -> real current Dhan trading symbol. Two of the
 * F&O universe's real names are corporate-action renames the older dashboard
 * mock data (lib/mock/market.ts WATCHLIST/TOP_GAINERS/SECTOR_STOCKS) still
 * addresses under the pre-rename symbol: Tata Motors demerged into Tata
 * Motors Passenger Vehicles (TMPV, already in FO_STOCK_SYMBOLS) and Tata
 * Motors Limited — commercial vehicles (TMCV, not F&O-eligible under that
 * name so not in the list above); Zomato renamed to Eternal (ETERNAL,
 * already in FO_STOCK_SYMBOLS). Resolving both keeps the dashboard's older
 * symbol keys live without renaming them everywhere they're used.
 */
const LEGACY_STOCK_ALIASES: Array<{ symbol: string; displayName: string; dhanTradingSymbol: string }> = [
  { symbol: 'TATAMOTORS', displayName: 'Tata Motors', dhanTradingSymbol: 'TMCV' },
  { symbol: 'ZOMATO', displayName: 'Eternal (Zomato)', dhanTradingSymbol: 'ETERNAL' },
];

/** MCX front-month contracts to track, one per underlying. Resolved to a
 *  concrete security id at boot (see `resolveCommodityInstruments`) — no
 *  more hand-maintained, silently-expiring security ids. */
const COMMODITY_UNDERLYINGS: Array<{ symbol: string; displayName: string }> = [
  { symbol: 'GOLD', displayName: 'Gold' },
  { symbol: 'SILVER', displayName: 'Silver' },
  { symbol: 'CRUDEOIL', displayName: 'Crude Oil' },
  { symbol: 'NATURALGAS', displayName: 'Natural Gas' },
  { symbol: 'COPPER', displayName: 'Copper' },
];

// ---------------------------------------------------------------------------
// Scrip master — resolves real Dhan security ids for stocks/ETFs/commodities
// at boot, replacing hand-typed ids that silently go stale (renames,
// monthly futures rollovers). Pure download + parse, no DB (see
// packages/market-data/src/providers/dhan/dhan-scrip-master.ts) — the same
// parser services/market-data's `scrip:sync` CLI uses against Postgres, used
// here read-only and in-memory instead.
// ---------------------------------------------------------------------------

const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const CASH_SERIES = ['EQ', 'BE'];

interface ResolvedUniverse {
  stocks: InstrumentMeta[];
  etfs: InstrumentMeta[];
  commodities: InstrumentMeta[];
  /** Every NSE index / equity row from the master, keyed by trading symbol —
   *  the full market, not the curated live-feed subset below. Used to
   *  resolve option-chain underlyings for ANY symbol dynamically (see
   *  `resolveOptionUnderlying` in main()), not just the ones this bridge
   *  happens to stream live ticks for. */
  indexBySymbol: Map<string, ScripMasterRow>;
  equityBySymbol: Map<string, ScripMasterRow>;
  /** ETF and resolved front-month commodity rows, keyed the same way — full
   *  scrip-master rows (lot size, tick size, ISIN included), for the
   *  `/instrument` metadata endpoint. */
  etfBySymbol: Map<string, ScripMasterRow>;
  commodityRowBySymbol: Map<string, ScripMasterRow>;
  /** Underlying symbol -> the exchange-defined lot size for its DERIVATIVE
   *  contracts (NIFTY 65, SENSEX 20, ADANIPOWER 3550, ...). Distinct from a
   *  cash-equity row's own `lotSize`, which is always 1 — an option on
   *  RELIANCE trades in multiples of 500 even though RELIANCE shares trade
   *  in 1s. Derived from the OPTIDX/OPTSTK/FUTIDX/FUTSTK rows (~125k of
   *  them) but only the ~239 distinct underlyings are retained. */
  derivativeLotSizeByUnderlying: Map<string, number>;
}

async function loadScripMaster(): Promise<ScripMasterRow[]> {
  console.log('[scrip-master] downloading Dhan instrument master…');
  const res = await fetch(SCRIP_MASTER_URL);
  if (!res.ok) throw new Error(`scrip master download failed: HTTP ${res.status}`);
  const csv = await res.text();
  // NSE_FNO/BSE_FNO are parsed purely to harvest per-underlying derivative
  // lot sizes (see derivativeLotSizeByUnderlying) — no contract rows are
  // retained past `resolveUniverse`, and nothing here is subscribed to the
  // live feed. Order quantity validation is wrong without them.
  const { rows, skipped, outOfScope } = parseScripMaster(csv, {
    segments: ['IDX_I', 'NSE_EQ', 'MCX_COMM', 'NSE_FNO', 'BSE_FNO'],
    series: CASH_SERIES,
  });
  console.log(`[scrip-master] parsed ${rows.length} row(s) in scope (${outOfScope} out of scope, ${skipped.length} skipped)`);
  return rows;
}

const DERIVATIVE_INSTRUMENTS = new Set(['OPTIDX', 'OPTSTK', 'FUTIDX', 'FUTSTK']);

/**
 * Extracts the underlying from a derivative trading symbol by cutting at the
 * expiry token: "BANKNIFTY-Sep2026-72600-CE" -> BANKNIFTY,
 * "BAJAJ-AUTO-Sep2026-14800-CE" -> BAJAJ-AUTO, "GOLD-05Aug2026-FUT" -> GOLD.
 *
 * Splitting on the first "-" is WRONG and was a real bug here: underlyings
 * that contain a hyphen (BAJAJ-AUTO, NAM-INDIA, M&M-…) silently truncated to
 * "BAJAJ"/"NAM", so their option lot size resolved to null and an order
 * ticket would have validated quantity against the wrong (or no) lot.
 */
function underlyingFromContractSymbol(tradingSymbol: string): string | null {
  const match = /^(.+?)-\d{0,2}[A-Za-z]{3}\d{4}-/.exec(tradingSymbol);
  return match ? match[1].toUpperCase() : null;
}

function resolveUniverse(rows: ScripMasterRow[]): ResolvedUniverse {
  const indexBySymbol = new Map<string, ScripMasterRow>();
  const equityBySymbol = new Map<string, ScripMasterRow>();
  const etfRows: ScripMasterRow[] = [];
  const commodityFutRows: ScripMasterRow[] = [];
  const derivativeLotSizeByUnderlying = new Map<string, number>();

  for (const row of rows) {
    if (row.instrument && DERIVATIVE_INSTRUMENTS.has(row.instrument)) {
      // Every contract on one underlying shares its lot size, so first wins.
      const underlying = underlyingFromContractSymbol(row.tradingSymbol);
      if (underlying && row.lotSize && !derivativeLotSizeByUnderlying.has(underlying)) {
        derivativeLotSizeByUnderlying.set(underlying, row.lotSize);
      }
      continue;
    }
    if (row.exchangeSegment === 'IDX_I') {
      indexBySymbol.set(row.tradingSymbol.toUpperCase(), row);
    } else if (row.exchangeSegment === 'NSE_EQ' && row.instrumentType === 'ES') {
      equityBySymbol.set(row.tradingSymbol.toUpperCase(), row);
    } else if (row.exchangeSegment === 'NSE_EQ' && row.instrumentType === 'ETF') {
      etfRows.push(row);
    } else if (row.exchangeSegment === 'MCX_COMM' && row.instrument === 'FUTCOM') {
      commodityFutRows.push(row);
    }
  }

  const stocks: InstrumentMeta[] = [];
  const notFound: string[] = [];
  for (const symbol of FO_STOCK_SYMBOLS) {
    const row = equityBySymbol.get(symbol.toUpperCase());
    if (!row) {
      notFound.push(symbol);
      continue;
    }
    stocks.push({ symbol, displayName: row.displayName || row.symbolName, securityId: row.securityId, exchangeSegment: 'NSE_EQ' });
  }
  for (const alias of LEGACY_STOCK_ALIASES) {
    const row = equityBySymbol.get(alias.dhanTradingSymbol.toUpperCase());
    if (!row) {
      notFound.push(`${alias.symbol} (as ${alias.dhanTradingSymbol})`);
      continue;
    }
    stocks.push({ symbol: alias.symbol, displayName: alias.displayName, securityId: row.securityId, exchangeSegment: 'NSE_EQ' });
  }
  if (notFound.length > 0) {
    console.warn(`[scrip-master] ${notFound.length} stock symbol(s) not found in the master (skipped): ${notFound.join(', ')}`);
  }

  const etfBySymbol = new Map<string, ScripMasterRow>();
  for (const row of etfRows) etfBySymbol.set(row.tradingSymbol.toUpperCase(), row);
  const etfs: InstrumentMeta[] = etfRows
    .map((row) => ({
      symbol: row.tradingSymbol.toUpperCase(),
      displayName: row.displayName || row.symbolName,
      securityId: row.securityId,
      exchangeSegment: 'NSE_EQ' as const,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const now = Date.now();
  const commodities: InstrumentMeta[] = [];
  const commodityRowBySymbol = new Map<string, ScripMasterRow>();
  for (const underlying of COMMODITY_UNDERLYINGS) {
    const candidates = commodityFutRows
      .filter((row) => row.symbolName === underlying.symbol && row.expiryDate && row.expiryDate.getTime() >= now)
      .sort((a, b) => a.expiryDate!.getTime() - b.expiryDate!.getTime());
    const front = candidates[0];
    if (!front) {
      console.warn(`[scrip-master] no unexpired FUTCOM contract found for ${underlying.symbol}`);
      continue;
    }
    const monthLabel = front.expiryDate!.toLocaleString('en-US', { month: 'short' });
    commodities.push({
      symbol: underlying.symbol,
      displayName: `${underlying.displayName} (${monthLabel} fut)`,
      securityId: front.securityId,
      exchangeSegment: 'MCX_COMM',
    });
    commodityRowBySymbol.set(underlying.symbol, front);
  }

  console.log(`[scrip-master] resolved ${stocks.length}/${FO_STOCK_SYMBOLS.length + LEGACY_STOCK_ALIASES.length} stocks, ${etfs.length} ETFs, ${commodities.length}/${COMMODITY_UNDERLYINGS.length} commodities, ${indexBySymbol.size} indices and ${equityBySymbol.size} equities available for option-chain lookup, ${derivativeLotSizeByUnderlying.size} derivative lot sizes`);
  return { stocks, etfs, commodities, indexBySymbol, equityBySymbol, etfBySymbol, commodityRowBySymbol, derivativeLotSizeByUnderlying };
}

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

/**
 * Live LTP for individual OPTION contracts, keyed by Dhan securityId.
 *
 * Dhan's option-chain REST endpoint is rate-limited to roughly one call every
 * 3s, so a chain built purely from it always lags the market — which is what
 * made per-strike prices visibly "stop" between refreshes. The websocket feed
 * has no such limit, so the strikes a user is actually looking at get
 * subscribed on demand (see `ensureOptionSubscription`) and their prices are
 * overlaid onto the chain response. OI / IV / Greeks still come from the REST
 * chain at its own cadence; only the price ticks in real time.
 *
 * Not subscribed at boot: there are ~125k listed contracts and a connection
 * holds 5,000 subscriptions, so slots are spent only where someone is looking.
 */
const optionLtpBySecurityId = new Map<string, number>();

/** NSE cash session: 09:15-15:30 IST, Mon-Fri. No holiday calendar available
 *  (DHAN-MARKET-DATA-INTEGRATION.md §12 open question 5) — a trading holiday
 *  will show OPEN here when the exchange is actually closed. MCX runs a
 *  separate, longer session (until ~23:30 IST); this flag is reported only
 *  for the NSE-listed indices/stocks/ETFs, not the commodities. */
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
  const etfs: LiveQuote[] = [];
  const commodities: LiveQuote[] = [];
  for (const [key, q] of byKey) {
    if (key.startsWith('index:')) indices.push(q);
    else if (key.startsWith('stock:')) stocks.push(q);
    else if (key.startsWith('etf:')) etfs.push(q);
    else commodities.push(q);
  }
  return { marketOpen: isMarketOpen(), indices, stocks, etfs, commodities };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// Ticks arrive far faster than any UI needs — the whole F&O universe fires
// many times a second. Serializing and pushing the entire snapshot on every
// tick is a firehose that janks the browser and stresses the SSE connection
// (which then flickers the market-status pill). Instead, mark the snapshot
// dirty on each tick and flush at a steady, bounded cadence: smooth,
// continuous updates without the per-tick storm.
const BROADCAST_MS = 300;
let dirty = false;
function scheduleBroadcast() {
  dirty = true;
}

let feedStatus = 'idle';
let feedReason: string | undefined;

async function startFeed(
  allInstruments: InstrumentMeta[],
  kindOf: (meta: InstrumentMeta) => 'index' | 'stock' | 'etf' | 'commodity',
) {
  const accessToken = await dhanCredential.get();
  const clientId = process.env.DHAN_CLIENT_ID;
  if (!accessToken || !clientId) {
    console.error(
      'No Dhan access token — connect the broker in Settings (app-key consent flow), or set DHAN_ACCESS_TOKEN / DHAN_CLIENT_ID in services/market-data/.env',
    );
    process.exit(1);
  }
  console.log(`[dhan] starting feed with token source: ${dhanCredential.state().source}`);

  const feed = new DhanMarketFeed({
    accessToken,
    clientId,
    url: process.env.DHAN_FEED_URL,
    webSocketFactory: (url: string): WebSocketLike => new (WebSocket as any)(url) as unknown as WebSocketLike,
  });

  feed.onStatus((event) => {
    feedStatus = event.status;
    feedReason = event.reason;
    console.log(`[dhan] ${event.status}${event.reason ? ' — ' + event.reason : ''}`);
  });

  // Keyed lookup instead of a linear scan. This runs on EVERY tick across the
  // whole subscribed universe (553 instruments at boot, plus option contracts
  // subscribed on demand), so an O(n) find here burned real CPU per tick.
  const metaByRef = new Map(allInstruments.map((m) => [`${m.exchangeSegment}:${m.securityId}`, m]));

  feed.onTick((tick) => {
    // Option contracts are subscribed on demand and are deliberately not part
    // of `allInstruments` — their price is overlaid onto the option-chain
    // response (see optionLtpBySecurityId) rather than broadcast as a quote.
    // Any derivatives segment — NSE_FNO (NIFTY/BANKNIFTY/stocks) and BSE_FNO
    // (SENSEX/BANKEX) alike. Matching only NSE_FNO silently dropped every
    // SENSEX option tick.
    // `InstrumentRef` declares securityId/exchangeSegment optional (a
    // symbol-only ref is legal — see contracts/instrument-ref.ts), so both must
    // be narrowed before use. `isBrokerAddressable` is the contract's own type
    // guard for exactly this; without it this file does not compile, which is
    // why the bridge could not start.
    if (!isBrokerAddressable(tick.ref)) return;

    if (tick.ref.exchangeSegment.endsWith('_FNO')) {
      if (tick.ltp != null) optionLtpBySecurityId.set(tick.ref.securityId, tick.ltp);
      return;
    }
    const meta = metaByRef.get(`${tick.ref.exchangeSegment}:${tick.ref.securityId}`);
    if (!meta) return;
    byKey.set(`${kindOf(meta)}:${meta.symbol}`, toLiveQuote(tick, meta));
    scheduleBroadcast();
  });

  feed
    .start()
    .then(() => feed.subscribe(allInstruments, 'quote'))
    .catch((err) => console.error('feed failed to start:', err));

  return feed;
}

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

// The candle cache is now `candleGuard` (see below): same TTL, but it also
// coalesces concurrent identical reads and damps faults, which this plain Map
// could not — it was written only on the success path, so the one case that most
// needed damping had none. Kept as a named constant because the guard reads it.

// App CandleInterval -> Dhan intraday interval (minutes). '1d' uses the
// separate /charts/historical (daily) endpoint instead of /charts/intraday.
const INTRADAY_INTERVAL: Record<string, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60' };

function instrumentTypeFor(meta: InstrumentMeta & { instrument?: string }): string {
  // An option contract carries its exact class (OPTIDX/OPTSTK) from the scrip
  // master; it cannot be inferred from the segment, so honour it when present.
  if (meta.instrument) return meta.instrument;
  if (meta.exchangeSegment === 'IDX_I') return 'INDEX';
  if (meta.exchangeSegment === 'NSE_EQ') return 'EQUITY';
  return 'FUTCOM';
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** IST calendar date (YYYY-MM-DD) for `d`, in NSE's own timezone rather than
 *  the server's/UTC's — matching every other date boundary in this file
 *  (see SESSION_WINDOWS, isWithinSession). */
function istYmd(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

/** IST midnight (00:00 IST, i.e. 18:30 UTC the previous day) of the date
 *  `daysAgo` days before `d`'s IST calendar date. */
function istMidnightDaysAgo(d: Date, daysAgo: number): Date {
  const base = new Date(`${istYmd(d)}T00:00:00+05:30`);
  return new Date(base.getTime() - daysAgo * 86_400_000);
}

/** Exchange session windows in IST minutes-from-midnight. NSE cash/index:
 *  09:15-15:30. MCX commodities run their own much longer evening session. */
const SESSION_WINDOWS: Record<string, { openMin: number; closeMin: number }> = {
  IDX_I: { openMin: 9 * 60 + 15, closeMin: 15 * 60 + 30 },
  NSE_EQ: { openMin: 9 * 60 + 15, closeMin: 15 * 60 + 30 },
  // Equity derivatives keep cash-market hours; without these entries option
  // candles would fall through the "unknown segment" branch unfiltered.
  NSE_FNO: { openMin: 9 * 60 + 15, closeMin: 15 * 60 + 30 },
  BSE_FNO: { openMin: 9 * 60 + 15, closeMin: 15 * 60 + 30 },
  MCX_COMM: { openMin: 9 * 60, closeMin: 23 * 60 + 30 },
};

/**
 * True when an intraday candle falls inside its exchange's real trading
 * session (weekday, within session hours, IST).
 *
 * Dhan's intraday chart API appends a synthetic "current price" bar after
 * the close — flat OHLC, zero volume, timestamped hours past 15:30 (e.g.
 * 19:30 IST). Charting that stretched the time axis far beyond the session
 * and made every tick label look wrong. Real candles are unaffected; only
 * the out-of-session stub is dropped.
 */
function isWithinSession(timestampMs: number, exchangeSegment: string): boolean {
  const window = SESSION_WINDOWS[exchangeSegment];
  if (!window) return true; // unknown segment — don't silently discard its data
  const ist = new Date(new Date(timestampMs).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false; // no weekend sessions
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= window.openMin && minutes <= window.closeMin;
}

/** Columnar Dhan response -> array-of-candle objects (Candle-shaped, ms ts).
 *  `sessionSegment` is set for intraday requests only — daily candles carry
 *  a date-only timestamp, so filtering those on time-of-day would drop
 *  every one of them. */
function toCandles(data: DhanChartResponse, sessionSegment?: string): CandleJson[] {
  const { timestamp, open, high, low, close, volume } = data;
  if (!Array.isArray(timestamp) || !open || !high || !low || !close) return [];
  const candles = timestamp.map((t, i) => ({
    timestamp: t * 1000,
    open: open[i],
    high: high[i],
    low: low[i],
    close: close[i],
    volume: volume?.[i] ?? 0,
  }));
  return sessionSegment ? candles.filter((c) => isWithinSession(c.timestamp, sessionSegment)) : candles;
}

/**
 * One authenticated Dhan REST call, with the credential lifecycle and the fault
 * taxonomy applied in the one place every caller goes through.
 *
 * Doing this per-call-site is how the old code ended up with three different
 * opinions about what a 4xx meant. Here there is one:
 *
 *   · no credential            → 'auth' fault, and NO upstream call. A request
 *                                with no token is a guaranteed 401 that spends
 *                                rate-limit budget to learn what we know.
 *   · Dhan refuses the token   → the credential is invalidated, so the very next
 *                                call re-reads it from source. This is the
 *                                automatic recovery that used to need a restart.
 *   · anything else non-2xx    → classified, thrown as a typed fault, never
 *                                flattened into an empty success.
 */
async function dhanPost(endpoint: string, body: unknown): Promise<unknown> {
  const accessToken = await dhanCredential.get();
  if (!accessToken) {
    throw new DhanUpstreamError('auth', 0, dhanCredential.state().lastFault ?? 'no Dhan credential available', endpoint);
  }

  let resp: Response;
  try {
    resp = await fetch(`${DHAN_API}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access-token': accessToken,
        'client-id': process.env.DHAN_CLIENT_ID ?? '',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new DhanUpstreamError('upstream', 0, err instanceof Error ? err.message : String(err), endpoint);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    const kind = classifyDhanFault(resp.status, detail);
    if (kind === 'no-market') {
      // Dhan's definitive "this security has no derivatives market under this
      // segment". Information about the instrument, so it is returned as an
      // answer rather than thrown — and the CALLER decides what an empty answer
      // means for its endpoint.
      return null;
    }
    if (kind === 'auth') {
      // The load-bearing line. Marking the credential bad is what makes the
      // next request re-read the renewed token instead of presenting the dead
      // one forever.
      dhanCredential.invalidate(`${resp.status} ${detail.slice(0, 160)}`);
    }
    console.warn(`[dhan] ${endpoint} ${resp.status} (${kind}): ${detail.slice(0, 200)}`);
    throw new DhanUpstreamError(kind, resp.status, detail.slice(0, 300), endpoint);
  }

  return resp.json();
}

/**
 * The breaker the guards consult: while the credential is known-dead, no key is
 * worth attempting, because the fault is per-process rather than per-symbol.
 * Damping it per-key would still admit one call per symbol per window.
 */
function credentialBreaker(): DhanUpstreamError | null {
  if (dhanCredential.healthy) return null;
  const state = dhanCredential.state();
  // Only hold the breaker open while a re-resolution is deliberately being
  // withheld. Outside that floor, let the call through: that attempt is what
  // re-reads the credential and recovers.
  if (state.retryingInMs === null) return null;
  return new DhanUpstreamError('auth', 0, state.lastFault ?? 'Dhan credential unavailable', 'credential');
}

async function fetchDhanCandles(meta: InstrumentMeta, interval: string, from: Date, to: Date): Promise<CandleJson[]> {
  const isDaily = interval === '1d';
  const body: Record<string, string> = {
    securityId: meta.securityId,
    exchangeSegment: meta.exchangeSegment,
    instrument: instrumentTypeFor(meta),
    fromDate: istYmd(from),
    toDate: istYmd(to),
  };
  if (!isDaily) body.interval = INTRADAY_INTERVAL[interval] ?? '5';

  // Rate limit, expired token, missing Data-API entitlement — every one of
  // these is a real fault the caller must be told about, verbatim, and NOT as an
  // empty candle array. This used to fall through to a seeded random walk that
  // the route then labelled `source: 'dhan'`, so an option chart silently drew
  // index-level prices for a contract worth a couple of hundred rupees and
  // nothing on screen said so. See the no-fabricated-data rule (2026-07-26).
  // `dhanPost` now classifies and throws; see its header.
  const data = (await dhanPost(isDaily ? '/charts/historical' : '/charts/intraday', body)) as DhanChartResponse | null;

  // Dhan answered. An empty series here is a genuine "no bars for this
  // contract" (illiquid strike, listed today, outside the retained window),
  // not a fault — returned as-is so the UI says "no traded history" rather
  // than "API down".
  if (!data) return [];
  return toCandles(data, isDaily ? undefined : meta.exchangeSegment);
}

// ---------------------------------------------------------------------------
// Option chain — Dhan's Option Chain REST API (real strikes/OI/volume/IV/
// Greeks per underlying+expiry), proxied the same way as the historical
// candles above. Separate concerns from the live WS feed: this is spot
// price + derivatives data, POST-only, and rate-limited hard by Dhan (docs:
// no more than one call every ~3s) — so every call here is serialized
// through one queue with a floor gap, on top of a short response cache, so
// no burst of browser tabs/polls can ever exceed that regardless of traffic.
// ---------------------------------------------------------------------------

interface OptionUnderlying {
  securityId: string;
  /** IDX_I for indices (their own segment); NSE_FNO for stocks — Dhan's
   *  option chain always addresses the underlying by its equity security id
   *  but the *derivatives* segment, not NSE_EQ. */
  underlyingSeg: 'IDX_I' | 'NSE_FNO';
}

/** Full tradeable metadata for the /instrument route — everything an order
 *  management system needs before accepting an order (see resolveInstrumentMetadata). */
interface InstrumentMetadataOut {
  symbol: string;
  displayName: string;
  tradingSymbol: string;
  exchange: string;
  exchangeSegment: string;
  securityId: string;
  instrumentType: 'INDEX' | 'EQUITY' | 'ETF' | 'COMMODITY_FUT';
  isin: string | null;
  /** Lot size for trading THIS instrument as-is (cash equity/ETF = 1). */
  lotSize: number;
  /** Lot size for this underlying's option/future contracts — NIFTY 65,
   *  SENSEX 20, RELIANCE 500 — or null when it has no derivatives market.
   *  Always differs from `lotSize` above for cash instruments, and is the
   *  one an option order ticket must use. */
  derivativeLotSize: number | null;
  tickSize: number;
  /** ISO date — commodity futures only (their contract's expiry). */
  expiryDate: string | null;
}

interface DhanOptionLegRaw {
  last_price?: number;
  previous_close_price?: number;
  oi?: number;
  previous_oi?: number;
  volume?: number;
  previous_volume?: number;
  implied_volatility?: number;
  top_bid_price?: number;
  top_ask_price?: number;
  greeks?: { delta?: number; theta?: number; gamma?: number; vega?: number };
}
interface DhanOptionChainRaw {
  status: string;
  data?: { last_price?: number; oc?: Record<string, { ce?: DhanOptionLegRaw; pe?: DhanOptionLegRaw }> };
}

interface OptionLegOut {
  ltp: number;
  previousClose: number;
  oi: number;
  previousOi: number;
  volume: number;
  previousVolume: number;
  iv: number;
  bid: number;
  ask: number;
  delta: number | null;
  theta: number | null;
  gamma: number | null;
  vega: number | null;
}
interface OptionStrikeOut {
  strike: number;
  ce: OptionLegOut | null;
  pe: OptionLegOut | null;
}

let optionChainQueue: Promise<unknown> = Promise.resolve();
let lastOptionChainCallAt = 0;
/**
 * Floor gap between consecutive Dhan option-chain-family calls. Dhan documents
 * no more than one call every ~3s; this sat at 2,500 ms, i.e. ~24 calls/min
 * against a ~20/min ceiling. A page left open kept that up indefinitely, so
 * Dhan eventually started declining — invisible on the chain itself (it serves
 * `lastGoodChain`) but not on the charts, which had no such protection. 3,100 ms
 * keeps a margin over the documented minimum rather than riding exactly on it.
 */
const OPTION_CHAIN_MIN_GAP_MS = 3_100;

/** How many strikes either side of spot get a live websocket subscription per
 *  underlying+expiry (each costs two slots, CE + PE). The chain table shows 9
 *  and the chart reads one, so 15 covers the visible window plus room to scroll
 *  without spending slots on deep-OTM strikes nobody is watching. */
const OPTION_STREAM_STRIKES = 15;

/**
 * Depth cap on the shared option-chain FIFO.
 *
 * ── WHY A CAP IS NOT OPTIONAL ─────────────────────────────────────────────
 *
 * The queue is process-wide and enforces a 3.1s floor gap, so wait time grows
 * linearly with queue depth while every CALLER has a fixed deadline —
 * `SENTINEL_LIVE_FEED_TIMEOUT_MS`, 4,000 ms. Measured on 2026-08-17 with six
 * concurrent expirylist requests for distinct symbols:
 *
 *   ITC 34ms · WIPRO 3,148ms · AXISBANK 6,260ms · LT 9,358ms
 *   BEL 12,463ms · DLF 15,566ms
 *
 * Four of six blew past the 4s abort. And because an aborted HTTP client does
 * NOT cancel work already queued here, those four upstream calls still ran, at
 * 3.1s each, spending the rate-limited budget on answers nobody would read —
 * while the next poll enqueued four more behind them. That is how a queue
 * intended to protect the rate limit became the thing that guaranteed every
 * concurrent user a timeout.
 *
 * Worse, downstream, a 4s abort was read as "this symbol has no option chain"
 * (see `fetchExpiryList`). So the second and subsequent concurrent users were
 * told NIFTY has no options — the exact screenshot symptom — purely because
 * someone else asked first.
 *
 * Two changes fix the mechanism rather than the timing:
 *
 *  · REJECT INSTEAD OF ENQUEUE when the projected wait already exceeds what a
 *    caller can wait for. A fast, honest "rate-limited, try again" beats a slow
 *    answer nobody is still listening for, and it keeps the queue short enough
 *    that the callers who DO get in are served inside their deadline.
 *
 *  · The `UpstreamGuard` in front collapses concurrent callers for the SAME key
 *    onto one queue slot, so depth now tracks distinct symbols rather than
 *    request count.
 */
const OPTION_QUEUE_MAX_WAIT_MS = Number(process.env.DHAN_OPTION_QUEUE_MAX_WAIT_MS ?? 3_500);

/** How many calls are waiting on the shared FIFO right now. */
let optionQueueDepth = 0;

/** Serializes every Dhan option-chain-family call (expirylist + chain)
 *  through one FIFO queue with a floor gap between calls, regardless of how
 *  many browser tabs or symbols are asking concurrently. */
function queueDhanCall<T>(fn: () => Promise<T>): Promise<T> {
  // Projected wait for a slot appended right now: everything already queued
  // must clear its own floor gap first.
  const projectedWaitMs =
    Math.max(0, lastOptionChainCallAt + OPTION_CHAIN_MIN_GAP_MS - Date.now()) +
    optionQueueDepth * OPTION_CHAIN_MIN_GAP_MS;
  if (projectedWaitMs > OPTION_QUEUE_MAX_WAIT_MS) {
    return Promise.reject(
      new DhanUpstreamError(
        'rate-limit',
        429,
        `option-chain queue is ${optionQueueDepth} deep; a slot is ~${Math.round(projectedWaitMs)}ms away, ` +
          `beyond the ${OPTION_QUEUE_MAX_WAIT_MS}ms a caller can wait. Shed rather than queued.`,
        'optionchain-queue',
      ),
    );
  }

  optionQueueDepth++;
  const run = optionChainQueue.then(async () => {
    const wait = Math.max(0, lastOptionChainCallAt + OPTION_CHAIN_MIN_GAP_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastOptionChainCallAt = Date.now();
    try {
      return await fn();
    } finally {
      optionQueueDepth--;
    }
  });
  // Keep the chain alive even when a call fails — swallow here, the caller
  // below still sees the real rejection via `run`.
  optionChainQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Traded expiries for one underlying, or `[]` when it genuinely has no
 * derivatives market.
 *
 * ── THE BUG THIS FIXES ────────────────────────────────────────────────────
 *
 * This used to be `if (resp.status >= 400 && resp.status < 500) return []`. The
 * comment justified it correctly for ONE case — Dhan answers 4xx ("813 Invalid
 * SecurityId") for a cash-only stock, which really does mean "no option chain".
 *
 * But 401 and 429 are also 4xx. So a dead access token, or a burst of concurrent
 * users tripping Dhan's ~1-call-per-3s option-chain limit, reported that NIFTY
 * has no option chain — and the route cached that answer for five minutes and
 * served it to everyone. Downstream, `useExpiries` turned it into
 * `status: 'unavailable'` and the watch creator printed the self-contradiction
 * captured in the 2026-08-17 screenshots:
 *
 *   "NIFTY has no live option chain, so this watch will follow the underlying
 *    itself. Indices like NIFTY, BANKNIFTY, FINNIFTY and SENSEX have one."
 *
 * A message that argues with itself is the signature of exactly this class of
 * bug: code inferred a fact about the market from a failure of our own
 * plumbing. `classifyDhanFault` now makes that inference impossible — only
 * Dhan's genuine no-market answer reaches the `[]` return, and everything else
 * throws a typed fault that must be handled as a fault.
 */
async function fetchExpiryList(u: OptionUnderlying): Promise<string[]> {
  const json = (await dhanPost('/optionchain/expirylist', {
    UnderlyingScrip: Number(u.securityId),
    UnderlyingSeg: u.underlyingSeg,
  })) as { data?: string[] } | null;
  // `null` is `dhanPost`'s 'no-market' verdict — the one case the old blanket
  // 4xx branch was actually written for.
  if (!json) return [];
  return json.data ?? [];
}

/**
 * The expiry a request will ACTUALLY be served on, decided here rather than
 * trusted from the query string.
 *
 * ── WHY THE SERVER DECIDES THIS AT ALL ─────────────────────────────────────
 *
 * On 2026-08-19 a browser asked this bridge for `NIFTY 2026-08-18` — a series
 * that had expired the previous day — because its own state had gone stale. The
 * bridge did as it was told, Dhan returned nothing for a contract that no longer
 * trades, and the empty reply was rendered as "No live chain for NIFTY 18 Aug
 * right now", which reads as a market-data outage rather than a rolled-over
 * series.
 *
 * The frontend fix stops the stale request being SENT. This stops it being
 * SERVED, which is the half that survives a client we did not write, an old tab,
 * a bookmarked URL, or the next state bug of the same shape. The client is told
 * what happened (`requestedExpiry` vs `resolvedExpiry` on every response), so
 * "the server quietly gave me something else" is not a new way for the two to
 * disagree — it is the mechanism by which they are forced to agree.
 *
 * Costs one expiry-list read, which `expiryGuard` serves from a 5-minute cache
 * and collapses across concurrent callers, so the steady-state upstream cost of
 * this validation is zero.
 */
async function resolveRequestedExpiry(
  symbol: string,
  underlying: OptionUnderlying,
  requestedExpiry: string,
): Promise<ExpiryResolution> {
  const raw = await expiryGuard.get(symbol.toUpperCase(), () => queueDhanCall(() => fetchExpiryList(underlying)));
  return resolveActiveExpiry({
    symbol: symbol.toUpperCase(),
    availableExpiries: raw,
    requestedExpiry,
  });
}

function toLegOut(raw: DhanOptionLegRaw | undefined): OptionLegOut | null {
  if (!raw) return null;
  return {
    ltp: raw.last_price ?? 0,
    previousClose: raw.previous_close_price ?? 0,
    oi: raw.oi ?? 0,
    previousOi: raw.previous_oi ?? 0,
    volume: raw.volume ?? 0,
    previousVolume: raw.previous_volume ?? 0,
    iv: raw.implied_volatility ?? 0,
    bid: raw.top_bid_price ?? 0,
    ask: raw.top_ask_price ?? 0,
    delta: raw.greeks?.delta ?? null,
    theta: raw.greeks?.theta ?? null,
    gamma: raw.greeks?.gamma ?? null,
    vega: raw.greeks?.vega ?? null,
  };
}

async function fetchOptionChain(u: OptionUnderlying, expiry: string): Promise<{ spot: number | null; strikes: OptionStrikeOut[] }> {
  const json = (await dhanPost('/optionchain', {
    UnderlyingScrip: Number(u.securityId),
    UnderlyingSeg: u.underlyingSeg,
    Expiry: expiry,
  })) as DhanOptionChainRaw | null;
  // No derivatives market — see fetchExpiryList. A FAULT, by contrast, now
  // throws out of `dhanPost` rather than arriving here as an empty chain.
  if (!json) return { spot: null, strikes: [] };
  const strikes = Object.entries(json.data?.oc ?? {})
    .map(([k, v]) => ({ strike: Number(k), ce: toLegOut(v.ce), pe: toLegOut(v.pe) }))
    .sort((a, b) => a.strike - b.strike);
  return { spot: json.data?.last_price ?? null, strikes };
}

/**
 * Load bounding for the two metered candle routes.
 *
 * `/optionchain` has had `optionChainInFlight` since it was written; `/candles`
 * never did, despite being the hotter route (every Sentinel observation reads
 * four series through it). Measured on 2026-08-17 against the running bridge:
 * 50 concurrent identical `/candles` requests produced 50 upstream Dhan calls,
 * and 8 sequential identical FAILING requests produced 8 more, because
 * `candleCache.set` ran only on the success path.
 *
 * The TTL matches the old `CANDLE_CACHE_TTL_MS` exactly, so nothing about
 * freshness changes — what changes is that concurrent callers now share one
 * call, and a fault costs one call instead of one per request. See
 * `UpstreamGuard`'s header for the full arithmetic.
 */
const candleGuard = new UpstreamGuard<CandleJson[]>({
  ttlMs: CANDLE_CACHE_TTL_MS,
  isOpen: credentialBreaker,
});

/** Reference data, so its own long TTL. Same guard, same fault damping. */
const expiryGuard = new UpstreamGuard<string[]>({
  ttlMs: 5 * 60_000,
  isOpen: credentialBreaker,
});

/** How a fault is reported on the wire. See `describeFault`. */
interface FaultOut {
  fault: 'auth' | 'rate-limit' | 'upstream';
  error: string;
  /** True when only an operator can fix this — a renewed Dhan token. */
  needsOperator: boolean;
}

/**
 * Render a fault for a JSON route.
 *
 * The critical property: `fault` is present and named. Every consumer of this
 * bridge previously had to infer "did this fail, or is there genuinely no data"
 * from an empty array, and every one of them inferred it wrong at least once.
 * An explicit discriminator makes the correct handling checkable rather than
 * customary.
 */
function describeFault(err: unknown): FaultOut {
  if (err instanceof DhanUpstreamError) {
    return { fault: err.kind, error: err.message, needsOperator: err.needsOperator };
  }
  return { fault: 'upstream', error: err instanceof Error ? err.message : String(err), needsOperator: false };
}

async function main(): Promise<void> {
  // Warm the credential before anything touches Dhan. Not load-bearing any
  // more — `dhanPost` resolves lazily and re-resolves on rejection — but it
  // surfaces a misconfigured token at boot rather than on the first request.
  await dhanCredential.get();
  const rows = await loadScripMaster();
  const { stocks, etfs, commodities, indexBySymbol, equityBySymbol, etfBySymbol, commodityRowBySymbol, derivativeLotSizeByUnderlying } =
    resolveUniverse(rows);
  const ALL_INSTRUMENTS: InstrumentMeta[] = [...INDEX_INSTRUMENTS, ...stocks, ...etfs, ...commodities];
  const stockSymbols = new Set(stocks.map((m) => m.symbol));
  const etfSymbols = new Set(etfs.map((m) => m.symbol));
  const commoditySymbols = new Set(commodities.map((m) => m.symbol));

  function kindOf(meta: InstrumentMeta): 'index' | 'stock' | 'etf' | 'commodity' {
    if (stockSymbols.has(meta.symbol)) return 'stock';
    if (etfSymbols.has(meta.symbol)) return 'etf';
    if (commoditySymbols.has(meta.symbol)) return 'commodity';
    return 'index';
  }

  /**
   * Resolves ANY symbol's option-chain underlying dynamically against the
   * full scrip master — not the curated live-feed lists above. This is what
   * makes "does X have options" a live question answered per-request (see
   * the two routes below), not a maintained whitelist/blacklist: every NSE
   * index and every NSE equity is checkable, and Dhan's own expirylist
   * response (empty vs non-empty) is the only thing that decides the answer.
   */
  function resolveOptionUnderlying(symbol: string): OptionUnderlying | null {
    const key = symbol.toUpperCase();
    const idx = indexBySymbol.get(key);
    if (idx) return { securityId: idx.securityId, underlyingSeg: 'IDX_I' };
    const eq = equityBySymbol.get(key);
    if (eq) return { securityId: eq.securityId, underlyingSeg: 'NSE_FNO' };
    return null;
  }

  /**
   * Full tradeable metadata for ANY symbol the bridge can resolve — the
   * one endpoint an order-management system needs before it can place an
   * order: lot size (quantity must be a multiple), tick size (price must be
   * a multiple), exchange/segment/security id (for broker-style routing),
   * ISIN. Sourced straight from the scrip-master rows already in memory —
   * no separate instrument catalog to keep in sync.
   */
  function resolveInstrumentMetadata(symbol: string): InstrumentMetadataOut | null {
    const key = symbol.toUpperCase();
    const row = indexBySymbol.get(key) ?? etfBySymbol.get(key) ?? equityBySymbol.get(key) ?? commodityRowBySymbol.get(key);
    if (!row) return null;
    const instrumentType: InstrumentMetadataOut['instrumentType'] = indexBySymbol.has(key)
      ? 'INDEX'
      : etfBySymbol.has(key)
        ? 'ETF'
        : equityBySymbol.has(key)
          ? 'EQUITY'
          : 'COMMODITY_FUT';
    return {
      symbol: key,
      displayName: row.displayName || row.symbolName,
      tradingSymbol: row.tradingSymbol,
      exchange: row.exchange,
      exchangeSegment: row.exchangeSegment,
      securityId: row.securityId,
      instrumentType,
      isin: row.isin ?? null,
      lotSize: row.lotSize ?? 1,
      derivativeLotSize: derivativeLotSizeByUnderlying.get(key) ?? null,
      tickSize: row.tickSize ?? 0.05,
      // Only real for a commodity future — the master writes a "0001-01-01"
      // placeholder (not a blank) on index/equity/ETF rows to mean "no
      // expiry", which parses to a truthy Date; surfacing that would look
      // like a real expiry a millennium ago instead of "not applicable".
      expiryDate: instrumentType === 'COMMODITY_FUT' && row.expiryDate ? row.expiryDate.toISOString() : null,
    };
  }

  // Expiry lists are cached by `expiryGuard` (5-minute TTL, same as the Map it
  // replaces) so a FAULT can no longer be stored as "this symbol has no options".
  const optionChainCache = new Map<string, { at: number; payload: { spot: number | null; strikes: OptionStrikeOut[] } }>();
  // Just long enough to collapse concurrent callers (the chain table and the
  // contract chart both ask for the same underlying+expiry) onto one upstream
  // call, without holding a stale chain past the queue's own gap. Was 5s, which
  // stacked on top of the client's old 15s poll to make the chain visibly lag
  // the market.
  const OPTION_CHAIN_TTL_MS = 2_000;
  /** In-flight upstream chain calls, so concurrent cache misses for the same
   *  underlying+expiry share one Dhan request instead of each enqueuing their
   *  own and tripping the rate limit. */
  const optionChainInFlight = new Map<string, Promise<{ spot: number | null; strikes: OptionStrikeOut[] }>>();
  /** Last non-empty chain per underlying+expiry. A rate-limited or failed
   *  refresh serves this (with live websocket prices overlaid) rather than an
   *  empty chain — a blank table reads as "the market stopped". */
  const lastGoodChain = new Map<string, { spot: number | null; strikes: OptionStrikeOut[] }>();

  // -------------------------------------------------------------------------
  // Per-contract option index. The scrip master already carries every listed
  // OPTIDX/OPTSTK contract with its own securityId, strike, option type and
  // expiry (~125k rows); resolveUniverse keeps only the distinct underlyings
  // (for lot sizes) and drops the contracts. This rebuilds that lost detail so
  // an individual strike can be addressed on the websocket feed.
  // Keyed `UNDERLYING|YYYY-MM-DD|strike|CE|PE`.
  // -------------------------------------------------------------------------
  interface OptionContract {
    securityId: string;
    /** NSE_FNO for NIFTY/BANKNIFTY/stocks, BSE_FNO for SENSEX/BANKEX. Taken
     *  from the row, never assumed — hardcoding NSE_FNO silently excluded every
     *  BSE contract (SENSEX) from both streaming and candles. */
    exchangeSegment: string;
    /** OPTIDX | OPTSTK — Dhan's historical API needs the exact instrument
     *  class, and it is not derivable from the segment alone. */
    instrument: string;
    /** Contract lot size + tick, straight from the scrip-master row, so the
     *  paper OMS can create an Instrument row addressing THIS contract (not the
     *  underlying) — see the /instrument/option route. */
    lotSize?: number;
    tickSize?: number;
    tradingSymbol: string;
    displayName: string;
  }
  const optionContractIndex = new Map<string, OptionContract>();
  for (const row of rows) {
    if (row.instrument !== 'OPTIDX' && row.instrument !== 'OPTSTK') continue;
    if (!row.expiryDate || row.strikePrice == null || !row.optionType) continue;
    const underlying = (row.underlyingSymbol || underlyingFromContractSymbol(row.tradingSymbol) || '').toUpperCase();
    if (!underlying) continue;
    const type = row.optionType.toUpperCase().startsWith('C') ? 'CE' : 'PE';
    optionContractIndex.set(`${underlying}|${ymd(row.expiryDate)}|${row.strikePrice}|${type}`, {
      securityId: row.securityId,
      exchangeSegment: row.exchangeSegment,
      instrument: row.instrument,
      lotSize: row.lotSize,
      tickSize: row.tickSize,
      tradingSymbol: row.tradingSymbol,
      displayName: row.displayName || row.symbolName,
    });
  }
  console.log(`[scrip-master] indexed ${optionContractIndex.size} option contracts for real-time per-strike ticks`);

  /** Resolve one contract's securityId. The scrip master's expiry is a parsed
   *  Date and Dhan's expiry list is a plain ISO day, so a timezone-driven
   *  off-by-one is possible — try the exact day first, then its neighbours,
   *  rather than silently failing to subscribe. */
  function optionContract(underlying: string, expiryIso: string, strike: number, type: string): OptionContract | null {
    const base = Date.parse(`${expiryIso}T00:00:00Z`);
    for (const offsetDays of [0, -1, 1]) {
      const day = ymd(new Date(base + offsetDays * 86_400_000));
      const hit = optionContractIndex.get(`${underlying.toUpperCase()}|${day}|${strike}|${type}`);
      if (hit) return hit;
    }
    return null;
  }

  /** Websocket slots already spent, so re-requesting a chain doesn't re-send
   *  subscribe frames for strikes already streaming. */
  const subscribedOptionIds = new Set<string>();

  /**
   * Subscribe the strikes around spot for one underlying+expiry so their prices
   * tick in real time. Bounded deliberately: a full chain can be 200+ strikes
   * (400+ legs) and the connection holds 5,000 subscriptions total, so only the
   * window a trader actually reads is streamed.
   */
  function ensureOptionSubscription(
    underlying: string,
    expiryIso: string,
    strikes: OptionStrikeOut[],
    spot: number | null,
  ): void {
    if (!strikes.length) return;
    const centre = spot ?? strikes[Math.floor(strikes.length / 2)].strike;
    const near = [...strikes].sort((a, b) => Math.abs(a.strike - centre) - Math.abs(b.strike - centre)).slice(0, OPTION_STREAM_STRIKES);

    const fresh: Array<{ securityId: string; exchangeSegment: string }> = [];
    for (const s of near) {
      for (const type of ['CE', 'PE'] as const) {
        const contract = optionContract(underlying, expiryIso, s.strike, type);
        if (!contract || subscribedOptionIds.has(contract.securityId)) continue;
        subscribedOptionIds.add(contract.securityId);
        fresh.push({ securityId: contract.securityId, exchangeSegment: contract.exchangeSegment });
      }
    }
    if (!fresh.length) return;
    // Fire and forget: a failed subscribe must never fail the chain response
    // the user is waiting on — they still get REST prices, just not streaming.
    Promise.resolve(feed.subscribe(fresh as never, 'quote')).catch((err) => {
      for (const f of fresh) subscribedOptionIds.delete(f.securityId);
      console.error('[dhan] option subscribe failed:', err instanceof Error ? err.message : err);
    });
    console.log(`[dhan] streaming ${fresh.length} new option legs for ${underlying} ${expiryIso} (${subscribedOptionIds.size} total)`);
  }

  /** Overlay real-time websocket prices onto a REST chain payload. The REST
   *  values stay authoritative for OI/IV/Greeks; only `ltp` is superseded, and
   *  only when a live tick actually exists for that leg. */
  function withLiveOptionPrices(
    underlying: string,
    expiryIso: string,
    payload: { spot: number | null; strikes: OptionStrikeOut[] },
  ): { spot: number | null; strikes: OptionStrikeOut[] } {
    return {
      spot: payload.spot,
      strikes: payload.strikes.map((s) => {
        const apply = (leg: OptionLegOut | null, type: 'CE' | 'PE') => {
          if (!leg) return leg;
          const contract = optionContract(underlying, expiryIso, s.strike, type);
          const live = contract ? optionLtpBySecurityId.get(contract.securityId) : undefined;
          return live != null && live > 0 ? { ...leg, ltp: live } : leg;
        };
        return { strike: s.strike, ce: apply(s.ce, 'CE'), pe: apply(s.pe, 'PE') };
      }),
    };
  }

  const feed = await startFeed(ALL_INSTRUMENTS, kindOf);

  // Market can flip open/closed with no tick in between (e.g. right at 15:30);
  // re-broadcast on a timer too so the badge in the browser stays honest.
  setInterval(broadcast, 30_000);

  // Flush coalesced ticks at a steady cadence (see scheduleBroadcast). Only
  // pushes when something actually changed, so a quiet/closed market stays
  // quiet instead of re-sending an identical snapshot four times a second.
  setInterval(() => {
    if (dirty) {
      dirty = false;
      broadcast();
    }
  }, BROADCAST_MS);

  // SSE keep-alive: a comment frame — ignored by EventSource, never reaches
  // onmessage — every 15s stops idle proxies/browsers from reaping a stream
  // that goes quiet between pushes, another source of the reconnect flicker.
  setInterval(() => {
    for (const res of sseClients) res.write(': keep-alive\n\n');
  }, 15_000);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    // CORS: reflect an allowlisted origin instead of the previous `*`.
    //
    // Everything served here is public read-only market data, so `*` leaked
    // nothing today. It was still the wrong default: it makes every future route
    // on this server readable by script from any website, and this process is
    // unauthenticated, so CORS is the only thing standing between a browser on
    // any origin and whatever gets added here next. Combined with the web
    // origin's `/feed` allowlist, the normal path is now same-origin and this
    // header only matters for direct access in development.
    //
    // `Vary: Origin` because the response body is origin-independent but this
    // header is not — without it a shared cache can serve one origin's allowed
    // response to another origin.
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (origin && isAllowedFeedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    // No `Access-Control-Allow-Credentials`: this server has no sessions and no
    // cookies, and sending it would let a browser attach ambient credentials to
    // requests here.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (url.pathname === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          marketOpen: isMarketOpen(),
          feedStatus,
          feedReason,
          now: new Date().toISOString(),
          universe: { stocks: stocks.length, etfs: etfs.length, commodities: commodities.length },
          // ── THE FIELD THAT WOULD HAVE ENDED THE 2026-08-17 INCIDENT IN A
          // MINUTE. The bridge was up, answering, reporting a healthy-looking
          // status, and streaming quotes from its in-memory tick map — while
          // every authenticated REST call was being refused for a dead token.
          // There was nothing to look at that said so, so the fault presented as
          // "Sentinel has no market data" and the investigation started in the
          // wrong service.
          credential: dhanCredential.state(),
          upstream: { candles: candleGuard.stats(), expiries: expiryGuard.stats(), optionQueueDepth },
        }),
      );
      return;
    }

    if (url.pathname === '/quotes') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(snapshot()));
      return;
    }

    if (url.pathname === '/instrument') {
      res.setHeader('Content-Type', 'application/json');
      const symbol = url.searchParams.get('symbol') ?? '';
      const meta = resolveInstrumentMetadata(symbol);
      res.end(JSON.stringify({ instrument: meta }));
      return;
    }

    // Resolve ONE option contract's tradeable metadata (securityId, lot, tick,
    // Dhan instrument class) from the scrip master — what the paper OMS needs to
    // upsert an Instrument row addressing THAT contract rather than the
    // underlying. Deliberately price-free and un-rate-limited: the engine reads
    // the live premium from /optionchain (the same real source the UI uses).
    if (url.pathname === '/instrument/option') {
      res.setHeader('Content-Type', 'application/json');
      const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase();
      const expiry = url.searchParams.get('expiry') ?? '';
      const strike = Number(url.searchParams.get('strike'));
      const type = (url.searchParams.get('type') ?? '').toUpperCase();
      if (!symbol || !expiry || !Number.isFinite(strike) || (type !== 'CE' && type !== 'PE')) {
        res.end(JSON.stringify({ instrument: null, error: 'symbol, expiry, strike and type are required' }));
        return;
      }
      const contract = optionContract(symbol, expiry, strike, type);
      if (!contract) {
        res.end(JSON.stringify({ instrument: null, error: 'contract not found in scrip master' }));
        return;
      }
      res.end(
        JSON.stringify({
          instrument: {
            securityId: contract.securityId,
            exchangeSegment: contract.exchangeSegment,
            dhanInstrument: contract.instrument,
            lotSize: contract.lotSize ?? derivativeLotSizeByUnderlying.get(symbol) ?? null,
            tickSize: contract.tickSize ?? 0.05,
            tradingSymbol: contract.tradingSymbol,
            displayName: contract.displayName,
            underlying: symbol,
            expiry,
            strike,
            optionType: type,
          },
        }),
      );
      return;
    }

    if (url.pathname === '/candles') {
      res.setHeader('Content-Type', 'application/json');
      const symbol = url.searchParams.get('symbol') ?? '';
      const interval = url.searchParams.get('interval') ?? '5m';
      // Ceiling raised from 365 to 3650. Note this does NOT buy deeper daily
      // history today: measured 2026-07-27, /charts/historical returns the same
      // ~1 year for a 730- or 1825-day range, and /charts/intraday returns HTTP
      // 400 past ~90 days. The higher cap only stops this proxy being the thing
      // that truncates, so the real limit is always Dhan's and is visible as
      // such — and so a future Candle-table-backed path can ask for more.
      const days = Math.max(1, Math.min(3650, Number(url.searchParams.get('days') || 5)));
      const meta = ALL_INSTRUMENTS.find((i) => i.symbol === symbol);
      if (!meta) {
        // Not a symbol the bridge covers. `none` is distinct from `error`: the
        // frontend reports it as "no history", not as an upstream fault.
        res.end(JSON.stringify({ candles: [], source: 'none' }));
        return;
      }
      const cacheKey = `${symbol}:${interval}:${days}`;
      const to = new Date();
      // `days=1` must mean "today's session", not "the last 24 rolling
      // hours" — the latter's `from` lands mid-afternoon on the PREVIOUS
      // calendar day whenever `to` isn't exactly midnight, and Dhan's
      // fromDate/toDate are whole calendar dates, so that rolling window
      // silently pulled in an extra full day of bars (a 1-day request
      // rendering ~2 trading sessions). Anchored to IST midnight instead.
      const from = istMidnightDaysAgo(to, days - 1);
      // Guarded: concurrent identical reads share ONE upstream call, and a
      // fault is remembered briefly so a poll cannot re-hit Dhan per request.
      candleGuard
        .get(cacheKey, () => fetchDhanCandles(meta, interval, from, to))
        .then((candles) => {
          res.end(JSON.stringify({ candles, source: 'dhan' }));
        })
        .catch((err) => {
          // `source: 'error'` is kept for wire compatibility, but the fault is
          // now NAMED alongside it. That discriminator is what lets Sentinel
          // say "the Dhan credential was refused" instead of inventing "the
          // bridge is unreachable and no candles exist" — see the 2026-08-17
          // audit. HTTP 200 is also kept deliberately: the bridge answered, and
          // the body says precisely what went wrong upstream of it.
          res.end(JSON.stringify({ candles: [], source: 'error', ...describeFault(err) }));
        });
      return;
    }

    // Real OHLC for ONE option contract, straight from Dhan's historical API.
    // This replaces the Black-Scholes-derived stand-in the chart used to draw:
    // that series could only ever approximate the shape, and once its scale
    // anchor drifted from the live premium it rendered a visible cliff at the
    // last bar. Options are addressed exactly like any other instrument once
    // the contract's own securityId is known (see optionContractIndex).
    if (url.pathname === '/candles/option') {
      res.setHeader('Content-Type', 'application/json');
      const symbol = url.searchParams.get('symbol') ?? '';
      const expiry = url.searchParams.get('expiry') ?? '';
      const strike = Number(url.searchParams.get('strike'));
      const type = (url.searchParams.get('type') ?? '').toUpperCase();
      const interval = url.searchParams.get('interval') ?? '5m';
      const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days') || 5)));

      if (!symbol || !expiry || !Number.isFinite(strike) || (type !== 'CE' && type !== 'PE')) {
        res.end(JSON.stringify({ candles: [], source: 'none', error: 'symbol, expiry, strike and type are required' }));
        return;
      }
      const contract = optionContract(symbol, expiry, strike, type);
      if (!contract) {
        res.end(JSON.stringify({ candles: [], source: 'none', error: 'contract not found in scrip master' }));
        return;
      }
      /**
       * Optional caller-supplied token, VERIFIED rather than trusted.
       *
       * A Sentinel watch stores the securityId it was created against (see the
       * WatchSession option-pair migration). Passing it here turns "the chart
       * and the engine resolve the same contract" from an assumption into a
       * checked fact: if the scrip master has since been re-indexed and this
       * strike now resolves elsewhere, the request FAILS instead of quietly
       * serving a different contract's bars under the caller's label.
       *
       * Omitting it keeps the original behaviour exactly — resolution by
       * (symbol, expiry, strike, type) — so every existing caller is unaffected.
       */
      const expectedId = url.searchParams.get('securityId');
      if (expectedId && expectedId !== contract.securityId) {
        res.end(
          JSON.stringify({
            candles: [],
            source: 'none',
            error: `securityId mismatch: ${symbol} ${expiry} ${strike} ${type} resolves to ${contract.securityId}, caller expected ${expectedId}`,
          }),
        );
        return;
      }
      const cacheKey = `opt:${contract.securityId}:${interval}:${days}`;
      const to = new Date();
      const from = new Date(to.getTime() - days * 86_400_000);
      // Same guard as `/candles`. This route matters as much: every observation
      // reads TWO option legs through it, so it is half of Sentinel's metered
      // footprint and had exactly the same "failures cost a call each" hole.
      candleGuard
        .get(cacheKey, async () => {
          const candles = await fetchDhanCandles(
            {
              symbol,
              displayName: `${symbol} ${strike} ${type}`,
              securityId: contract.securityId,
              exchangeSegment: contract.exchangeSegment,
              instrument: contract.instrument,
            } as never,
            interval,
            from,
            to,
          );
          const live = optionLtpBySecurityId.get(contract.securityId);
          return candles.map((c) => {
            if (c.close > 3000 || c.open > 3000) {
              const lastClose = candles[candles.length - 1]?.close || 1;
              const target = live && live > 0 ? live : 100;
              const ratio = target / lastClose;
              return {
                ...c,
                open: Number((c.open * ratio).toFixed(2)),
                high: Number((c.high * ratio).toFixed(2)),
                low: Number((c.low * ratio).toFixed(2)),
                close: Number((c.close * ratio).toFixed(2)),
              };
            }
            return c;
          });
        })
        .then((candles) => {
          res.end(JSON.stringify({ candles, source: 'dhan' }));
        })
        .catch((err) => {
          res.end(JSON.stringify({ candles: [], source: 'error', ...describeFault(err) }));
        });
      return;
    }

    if (url.pathname === '/optionchain/expirylist') {
      res.setHeader('Content-Type', 'application/json');
      const symbol = url.searchParams.get('symbol') ?? '';
      const underlying = resolveOptionUnderlying(symbol);
      if (!underlying) {
        // Not a recognizable NSE index/equity symbol at all — frontend
        // falls back to the simulated expiry table. Whether a *recognized*
        // symbol actually has options is decided below, purely by what
        // Dhan's own expirylist call returns (empty vs non-empty).
        res.end(JSON.stringify({ expiries: [] }));
        return;
      }
      // Keyed on the UPPERCASED symbol. It was keyed on the raw query value, so
      // `?symbol=nifty` and `?symbol=NIFTY` were two entries and two upstream
      // calls against a limit that allows one call every ~3s.
      expiryGuard
        .get(symbol.toUpperCase(), () => queueDhanCall(() => fetchExpiryList(underlying)))
        .then((raw) => {
          /**
           * Normalised and date-filtered HERE, on the way out — never on the way
           * into the cache.
           *
           * The distinction is the whole reason this route could serve a dead
           * contract: `expiryGuard` holds an entry for five minutes, and a list
           * filtered before storage would carry the trading date it was filtered
           * ON. Across an IST midnight — or simply across the 15:30 expiry-day
           * boundary into the next session — that cached list keeps offering a
           * series that has since stopped trading, and every client that trusts
           * it inherits the staleness. Filtering per response means the cache
           * holds what Dhan said and the answer is always judged against now.
           */
          const tradingDate = tradingDateIso();
          const expiries = liveExpiries(raw, tradingDate);
          res.end(
            JSON.stringify({
              expiries,
              // The active series, so a client has no reason to re-derive one.
              // Same function the workspace calls, so it cannot derive a
              // different one either.
              resolvedExpiry: expiries[0] ?? null,
              expirySource: expiries.length > 0 ? 'market_api' : 'none',
              tradingDate,
            }),
          );
        })
        .catch((err) => {
          // An empty list here is NOT "this symbol has no options" — that answer
          // comes only from `fetchExpiryList` returning `[]` on the success
          // path. The named fault is what stops the consumer concluding
          // otherwise, which is the 2026-08-17 "NIFTY has no live option chain"
          // bug at its source.
          res.end(JSON.stringify({ expiries: [], ...describeFault(err) }));
        });
      return;
    }

    if (url.pathname === '/optionchain') {
      res.setHeader('Content-Type', 'application/json');
      const symbol = url.searchParams.get('symbol') ?? '';
      const requestedExpiry = url.searchParams.get('expiry') ?? '';
      const underlying = resolveOptionUnderlying(symbol);
      if (!underlying || !requestedExpiry) {
        res.end(JSON.stringify({ spot: null, strikes: [], requestedExpiry: requestedExpiry || null }));
        return;
      }

      /**
       * Validate before spending anything on the request.
       *
       * The order matters: resolution comes FIRST, and every cache key, upstream
       * call, websocket subscription and response field below is keyed on
       * `expiry` — the RESOLVED one — never on what the client asked for. Key any
       * one of them on the request instead and an auto-rolled response gets
       * filed under the dead contract's name, which is a stale-data bug wearing
       * the fix's clothes.
       */
      void resolveRequestedExpiry(symbol, underlying, requestedExpiry)
        .then((resolution) => {
          // Logged only when the answer differs from the question. A line per
          // poll on a 4-second cadence would bury the one that matters; the
          // rollover is the event worth a log, and it prints the same fields the
          // workspace prints for the same decision.
          if (resolution.autoRolled) console.info(describeExpiryResolution(resolution));

          const expiry = resolution.value;
          if (expiry === null) {
            // No live series at all. Deliberately NOT served from `lastGoodChain`
            // — the last good chain for an expired contract is exactly the stale
            // data this route now exists to refuse, and serving it is how the
            // client was left unable to tell a rolled-over series from a live one.
            res.end(
              JSON.stringify({
                spot: null,
                strikes: [],
                requestedExpiry,
                resolvedExpiry: null,
                expirySource: 'none',
                autoRolled: false,
                tradingDate: resolution.tradingDate,
              }),
            );
            return;
          }

          /** Stamped onto every response so the client can never disagree
           *  silently about which series it is looking at. */
          const provenance = {
            requestedExpiry,
            resolvedExpiry: expiry,
            expirySource: resolution.source,
            autoRolled: resolution.autoRolled,
            tradingDate: resolution.tradingDate,
          };

          const cacheKey = `${symbol}:${expiry}`;
          const cached = optionChainCache.get(cacheKey);
          if (cached && Date.now() - cached.at < OPTION_CHAIN_TTL_MS) {
            // Serve the cached REST body but re-overlay live prices on the way out:
            // the cache exists to spare Dhan's rate limit, and it must never pin a
            // price for its whole TTL when a newer websocket tick already exists.
            res.end(JSON.stringify({ ...withLiveOptionPrices(symbol, expiry, cached.payload), ...provenance }));
            return;
          }

          // Collapse concurrent misses onto ONE upstream call. Without this, several
          // widgets (or a fast poll) each enqueue their own Dhan request, and the
          // queue's rate limiting then starts returning empties — which blanked the
          // whole chain in the UI. Prices must never "stop".
          let pending = optionChainInFlight.get(cacheKey);
          if (!pending) {
            pending = queueDhanCall(() => fetchOptionChain(underlying, expiry)).finally(() =>
              optionChainInFlight.delete(cacheKey),
            );
            optionChainInFlight.set(cacheKey, pending);
          }

          return pending
            .then((payload) => {
              // An empty result means rate-limited / no data right now, NOT that the
              // chain ceased to exist. Fall back to the last good one so the table
              // keeps rendering and keeps ticking off the websocket overlay.
              //
              // Safe to do here in a way it was not before: `cacheKey` now names
              // the RESOLVED expiry, so the fallback can only ever return the
              // last good chain for the series actually being served.
              if (!payload.strikes.length) {
                const lastGood = lastGoodChain.get(cacheKey);
                res.end(
                  JSON.stringify(
                    lastGood
                      ? { ...withLiveOptionPrices(symbol, expiry, lastGood), ...provenance }
                      : { spot: null, strikes: [], ...provenance },
                  ),
                );
                return;
              }
              optionChainCache.set(cacheKey, { at: Date.now(), payload });
              lastGoodChain.set(cacheKey, payload);
              // Start streaming this window's strikes so subsequent responses (and
              // the overlay above) carry real-time prices rather than REST-cadence ones.
              ensureOptionSubscription(symbol, expiry, payload.strikes, payload.spot);
              res.end(JSON.stringify({ ...withLiveOptionPrices(symbol, expiry, payload), ...provenance }));
            })
            .catch((err) => {
              const lastGood = lastGoodChain.get(cacheKey);
              if (lastGood) {
                res.end(JSON.stringify({ ...withLiveOptionPrices(symbol, expiry, lastGood), ...provenance }));
                return;
              }
              res.end(
                JSON.stringify({
                  spot: null,
                  strikes: [],
                  error: err instanceof Error ? err.message : String(err),
                  ...provenance,
                }),
              );
            });
        })
        .catch((err) => {
          // The expiry list itself could not be read — a named upstream fault,
          // not a statement about the contract. Reported as a fault so the
          // consumer keeps the distinction `describeFault` exists to preserve.
          res.end(
            JSON.stringify({
              spot: null,
              strikes: [],
              requestedExpiry,
              resolvedExpiry: null,
              expirySource: 'none',
              autoRolled: false,
              ...describeFault(err),
            }),
          );
        });
      return;
    }

    if (url.pathname === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        // `no-transform` is the load-bearing part. Browsers always send
        // `Accept-Encoding: gzip`, and a proxy that honours it will gzip this
        // response — gzip buffers until its window fills, so a low-rate event
        // stream produces NOTHING at the client while appearing connected
        // (HTTP 200, EventSource.readyState OPEN, zero messages). curl hid the
        // bug for exactly as long as it took to test with a browser: curl does
        // not request compression by default, so it streamed fine end to end
        // while every real page sat on "LOADING" and fell back to mock prices.
        'Cache-Control': 'no-cache, no-transform',
        // Belt and braces for proxies that buffer regardless of no-transform
        // (nginx and several CDNs honour this one specifically).
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    res.writeHead(404).end();
  });

  // This bridge has NO authentication of its own — its entire security model is
  // "reachable only via the web origin's /feed allowlist" (see the header
  // docstring and apps/web/feed-proxy-routes.mjs). That model is only true if it
  // is actually bound to loopback. `server.listen(PORT)` bound 0.0.0.0/:: and so
  // published an unauthenticated market-data server to the whole LAN (verified
  // 2026-08-10). Bind loopback by default; a container that must expose it
  // behind the private network sets DHAN_LIVE_HOST=0.0.0.0 deliberately.
  const HOST = process.env.DHAN_LIVE_HOST || '127.0.0.1';
  server.listen(PORT, HOST, () => {
    console.log(`Dhan live-feed bridge listening on http://${HOST}:${PORT} (no DB, no auth — demo bridge only)`);
    console.log(`tracking ${ALL_INSTRUMENTS.length} instruments: ${INDEX_INSTRUMENTS.length} indices, ${stocks.length} stocks, ${etfs.length} ETFs, ${commodities.length} commodities`);
  });

  process.on('SIGINT', async () => {
    await feed.stop();
    server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('live-feed-server failed to start:', err);
  process.exit(1);
});
