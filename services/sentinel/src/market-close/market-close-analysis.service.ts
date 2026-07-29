/**
 * Module 11 — Market Close Analysis & EOD Review.
 *
 * After the close, Sentinel reviews the session it just narrated. Every
 * figure here comes from something the system actually recorded during the
 * day — the Market Timeline (Module 8), the state machine's transition
 * history (Module 9), and the `pattern_occurrence` memories the Pattern
 * Recognition Engine wrote and the Outcome Learning pass later tagged. There
 * is no separate end-of-day pipeline re-deriving the day from scratch.
 *
 * Where the data genuinely isn't there — the trader's fills, for a client
 * that never sent them — the review says so rather than guessing.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  MarketProfile,
  MarketStateSnapshot,
  TimelineEntry,
  TradeSummary,
} from '../domain';
import { MarketIntelligenceService } from '../intelligence/market-intelligence.service';
import { MarketStateMachineService } from '../state-machine/state-machine.service';
import { MarketTimelineEngine } from '../timeline/timeline.engine';
import { istDateKey } from '../market-clock';
import { PrismaService } from '../prisma.service';

export interface SetupReview {
  strategyName: string;
  detectedAt: string;
  confirmed: boolean;
  /** what the Outcome Learning pass observed afterwards, when it has run */
  outcome: 'continued_up' | 'continued_down' | 'unclear' | 'pending';
  movePct: number | null;
  /** true when Sentinel confirmed the setup and the trader placed nothing */
  actedOn: boolean | null;
}

export interface EodReview {
  sessionDate: string;
  symbol: string;
  marketProfile: MarketProfile | null;
  priceRange: { open: number; high: number; low: number; close: number } | null;
  changePct: number | null;
  totalVolume: number;
  setups: SetupReview[];
  successful: SetupReview[];
  failed: SetupReview[];
  missed: SetupReview[];
  newsImpact: string;
  stateJourney: string[];
  guidanceSurfaced: TimelineEntry[];
  keyLearningTakeaway: string;
  tomorrowFocus: string[];
  /** anything the review could not measure, stated rather than hidden */
  limitations: string[];
}

interface PatternMemoryMeta {
  pattern?: string;
  symbol?: string;
  outcome?: string | null;
  outcomeMovePct?: number;
  detectedAt?: string;
}

@Injectable()
export class MarketCloseAnalysisService {
  private readonly logger = new Logger(MarketCloseAnalysisService.name);

  constructor(
    private readonly market: MarketIntelligenceService,
    private readonly timeline: MarketTimelineEngine,
    private readonly stateMachine: MarketStateMachineService,
    private readonly prisma: PrismaService,
  ) {}

  async review(input: {
    userId: string;
    symbol: string;
    trades?: TradeSummary[];
    at?: Date;
  }): Promise<EodReview> {
    const at = input.at ?? new Date();
    const symbol = input.symbol;
    const sessionDate = istDateKey(at);
    const key = MarketStateMachineService.sessionKey(input.userId, symbol, at);
    const limitations: string[] = [];

    const snapshot = await this.market.snapshot(symbol);
    const entries = this.timeline.entries(key);
    const state = this.stateMachine.peek(key, at);

    if (entries.length === 0) {
      limitations.push('No timeline was recorded for this session — Sentinel was not observing this symbol today.');
    }

    const outcomes = await this.patternOutcomes(symbol, at);
    if (outcomes === null) {
      limitations.push('Pattern outcome memory is unavailable, so confirmed setups could not be scored.');
    }

    const setups = this.reviewSetups(entries, outcomes ?? [], input.trades);
    if (!input.trades) {
      limitations.push('No trade history was supplied for this session, so "missed" setups cannot be distinguished from ones the trader deliberately skipped.');
    }

    const sessionCandles = snapshot.sessionCandles;
    const priceRange = sessionCandles.length
      ? {
          open: sessionCandles[0].open,
          high: Math.max(...sessionCandles.map((c) => c.high)),
          low: Math.min(...sessionCandles.map((c) => c.low)),
          close: sessionCandles[sessionCandles.length - 1].close,
        }
      : null;

    const successful = setups.filter((s) => isSuccess(s));
    const failed = setups.filter((s) => isFailure(s));
    const missed = setups.filter((s) => s.confirmed && s.actedOn === false);

    return {
      sessionDate,
      symbol,
      marketProfile: snapshot.marketProfile,
      priceRange,
      changePct: snapshot.trendAnalysis?.sessionChangePct ?? null,
      totalVolume: sessionCandles.reduce((sum, c) => sum + c.volume, 0),
      setups,
      successful,
      failed,
      missed,
      newsImpact: this.newsImpact(entries),
      stateJourney: [
        ...state.history.map((t) => `${t.at.slice(11, 16)} ${t.from} → ${t.to}: ${t.trigger}`),
      ],
      guidanceSurfaced: entries.filter((e) => e.level === 'guidance'),
      keyLearningTakeaway: this.takeaway(snapshot.marketProfile, successful, failed, missed),
      tomorrowFocus: this.tomorrowFocus(snapshot.marketProfile, successful, failed, limitations),
      limitations,
    };
  }

