import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { istDateKey } from '../discipline/market-calendar';

/**
 * Inbound ingress for the Python Sentinel service (services/sentinel-py).
 *
 * This is the ONE direction services/api does not already have: the existing
 * `SentinelApiService` calls *out* to Sentinel on the request path, but the
 * watch engine runs on its own sweep loop with no request to answer, so it
 * has to be able to push.
 *
 * Excluded from the public reference: this is a service-to-service route, not
 * a product API, and it authenticates with a shared token rather than a user
 * JWT. It writes a row for the userId in the payload, so the token is the
 * only thing standing between a caller and writing to any user's drawer —
 * hence the constant-time compare and the fail-closed check on a weak value.
 */

interface NotifyBody {
  userId?: unknown;
  category?: unknown;
  title?: unknown;
  body?: unknown;
  metadata?: unknown;
}

/**
 * Minimum length before the token is considered configured at all. Matches
 * the fail-closed posture of sentinel's own ServiceTokenGuard: an unset or
 * placeholder secret must deny everything rather than accept everything.
 */
const MIN_TOKEN_LENGTH = 24;

@ApiExcludeController()
@Controller('internal/sentinel-py')
export class SentinelPyController {
  private readonly logger = new Logger(SentinelPyController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Post('notify')
  async notify(@Headers('x-service-token') token: string | undefined, @Body() body: NotifyBody) {
    this.assertAuthorized(token);

    const userId = typeof body.userId === 'string' ? body.userId : '';
    const title = typeof body.title === 'string' ? body.title : '';
    const text = typeof body.body === 'string' ? body.body : '';
    if (!userId || !title || !text) {
      throw new BadRequestException('userId, title and body are required');
    }

    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {};
    const dedupeKey = typeof metadata.dedupeKey === 'string' ? metadata.dedupeKey : '';
    const tradingDate = typeof metadata.tradingDate === 'string' ? metadata.tradingDate : istDateKey();

    // Durable dedupe on the same terms as SentinelEventDispatcher: one row per
    // key per IST trading day, so a sweep that re-evaluates the same state
    // after a restart does not re-notify someone about something they read.
    if (dedupeKey && (await this.alreadySent(userId, dedupeKey, tradingDate))) {
      return { written: 0, deduped: true };
    }

    await this.prisma.notification.create({
      data: {
        userId,
        // The Python service is observation-only, same as the TS one; its
        // alerts belong in the existing 'sentinel' category rather than a new
        // enum member that would need a migration.
        category: 'sentinel' as const,
        title,
        body: text,
        // Named explicitly rather than spread, matching
        // SentinelEventDispatcher.toNotification: the set of things that can
        // reach the database is exactly the set written here, whatever else
        // sentinel-py starts sending.
        metadata: {
          source: 'sentinel-py',
          dedupeKey,
          tradingDate,
          watchSessionId: metadata.watchSessionId ?? null,
          strategyId: metadata.strategyId ?? null,
          symbol: metadata.symbol ?? null,
          strike: metadata.strike ?? null,
          optionType: metadata.optionType ?? null,
          state: metadata.state ?? null,
          previousState: metadata.previousState ?? null,
          tier: metadata.tier ?? null,
          reason: metadata.reason ?? null,
        },
      },
    });

    return { written: 1, deduped: false };
  }

  private assertAuthorized(token: string | undefined): void {
    const expected = process.env.SENTINEL_PY_SERVICE_TOKEN ?? '';
    if (expected.length < MIN_TOKEN_LENGTH) {
      this.logger.warn('SENTINEL_PY_SERVICE_TOKEN is unset or too short — denying sentinel-py ingress');
      throw new UnauthorizedException('Invalid service token');
    }
    const supplied = token ?? '';
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid service token');
    }
  }

  private async alreadySent(userId: string, dedupeKey: string, tradingDate: string): Promise<boolean> {
    const dayStart = new Date(`${tradingDate}T00:00:00+05:30`);
    const rows = await this.prisma.notification.findMany({
      where: { userId, category: 'sentinel', createdAt: { gte: dayStart } },
      select: { metadata: true },
    });
    return rows.some((row) => {
      const meta = row.metadata as { dedupeKey?: unknown } | null;
      return !!meta && meta.dedupeKey === dedupeKey;
    });
  }
}
