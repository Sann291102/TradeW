import { Controller, Get } from '@nestjs/common';
import { FeedManagerService } from './ingestion/feed-manager.service';

/**
 * Operator surface only.
 *
 * Deliberately not a market-data API: `apps/*` never call this service, and
 * quotes are served by `services/api` reading persisted rows (ARCHITECTURE.md
 * §1). Exposing reads here would create a second ingress for the same data.
 */
@Controller()
export class HealthController {
  constructor(private readonly feed: FeedManagerService) {}

  @Get('health')
  health() {
    const detail = this.feed.health();
    // Degraded rather than unhealthy when the feed is down: the service is
    // still up and the API still serves the last persisted prices.
    const status = !detail.enabled ? 'disabled' : detail.feedStatus === 'connected' ? 'ok' : 'degraded';
    return { status, service: 'market-data', ...detail };
  }
}