  /**
   * The day's recorded pattern occurrences with whatever outcome the
   * continuous learning pass has tagged onto them. Returns null when the
   * Brain store cannot be read, so the caller can say so instead of
   * reporting an empty day.
   */
  private async patternOutcomes(symbol: string, at: Date): Promise<PatternMemoryMeta[] | null> {
    try {
      const dayStart = new Date(at);
      dayStart.setUTCHours(0, 0, 0, 0);
      const rows = await this.prisma.memoryRecord.findMany({
        where: { tags: { has: 'pattern_occurrence' }, namespace: 'sentinel', createdAt: { gte: dayStart } },
        orderBy: { createdAt: 'asc' },
        take: 500,
      });
      return rows
        .map((r) => r.metadata as unknown as PatternMemoryMeta | null)
        .filter((m): m is PatternMemoryMeta => !!m && m.symbol === symbol);
    } catch (err) {
      this.logger.warn(`could not read pattern outcomes for ${symbol}: ${err}`);
      return null;
    }
  }

  /** Pair the timeline's confirmed setups with their recorded outcomes. */
  private reviewSetups(
    entries: TimelineEntry[],
    outcomes: PatternMemoryMeta[],
    trades: TradeSummary[] | undefined,
  ): SetupReview[] {
    const setupEntries = entries.filter((e) => e.level === 'setup');
    return setupEntries.map((entry) => {
      const strategyName = entry.event.split(' — ')[0].split(' forming')[0].split(' confirmed')[0];
      const confirmed = entry.event.includes('confirmed —') || entry.event.includes('confirmed.');
      const detectedAt = entry.at;

      const match = outcomes.find(
        (o) => typeof o.pattern === 'string' && strategyName.toLowerCase().includes(o.pattern.replace(/_/g, ' ').split(' ')[0]),
      );
      const outcome = (match?.outcome ?? null) as SetupReview['outcome'] | null;

      return {
        strategyName,
        detectedAt,
        confirmed,
        outcome: outcome ?? 'pending',
        movePct: typeof match?.outcomeMovePct === 'number' ? match.outcomeMovePct : null,
        actedOn: trades ? tradedWithin(trades, detectedAt) : null,
      };
    });
  }

  private newsImpact(entries: TimelineEntry[]): string {
    const newsEntries = entries.filter((e) => e.event.toLowerCase().includes('news'));
    if (newsEntries.length === 0) return 'No news events were recorded against this session.';
    return newsEntries.map((e) => `${e.time} — ${e.event}`).join(' ');
  }

