import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SourceFetcherService } from '../ingestion/source-fetcher.service';
import { FILING_DATASETS } from '../catalogue/filing-datasets';
import { isoDay, parseBhavcopy } from './bhavcopy.parser';

/**
 * Turns one session's bhavcopy into daily `Candle` rows.
 *
 * ── WHY Candle AND NOT A NEW TABLE ─────────────────────────────────────────
 * `Candle` already exists, is already what the chart and the indicator engine
 * read, and its unique key (instrumentId, timeframe, bucketStart) is exactly
 * the grain of a daily bar. A parallel "EOD price" table would mean the 52-week
 * range and the chart disagreed about what a day's high was, which is the kind
 * of split nobody notices until a user does.
 *
 * `source` is written as `nse-bhavcopy` so a bar's origin stays visible beside
 * the Dhan-sourced bars already in the table.
 *
 * ── WHAT IS NOT COVERED, AND WHY THAT IS HONEST ────────────────────────────
 * `Candle` is keyed on `instrumentId`. 198 of 2,553 listed companies have no
 * broker instrument, so they get no bars — they remain researchable but not
 * priceable, which is the state the identity layer already reports as
 * `tradable: false`. Inventing `Instrument` rows for them to make the numbers
 * look complete would put non-tradable things in the table the order path
 * reads from, which is a considerably worse problem than a missing chart.
 */

const TIMEFRAME = '1d';

export interface BhavcopySyncResult {
  requestedDate: string;
  /** What the file actually described. Differs from `requestedDate` more often than you would expect. */
  sessionDate: string | null;
  status: 'ok' | 'no-session' | 'unchanged' | 'failed' | 'date-mismatch';
  rows: number;
  candlesWritten: number;
  unmatchedSymbols: number;
}

@Injectable()
export class BhavcopyConnector {
  private readonly logger = new Logger(BhavcopyConnector.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fetcher: SourceFetcherService,
  ) {}

  /**
   * Ingest one session.
   *
   * `date` is the day to REQUEST. What comes back is authoritative about which
   * session it actually is, and the two are reconciled below rather than
   * assumed equal.
   */
  async syncSession(date: string, knownHash?: string | null): Promise<BhavcopySyncResult> {
    const base = { requestedDate: date, sessionDate: null, rows: 0, candlesWritten: 0, unmatchedSymbols: 0 };

    const fetched = await this.fetcher.fetchDataset({
      dataset: FILING_DATASETS['nse.bhavcopy'],
      scope: date,
      knownHash,
    });

    if (fetched.status === 'unchanged') return { ...base, status: 'unchanged' };
    if (fetched.status !== 'ok' || !fetched.body) {
      // A 404 here is the ordinary case, not a fault: weekends and holidays
      // have no bhavcopy. Reported as `no-session` so the backfill can tell it
      // apart from a network failure and not apply backoff to a Saturday.
      return { ...base, status: fetched.httpStatus === 404 ? 'no-session' : 'failed' };
    }

    const { sessionDate, rows, skipped } = parseBhavcopy(fetched.body);

    if (!sessionDate) {
      this.logger.warn(`bhavcopy ${date}: no parseable DATE1 — refusing to stamp bars with the requested date`);
      return { ...base, status: 'failed', rows: rows.length };
    }

    const actual = isoDay(sessionDate);

    if (actual !== date) {
      // Verified 2026-08-19: requesting the Sunday 16-Aug-2026 returns HTTP 200
      // carrying 14-Aug-2026 rows. Those bars are REAL and already ingested
      // under their own date, so re-writing them here would change nothing —
      // but silently accepting the mismatch is how a "Sunday session" gets
      // invented in the first place. Reported and skipped.
      this.logger.debug(`bhavcopy ${date}: file describes ${actual} — skipping (already covered by that date's run)`);
      return { ...base, sessionDate: actual, status: 'date-mismatch', rows: rows.length };
    }

    // Symbol -> instrument, via the identity spine. Only listings that have a
    // tradable instrument can carry candles.
    const listings = await this.prisma.securityListing.findMany({
      where: { exchange: 'NSE', instrumentId: { not: null } },
      select: { symbol: true, instrumentId: true },
    });
    const instrumentBySymbol = new Map(listings.map((l) => [l.symbol, l.instrumentId as string]));

    const bucketStart = sessionDate;
    const candles: {
      instrumentId: string;
      timeframe: string;
      bucketStart: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: bigint;
      source: string;
    }[] = [];
    let unmatched = 0;

    for (const row of rows) {
      const instrumentId = instrumentBySymbol.get(row.symbol);
      if (!instrumentId) {
        unmatched += 1;
        continue;
      }
      candles.push({
        instrumentId,
        timeframe: TIMEFRAME,
        bucketStart,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: BigInt(Math.round(row.volume)),
        source: 'nse-bhavcopy',
      });
    }

    // createMany + skipDuplicates rather than one upsert per bar: a year of
    // history is ~600,000 bars, and 600,000 round trips is the difference
    // between minutes and hours. A published session is immutable, so a bar we
    // already hold does not need rewriting — which is exactly the case
    // skipDuplicates handles, and why an upsert would be doing work for nothing.
    let written = 0;
    const BATCH = 2_000;
    for (let i = 0; i < candles.length; i += BATCH) {
      const { count } = await this.prisma.candle.createMany({
        data: candles.slice(i, i + BATCH),
        skipDuplicates: true,
      });
      written += count;
    }

    if (skipped.length > 0) {
      this.logger.warn(`bhavcopy ${actual}: ${skipped.length} rows skipped (${skipped[0]?.reason})`);
    }

    return {
      requestedDate: date,
      sessionDate: actual,
      status: 'ok',
      rows: rows.length,
      candlesWritten: written,
      unmatchedSymbols: unmatched,
    };
  }

