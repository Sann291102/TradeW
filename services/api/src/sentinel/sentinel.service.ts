import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
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

  async observe(
    userId: string,
    symbol?: string,
    context?: string,
    clientSupplied?: { clientTrades?: unknown[]; clientPositions?: unknown[] },
    focus?: { strategyMode?: 'auto' | 'manual'; selectedStrategyId?: string; confidenceThreshold?: number },
  ) {
    // Demo/paper-account bridge (see SentinelController.observe): a client
    // that supplies its own recent trades/positions (apps/terminal's paper
    // simulator) is trusted for THIS request only — never persisted, never
    // treated as this user's real trading history elsewhere in the system.
    const useClientData = Array.isArray(clientSupplied?.clientTrades) || Array.isArray(clientSupplied?.clientPositions);

    let recentTrades: unknown[];
    let positions: unknown[];
    if (useClientData) {
      recentTrades = Array.isArray(clientSupplied?.clientTrades) ? clientSupplied!.clientTrades!.slice(0, 100) : [];
      positions = Array.isArray(clientSupplied?.clientPositions) ? clientSupplied!.clientPositions! : [];
    } else {
      const since = new Date(Date.now() - 24 * 3_600_000);
      const [trades, dbPositions] = await Promise.all([
        this.prisma.trade.findMany({
          where: { userId, executedAt: { gte: since } },
          include: { instrument: { select: { symbol: true } } },
          orderBy: { executedAt: 'desc' },
          take: 100,
        }),
        this.prisma.position.findMany({
          where: { userId },
          include: { instrument: { select: { symbol: true } } },
        }),
      ]);
      recentTrades = trades.map((t) => ({
        id: t.id,
        symbol: t.instrument.symbol,
        side: t.side,
        quantity: t.quantity,
        fillPrice: Number(t.fillPrice),
        createdAt: t.executedAt.toISOString(),
      }));
      positions = dbPositions.map((p) => ({
        symbol: p.instrument.symbol,
        quantity: p.quantity,
        avgPrice: Number(p.avgPrice),
        realizedPnl: Number(p.realizedPnl),
      }));
    }

    // Sentinel's Risk Intelligence engine scores position risk from real
    // margin utilisation (Master Plan Module 6, factor 3). The paper wallet is
    // the account of record here; when it doesn't exist yet the field is
    // omitted and the engine reports the factor as unmeasured rather than
    // assuming a number.
    const account = await this.accountSummary(userId);

    const body = {
      userId,
      symbol,
      context,
      recentTrades,
      positions,
      account,
      // Phase 3 strategy focus — only forwarded when supplied so the default
      // (auto mode, service-default threshold) is untouched for existing callers.
      strategyMode: focus?.strategyMode,
      selectedStrategyId: focus?.selectedStrategyId,
      confidenceThreshold: focus?.confidenceThreshold,
    };

    const res = await fetch(`${this.baseUrl}/observe`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    }).catch((err) => {
      throw new BadGatewayException(`Sentinel service unreachable: ${err.message}`);
    });
    if (!res.ok) {
      // 503 from Sentinel means "no real market data for this symbol". Pass it
      // through with its own message rather than flattening every failure into
      // a bare status code — the workspace states the actual fault to the user.
      if (res.status === 503) {
        const detail = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new ServiceUnavailableException(detail?.message || 'Sentinel has no real market data available.');
      }
      throw new BadGatewayException(`Sentinel service error: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Margin/sizing context for Sentinel's Position Risk factor. Returns
   * undefined rather than zeros when there is no wallet — a fabricated
   * "0% utilised" would read as a low-risk account instead of an unknown one.
   */
  private async accountSummary(userId: string) {
    try {
      const wallet = await this.prisma.paperWallet.findUnique({ where: { userId } });
      if (!wallet) return undefined;
      return {
        marginUsed: Number(wallet.marginUsed),
        marginAvailable: Number(wallet.cashBalance),
        totalCapital: Number(wallet.startingBalance),
      };
    } catch {
      // Sentinel degrades this factor cleanly; never fail an observation over it.
      return undefined;
    }
  }

  /** Module 8 — the running session narrative for the active symbol. */
  async timeline(userId: string, symbol: string, since?: string) {
    const query = new URLSearchParams({ userId, symbol });
    if (since) query.set('since', since);
    return this.get(`/timeline?${query.toString()}`);
  }

  /** Module 11 — end-of-day review of the session Sentinel narrated. */
  async marketCloseReview(userId: string, symbol: string) {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const trades = await this.prisma.trade
      .findMany({
        where: { userId, executedAt: { gte: since } },
        include: { instrument: { select: { symbol: true } } },
        orderBy: { executedAt: 'desc' },
        take: 200,
      })
      .catch(() => []);

    return this.post('/market-close/review', {
      userId,
      symbol,
      recentTrades: trades.map((t) => ({
        id: t.id,
        symbol: t.instrument.symbol,
        side: t.side,
        quantity: t.quantity,
        fillPrice: Number(t.fillPrice),
        createdAt: t.executedAt.toISOString(),
      })),
    });
  }

  /** Module 2 — the trader's strategy handbook as Sentinel currently holds it. */
  async strategies() {
    return this.get('/strategies');
  }

  /** Phase 3 — the educational strategy registry that drives the UI selector. */
  async strategyRegistry(exposedOnly = true) {
    return this.get(`/learning/strategies?exposed=${exposedOnly ? 'true' : 'false'}`);
  }

  private async get(path: string) {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers }).catch((err) => {
      throw new BadGatewayException(`Sentinel service unreachable: ${err.message}`);
    });
    if (!res.ok) throw new BadGatewayException(`Sentinel service error: ${res.status}`);
    return res.json();
  }

  private async post(path: string, body: unknown) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    }).catch((err) => {
      throw new BadGatewayException(`Sentinel service unreachable: ${err.message}`);
    });
    if (!res.ok) throw new BadGatewayException(`Sentinel service error: ${res.status}`);
    return res.json();
  }

  /** Real Neural Brain explanation for a Sentinel observation/module — see services/sentinel's /explain. */
  async explain(userId: string, question: string, context?: string) {
    const res = await fetch(`${this.baseUrl}/explain`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ userId, question, context }),
    }).catch((err) => {
      throw new BadGatewayException(`Sentinel service unreachable: ${err.message}`);
    });
    if (!res.ok) throw new BadGatewayException(`Sentinel service error: ${res.status}`);
    return res.json();
  }

  /** Knowledge Center — query surface over the Brain's accumulated memory. */
  async brainSearch(userId: string, query: string, namespace?: string, limit?: number) {
    const res = await fetch(`${this.baseUrl}/brain/search`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ query, userId, namespace, limit }),
    }).catch((err) => {
      throw new BadGatewayException(`Sentinel service unreachable: ${err.message}`);
    });
    if (!res.ok) throw new BadGatewayException(`Sentinel service error: ${res.status}`);
    return res.json();
  }

  /** Strategy Intelligence Framework — cross-symbol historical base rate for a pattern. */
  async brainStrategy(pattern: string) {
    const res = await fetch(`${this.baseUrl}/brain/strategy?pattern=${encodeURIComponent(pattern)}`, {
      headers: this.headers,
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
      this.prisma.trade.count({ where: { userId, executedAt: { gte: dayStart } } }),
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
