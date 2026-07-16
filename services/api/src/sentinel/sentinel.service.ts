import { BadGatewayException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * services/api side of Sentinel — the ONLY caller of the internal Sentinel
 * service (single public ingress, ARCHITECTURE.md §1).
 *
 * Data boundary: Sentinel never queries trading tables. This service reads
 * the user's own recent trades/positions here (tables services/api owns) and
 * passes summaries along with each observe call.
 */
@Injectable()
export class SentinelApiService {
  constructor(private readonly prisma: PrismaService) {}

  private get baseUrl(): string {
    return (process.env.SENTINEL_SERVICE_URL ?? 'http://localhost:4010').replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-service-token': process.env.SENTINEL_SERVICE_TOKEN ?? '',
    };
  }

  async observe(userId: string, symbol?: string, context?: string) {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const [trades, positions] = await Promise.all([
      this.prisma.trade.findMany({
        where: { userId, createdAt: { gte: since } },
        include: { instrument: { select: { symbol: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.position.findMany({
        where: { userId },
        include: { instrument: { select: { symbol: true } } },
      }),
    ]);

    const body = {
      userId,
      symbol,
      context,
      recentTrades: trades.map((t) => ({
        id: t.id,
        symbol: t.instrument.symbol,
        side: t.side,
        quantity: t.quantity,
        fillPrice: Number(t.fillPrice),
        createdAt: t.createdAt.toISOString(),
      })),
      positions: positions.map((p) => ({
        symbol: p.instrument.symbol,
        quantity: p.quantity,
        avgPrice: Number(p.avgPrice),
        realizedPnl: Number(p.realizedPnl),
      })),
    };

    const res = await fetch(`${this.baseUrl}/observe`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    }).catch((err) => {
      throw new BadGatewayException(`Sentinel service unreachable: ${err.message}`);
    });
    if (!res.ok) throw new BadGatewayException(`Sentinel service error: ${res.status}`);
    return res.json();
  }

  async observations(userId: string, limit = 50) {
    const res = await fetch(`${this.baseUrl}/observations?userId=${encodeURIComponent(userId)}&limit=${limit}`, {
      headers: this.headers,
    }).catch((err) => {
      throw new BadGatewayException(`Sentinel service unreachable: ${err.message}`);
    });
    if (!res.ok) throw new BadGatewayException(`Sentinel service error: ${res.status}`);
    return res.json();
  }

  /** Session Summary panel: trades today + flagged events, computed from api-owned data + the audit trail. */
  async sessionSummary(userId: string) {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [tradesToday, positions] = await Promise.all([
      this.prisma.trade.count({ where: { userId, createdAt: { gte: dayStart } } }),
      this.prisma.position.findMany({ where: { userId }, select: { realizedPnl: true } }),
    ]);
    let flaggedEvents = 0;
    try {
      const feed = (await this.observations(userId, 200)) as { createdAt: string; surfaced: boolean }[];
      flaggedEvents = feed.filter((o) => o.surfaced && new Date(o.createdAt) >= dayStart).length;
    } catch {
      // sentinel down — summary still renders from api-owned data
    }
    return {
      tradesToday,
      flaggedEvents,
      realizedPnl: positions.reduce((s, p) => s + Number(p.realizedPnl), 0),
    };
  }

  // ------------------------------------------------------------ journal
  // JournalEntry is user-facing content owned by services/api.

  async listJournal(userId: string, limit = 50) {
    return this.prisma.journalEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  async addJournal(userId: string, input: { content: string; mood?: string; tags?: string[] }) {
    return this.prisma.journalEntry.create({
      data: { userId, content: input.content, mood: input.mood ?? null, tags: input.tags ?? [] },
    });
  }
}
