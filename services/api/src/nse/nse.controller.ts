import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { PUBLIC_PROXY_LIMIT } from '../common/throttling';
import { NseService } from './nse.service';

/**
 * NSE public market data — institutional flow, positioning, breadth.
 *
 * PUBLIC — no AuthGuard, for the same reason `NewsController` is public: this
 * is read-only exchange data with no user scoping and nothing that varies by
 * who is asking. Anyone can read these numbers from nseindia.com directly.
 *
 * Upstream quota is protected by the server-side cache rather than by auth —
 * and here that is load-bearing rather than incidental. NSE is a public
 * exchange with no SLA and no contract with us; the cache is what keeps this
 * platform making a handful of requests an hour instead of one per viewer.
 * Every route below reads through it.
 *
 * There is deliberately NO route that takes a URL, a path or a hostname. The
 * dataset catalogue is the boundary (`nse-datasets.ts`), and the reasoning for
 * that is in its header.
 */
@Throttle(PUBLIC_PROXY_LIMIT)
@ApiTags('NSE')
@Controller('nse')
export class NseController {
  constructor(private readonly nse: NseService) {}

  /**
   * GET /nse/datasets — what can be asked for.
   *
   * Exists so the assistant can discover the catalogue at runtime instead of
   * carrying its own copy of the list, which would drift the first time a
   * dataset is added.
   */
  @Get('datasets')
  datasets() {
    return this.nse.catalogue();
  }

  /** GET /nse/fii-dii — cash-market flow for the last completed session. */
  @Get('fii-dii')
  fiiDii() {
    return this.nse.fiiDiiFlow();
  }

  /** GET /nse/participant-oi — Client/DII/FII/Pro derivatives positioning. */
  @Get('participant-oi')
  participantOi() {
    return this.nse.participantOi();
  }

  /** GET /nse/breadth[?index=NIFTY 50] — advances/declines for one index. */
  @Get('breadth')
  breadth(@Query('index') index?: string) {
    // Trimmed and length-capped, then matched EXACTLY against the index rows
    // NSE returned. It never becomes part of a URL — see `NseService.breadth`.
    const name = (index ?? '').trim().slice(0, 60);
    return this.nse.breadth(name || 'NIFTY 50');
  }

  /** GET /nse/market-status — per-segment open/closed, from the exchange. */
  @Get('market-status')
  marketStatus() {
    return this.nse.marketStatus();
  }

  /** GET /nse/events[?limit=25] — upcoming corporate board meetings. */
  @Get('events')
  events(@Query('limit') limit?: string) {
    const n = Number(limit);
    return this.nse.eventCalendar(Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 25);
  }
}