  /**
   * Walk backwards from `endDate` for `days` calendar days, ingesting each
   * session.
   *
   * Weekends are skipped locally rather than discovered by a 404, which saves
   * roughly 2 of every 7 requests against an unofficial endpoint we would
   * rather not lean on harder than necessary. Holidays still cost a 404 —
   * that is the cheap half of the problem, and the alternative is trusting a
   * holiday calendar to be right about the past.
   *
   * ── THE CIRCUIT BREAKER IS NOT OPTIONAL ────────────────────────────────
   * Observed 2026-08-19: after roughly 90 sessions fetched back-to-back, NSE
   * stopped answering this client entirely and every subsequent request hit its
   * 30-second timeout. Without a breaker the loop would have spent the next two
   * hours timing out once per remaining date, hammering an endpoint that had
   * already made its position clear.
   *
   * A run of consecutive FETCH failures means the upstream has stopped talking
   * to us, not that these particular dates are bad — so the correct response is
   * to stop and report how far we got, leaving the rest for a later, slower
   * run. `no-session` (a holiday 404) is explicitly NOT a failure and does not
   * count toward the breaker: a week containing two holidays is normal.
   */
  async backfill(
    endDate: Date,
    days: number,
    pauseMs = 900,
    maxConsecutiveFailures = 5,
  ): Promise<{ sessions: number; candles: number; stoppedEarly: boolean; lastDate: string | null }> {
    let sessions = 0;
    let candles = 0;
    let consecutiveFailures = 0;
    let lastDate: string | null = null;

    for (let i = 0; i < days; i += 1) {
      const day = new Date(endDate.getTime() - i * 86_400_000);
      const dow = day.getUTCDay();
      if (dow === 0 || dow === 6) continue; // Sunday / Saturday

      const date = isoDay(day);
      lastDate = date;
      try {
        const result = await this.syncSession(date);
        if (result.status === 'failed') {
          consecutiveFailures += 1;
        } else {
          consecutiveFailures = 0;
          if (result.status === 'ok') {
            sessions += 1;
            candles += result.candlesWritten;
            this.logger.log(
              `${date}: ${result.candlesWritten} bars (${result.rows} rows, ${result.unmatchedSymbols} unmatched)`,
            );
          }
        }
      } catch (err) {
        // A parse error is about this file, not about the connection, so it
        // does not trip the breaker — one malformed session must not abandon
        // the rest of the year.
        this.logger.warn(`${date}: ${(err as Error).message}`);
      }

      if (consecutiveFailures >= maxConsecutiveFailures) {
        this.logger.error(
          `Stopping backfill at ${date}: ${consecutiveFailures} consecutive fetch failures — ` +
            `the upstream has stopped answering. Resume from this date later, more slowly.`,
        );
        return { sessions, candles, stoppedEarly: true, lastDate: date };
      }

      await new Promise((r) => setTimeout(r, pauseMs));
    }

    return { sessions, candles, stoppedEarly: false, lastDate };
  }
}
