import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * services/api side of SentinelIntelligence — the ONLY caller of the internal
 * `/intelligence/*` routes (single public ingress, ARCHITECTURE.md §1).
 *
 * Separate from `SentinelApiService` on purpose: that service owns the
 * orchestrator's `/observe` contract, which `apps/web`'s Sentinel workspace
 * depends on. Keeping the new surface in its own service means the existing
 * one is not touched.
 *
 * Same data boundary as the orchestrator path: SentinelIntelligence never
 * queries trading tables. This service reads the user's own recent trades and
 * account summary here — tables `services/api` owns — and passes them along
 * with each call.
 */
@Injectable()
export class SentinelIntelligenceApiService {
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

  /** Run one reasoning pass and return the full auditable run. */
  async reason(userId: string, body: ReasonBody) {
    return this.post('/intelligence/reason', await this.withUserContext(userId, body));
  }

  /** The three-panel visual strategy workspace payload. */
  async workspace(userId: string, body: ReasonBody) {
    return this.post('/intelligence/workspace', await this.withUserContext(userId, body));
  }

  status() {
    return this.get('/intelligence/status');
  }

  listRules() {
    return this.get('/intelligence/rules');
  }

  learnRule(spec: unknown) {
    return this.post('/intelligence/rules', spec);
  }

  retireRule(id: string) {
    return this.request('DELETE', `/intelligence/rules/${encodeURIComponent(id)}`);
  }

  reindex(force = false) {
    return this.post(`/intelligence/reindex?force=${force ? 'true' : 'false'}`, {});
  }

  /**
   * Attach the caller's own trading context.
   *
   * The Emotion and Risk agents read real behaviour, and the alternative to
   * supplying it is an agent that abstains on every request. Trades are read
   * here rather than in Sentinel because `services/api` owns those tables.
   */
  private async withUserContext(userId: string, body: ReasonBody) {
    const since = new Date(Date.now() - 24 * 3_600_000);

    const [trades, wallet] = await Promise.all([
      this.prisma.trade
        .findMany({
          where: { userId, executedAt: { gte: since } },
          include: { instrument: { select: { symbol: true } } },
          orderBy: { executedAt: 'desc' },
          take: 100,
        })
        .catch(() => []),
      this.prisma.paperWallet.findUnique({ where: { userId } }).catch(() => null),
    ]);

    return {
      ...body,
      userId,
      recentTrades: trades.map((t) => ({
        id: t.id,
        symbol: t.instrument.symbol,
        side: t.side,
        quantity: t.quantity,
        fillPrice: Number(t.fillPrice),
        createdAt: t.executedAt.toISOString(),
      })),
      // Omitted rather than zeroed when there is no wallet: a fabricated
      // "0% utilised" reads as a safe account instead of an unknown one, and
      // the Risk agent reports the factor as unmeasured when it is absent.
      account: wallet
        ? {
            marginUsed: Number(wallet.marginUsed),
            marginAvailable: Number(wallet.cashBalance),
            totalCapital: Number(wallet.startingBalance),
          }
        : undefined,
    };
  }

  private async get(path: string) {
    return this.request('GET', path);
  }

  private async post(path: string, body: unknown) {
    return this.request('POST', path, body);
  }

  private async request(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).catch((err) => {
      throw new BadGatewayException(`Sentinel service unreachable: ${err.message}`);
    });

    if (res.ok) return res.json();

    // Pass the service's own message through rather than flattening every
    // failure into a status code. A 400 here is a spec-validation issue list
    // the author needs to see field by field, and a 503 means Sentinel has no
    // market data — both are actionable, and a generic error is not.
    const detail = (await res.json().catch(() => null)) as
      | { message?: string | { message?: string; issues?: unknown[] } }
      | null;

    if (res.status === 400) {
      throw new BadRequestException(detail?.message ?? 'SentinelIntelligence rejected the request.');
    }
    if (res.status === 503) {
      const message = typeof detail?.message === 'string' ? detail.message : undefined;
      throw new ServiceUnavailableException(message || 'SentinelIntelligence has no market data available.');
    }
    throw new BadGatewayException(`Sentinel service error: ${res.status}`);
  }
}

export interface ReasonBody {
  query?: string;
  symbol?: string;
  strike?: number;
  right?: 'CE' | 'PE';
  expiry?: string;
  timeframe?: string;
  strategyIds?: string[];
  indicators?: string[];
  style?: string;
  riskProfile?: string;
  confidenceThreshold?: number;
  requiredCorroboration?: number;
}
