import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  type AnalyticsOutcomeRow,
  type ExecutionAnalytics,
  computeExecutionAnalytics,
} from './execution-analytics';

/**
 * The read model behind the console's execution-performance view.
 *
 * Kept apart from `ExecutionQueryService` (headline counts) because this is the
 * analytical read — every closed outcome joined back to the decision that
 * produced it, projected into the performance breakdowns a calibration pass will
 * eventually consume. It writes nothing and changes nothing: measurement first,
 * self-modification never (not here, and not yet anywhere).
 *
 * All arithmetic lives in the pure `execution-analytics` module; this service is
 * only the fetch, the IST-hour derivation and the regime extraction from the
 * decision's stored market snapshot.
 */
@Injectable()
export class ExecutionAnalyticsService {
  private static readonly IST_HOUR = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hourCycle: 'h23',
  });

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Performance analytics over CLOSED outcomes in the window.
   *
   * Defaults to 30 days rather than 24 hours: a paper loop closes a handful of
   * positions a day, and win rate / expectancy / drawdown are noise over a
   * single session. The console can narrow it.
   */
  async analytics(hours = 24 * 30): Promise<ExecutionAnalytics & { hours: number; generatedAt: string }> {
    const since = new Date(Date.now() - hours * 3_600_000);
    const outcomes = await this.prisma.executionOutcome.findMany({
      where: { result: { in: ['WIN', 'LOSS', 'SCRATCH'] }, exitAt: { gte: since } },
      select: {
        realizedPnl: true,
        result: true,
        holdingSeconds: true,
        exitReason: true,
        entryAt: true,
        exitAt: true,
        intent: {
          select: {
            strategyId: true,
            strategyName: true,
            symbol: true,
            optionType: true,
            confidence: true,
            marketSnapshot: true,
            // The one candidate that was actually traded — its role is the
            // strike-selection dimension (ITM/ATM/OTM performance).
            candidates: { where: { selected: true }, select: { role: true }, take: 1 },
          },
        },
      },
      orderBy: { exitAt: 'asc' },
    });

    const rows: AnalyticsOutcomeRow[] = outcomes.map((o) => ({
      realizedPnl: Number(o.realizedPnl),
      result: o.result as AnalyticsOutcomeRow['result'],
      holdingSeconds: o.holdingSeconds,
      strategyId: o.intent.strategyId,
      strategyName: o.intent.strategyName,
      symbol: o.intent.symbol,
      side: o.intent.optionType,
      confidence: o.intent.confidence,
      strikeRole: (o.intent.candidates[0]?.role ?? null) as AnalyticsOutcomeRow['strikeRole'],
      regime: extractRegime(o.intent.marketSnapshot),
      exitReason: o.exitReason,
      entryHourIst: this.istHour(o.entryAt),
      exitAtMs: o.exitAt ? o.exitAt.getTime() : null,
    }));

    return { hours, generatedAt: new Date().toISOString(), ...computeExecutionAnalytics(rows) };
  }

  private istHour(at: Date | null): number | null {
    if (!at) return null;
    const h = Number(ExecutionAnalyticsService.IST_HOUR.format(at));
    return Number.isFinite(h) ? h : null;
  }
}

/**
 * The regime the decision was made in, from the stored market snapshot.
 *
 * The snapshot is `evaluation.marketSnapshot` — `marketProfile.type` is
 * Sentinel's classification of the session (trending / balanced / …). Falls back
 * to the market-state label, then to null: a row that recorded no regime is
 * SKIPPED from the regime breakdown rather than bucketed as a fictitious
 * "unknown" regime that would dilute the real ones.
 */
function extractRegime(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const snap = snapshot as Record<string, unknown>;
  const profile = snap.marketProfile;
  if (profile && typeof profile === 'object') {
    const type = (profile as Record<string, unknown>).type;
    if (typeof type === 'string' && type.trim()) return type;
  }
  const state = snap.marketState;
  if (typeof state === 'string' && state.trim()) return state;
  return null;
}
