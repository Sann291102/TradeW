import { Controller, Get, Query } from '@nestjs/common';
import { NewsService } from './news.service';

/**
 * PUBLIC — no AuthGuard.
 *
 * This is read-only public market data: no user scoping, no account state,
 * nothing that varies by who is asking. It was auth-gated while the Dhan feed
 * (Indian quotes, charts, option chain) was already fully public through the
 * bridge, so a signed-out visitor saw live NIFTY prices but "Missing bearer
 * token" on crypto and news. That was an inconsistency, not a security
 * boundary — anyone can read these numbers from Binance, the newswires or the
 * vendor directly.
 *
 * Everything user-scoped (orders, positions, wallet, discipline) stays behind
 * AuthGuard. Vendor quota is protected by the server-side cache, not by auth:
 * upstream cost is a function of time, not of how many callers there are.
 */
@Controller('news')
export class NewsController {
  constructor(private readonly news: NewsService) {}

  /** GET /news[?limit=40] — real headlines, newest first, across all wires. */
  @Get()
  headlines(@Query('limit') limit?: string) {
    const n = Number(limit);
    return this.news.headlines(Number.isFinite(n) && n > 0 ? Math.min(n, 60) : 40);
  }
}
