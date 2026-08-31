import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiBody, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { EXPENSIVE_LIMIT } from '../common/throttling';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { MarketAnalysisApiService } from './market-analysis.service';

/**
 * DOCUMENTATION MODEL ONLY — same convention as `assistant.controller.ts`: the
 * handler keeps its inline `@Body()` type so the global ValidationPipe skips
 * it, and this class gives the generated reference a real schema.
 */
class AnalyseBody {
  @ApiProperty({ example: 'NIFTY', description: 'The instrument to measure.' })
  symbol!: string;

  @ApiProperty({
    required: false,
    example: '15m',
    description: 'Chart interval to measure on: 1m, 5m, 15m, 1H, 1D, 1W. Defaults to 15m.',
  })
  timeframe?: string;

  @ApiProperty({
    required: false,
    description: 'Also read the CE and PE legs at the money, on the same bars.',
  })
  includeContracts?: boolean;
}

/**
 * Canonical, observation-only market measurements.
 *
 * ── WHAT THIS ROUTE IS ─────────────────────────────────────────────────────
 *
 * The single place the assistant gets numbers about a market. Every value it
 * returns is lifted from the same `MarketSnapshot` that Sentinel's own
 * observation and the autonomous paper agents are computed from — one
 * composition, three consumers, so the assistant and the agent cannot describe
 * two different markets.
 *
 * ── WHY IT IS NOT BEHIND THE `sentinel` CAPABILITY ─────────────────────────
 *
 * Deliberate, and worth stating because the neighbouring Sentinel routes are.
 * What the `sentinel` entitlement protects is Sentinel's REASONING: the
 * synthesised message, the publication verdict, the side in focus, the strategy
 * advice. None of that is reachable here — the response type has no field to
 * carry it, and `MarketAnalysisApiService` re-checks the payload before it
 * leaves this service.
 *
 * What IS here is what the user's own chart already shows them: price, OHLC,
 * volume, indicator values, structure, option-chain aggregates. Gating those
 * would not protect anything; it would only mean the assistant refuses to read
 * out a number the screen is already displaying.
 *
 * ── NOT AN ORDER PATH, NOT ADVICE ──────────────────────────────────────────
 *
 * A read. `services/sentinel` has no OMS binding, this controller has no write
 * side, and the payload contains no entry, exit, target or recommendation.
 */
@ApiTags('market-analysis')
@Controller('market-analysis')
export class MarketAnalysisController {
  constructor(private readonly analysis: MarketAnalysisApiService) {}

  /**
   * Measure one symbol on one timeframe.
   *
   * Returns `{ ok: false, coverage, reason }` — not an error — when the symbol
   * has no canonical analysis path (crypto and spot FX are charted from other
   * venues entirely). That is an answer the assistant reads back verbatim, and
   * it is the mechanism that stops a Binance instrument being narrated with
   * NSE indicators.
   */
  @ApiBearerAuth(SECURITY.bearer)
  @ApiBody({ type: AnalyseBody })
  @ApiResponse({ status: 201, description: 'Measurements, or an explicit coverage refusal.' })
  @ApiResponse({ status: 503, description: 'No real market data for this symbol, or the engine is down.' })
  @Throttle(EXPENSIVE_LIMIT)
  @UseGuards(AuthGuard)
  @Post()
  async analyse(
    @Body() body: { symbol?: string; timeframe?: string; includeContracts?: boolean },
  ) {
    const symbol = typeof body?.symbol === 'string' ? body.symbol.trim().slice(0, 32) : '';
    const timeframe =
      typeof body?.timeframe === 'string' && body.timeframe.trim()
        ? body.timeframe.trim().slice(0, 12)
        : '15m';

    return this.analysis.analyse({
      symbol,
      timeframe,
      includeContracts: body?.includeContracts === true,
    });
  }
}
