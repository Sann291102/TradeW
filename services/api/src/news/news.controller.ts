import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { NewsService } from './news.service';

/**
 * Market news. Read-only, authenticated like every other market surface, and
 * not entitlement-gated — headlines are base context, not premium analysis.
 */
@UseGuards(AuthGuard)
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