  private takeaway(
    profile: MarketProfile | null,
    successful: SetupReview[],
    failed: SetupReview[],
    missed: SetupReview[],
  ): string {
    const parts: string[] = [];

    if (profile) {
      parts.push(`Today was a ${profile.type}: ${profile.description.toLowerCase()}.`);
    }
    if (successful.length > 0) {
      parts.push(
        `${successful[0].strategyName} resolved in the direction its rules described${successful.length > 1 ? `, as did ${successful.length - 1} other setup(s)` : ''}.`,
      );
    }
    if (failed.length > 0) {
      parts.push(
        `${failed[0].strategyName} confirmed but did not follow through — the invalidation conditions are the part worth re-reading.`,
      );
    }
    if (missed.length > 0) {
      parts.push(`${missed.length} confirmed setup(s) passed without a corresponding trade.`);
    }
    if (successful.length === 0 && failed.length === 0) {
      parts.push('No setup reached full confirmation today. A session with nothing to act on is a normal outcome, not a missed one.');
    }
    return parts.join(' ');
  }

  private tomorrowFocus(
    profile: MarketProfile | null,
    successful: SetupReview[],
    failed: SetupReview[],
    limitations: string[],
  ): string[] {
    const focus: string[] = [];
    if (profile) focus.push(`Check whether the ${profile.type} character carries into the next session`);
    if (failed.length > 0) {
      focus.push(`Re-read the invalidation rules for ${[...new Set(failed.map((f) => f.strategyName))].join(', ')}`);
    }
    if (successful.length > 1) focus.push('Note what the setups that worked had in common');
    focus.push('Review pre-market levels and the prior session range before the open');
    if (limitations.length > 0) focus.push('Supply trade history to Sentinel so setup follow-through can be reviewed against your actual fills');
    return focus.slice(0, 5);
  }

  /** Plain-text rendering for the EOD panel and the /explain body. */
  format(review: EodReview): string {
    const lines: string[] = [
      `Sentinel end-of-day review — ${review.symbol}, ${review.sessionDate}`,
      '',
      `Profile: ${review.marketProfile?.type ?? 'not classified'}`,
    ];
    if (review.priceRange) {
      lines.push(
        `Range: ${review.priceRange.low.toFixed(1)} – ${review.priceRange.high.toFixed(1)}, close ${review.priceRange.close.toFixed(1)}` +
          (review.changePct !== null ? ` (${review.changePct >= 0 ? '+' : ''}${review.changePct.toFixed(2)}%)` : ''),
      );
    }
    lines.push(`Volume: ${review.totalVolume.toLocaleString()}`);
    lines.push('');
    lines.push(`Setups detected: ${review.setups.length} — ${review.successful.length} followed through, ${review.failed.length} did not, ${review.missed.length} passed without a trade`);
    for (const s of review.setups) {
      lines.push(
        `  • ${s.strategyName} (${s.confirmed ? 'confirmed' : 'forming'}) — outcome ${s.outcome.replace(/_/g, ' ')}` +
          (s.movePct !== null ? ` (${s.movePct >= 0 ? '+' : ''}${s.movePct.toFixed(2)}%)` : ''),
      );
    }
    if (review.stateJourney.length > 0) {
      lines.push('', 'State journey:', ...review.stateJourney.map((s) => `  ${s}`));
    }
    lines.push('', `News: ${review.newsImpact}`);
    lines.push('', `Takeaway: ${review.keyLearningTakeaway}`);
    if (review.tomorrowFocus.length > 0) {
      lines.push('', 'Focus for the next session:', ...review.tomorrowFocus.map((f) => `  • ${f}`));
    }
    if (review.limitations.length > 0) {
      lines.push('', 'Not measured:', ...review.limitations.map((l) => `  • ${l}`));
    }
    return lines.join('\n');
  }
}

function isSuccess(s: SetupReview): boolean {
  return s.confirmed && (s.outcome === 'continued_up' || s.outcome === 'continued_down');
}

function isFailure(s: SetupReview): boolean {
  return s.confirmed && s.outcome === 'unclear';
}

/** Did the trader place anything within 30 minutes of the setup confirming? */
function tradedWithin(trades: TradeSummary[], detectedAt: string): boolean {
  const t0 = new Date(detectedAt).getTime();
  return trades.some((t) => {
    const dt = new Date(t.createdAt).getTime() - t0;
    return dt >= 0 && dt <= 30 * 60_000;
  });
}
