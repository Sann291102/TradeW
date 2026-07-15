import { Injectable } from '@nestjs/common';
import { Signal, TradeSummary } from '../domain';

/**
 * Emotion Intelligence agent (deterministic half).
 * Reads ONLY the trade summaries services/api passes in — Sentinel never
 * queries trading tables itself. Output is reflective, never judgmental:
 * signals feed Reflection Cards ("Reflect with AI"), not verdicts.
 */
@Injectable()
export class EmotionIntelligenceService {
  signals(trades: TradeSummary[]): Signal[] {
    const out: Signal[] = [];
    const sig = (name: string, triggered: boolean, weight: number, evidence: string[], data?: Record<string, unknown>) =>
      out.push({ name, agent: 'emotion', triggered, weight, evidence, data });

    if (trades.length === 0) return out;
    const sorted = [...trades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // revenge trading: a new entry within 15 minutes of a losing exit
    let revengeCount = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const prevLoss = (prev.realizedPnl ?? 0) < 0;
      const gapMin = (new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime()) / 60_000;
      if (prevLoss && gapMin >= 0 && gapMin <= 15) revengeCount++;
    }
    sig(
      'revenge_trading',
      revengeCount >= 2,
      0.35,
      [`${revengeCount} entr${revengeCount === 1 ? 'y' : 'ies'} within 15 minutes of a losing exit in this session`],
      { revengeCount },
    );

    // overtrading: session trade count well above a modest baseline
    const today = new Date().toISOString().slice(0, 10);
    const todayTrades = sorted.filter((t) => t.createdAt.slice(0, 10) === today);
    sig(
      'overtrading',
      todayTrades.length >= 15,
      0.25,
      [`${todayTrades.length} trades today`],
      { todayCount: todayTrades.length },
    );

    // position sizing drift: last trade size vs the user's own average
    const avgQty = sorted.reduce((s, t) => s + t.quantity, 0) / sorted.length;
    const lastTrade = sorted[sorted.length - 1];
    const sizeRatio = avgQty > 0 ? lastTrade.quantity / avgQty : 1;
    sig(
      'position_sizing_drift',
      sizeRatio >= 2,
      0.3,
      [`Position sizing on the last trade was ${sizeRatio.toFixed(1)}x your session average`],
      { sizeRatio },
    );

    // rapid-fire entries: median gap between consecutive trades under 3 minutes
    if (sorted.length >= 4) {
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        gaps.push((new Date(sorted[i].createdAt).getTime() - new Date(sorted[i - 1].createdAt).getTime()) / 60_000);
      }
      gaps.sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)];
      sig('impatient_pacing', median < 3, 0.2, [`Median gap between trades is ${median.toFixed(1)} minutes`], {
        medianGapMin: median,
      });
    }

    // loss streak pressure: 3+ consecutive losing trades
    let streak = 0;
    let maxStreak = 0;
    for (const t of sorted) {
      if ((t.realizedPnl ?? 0) < 0) {
        streak++;
        maxStreak = Math.max(maxStreak, streak);
      } else if (t.realizedPnl !== undefined) {
        streak = 0;
      }
    }
    sig('loss_streak', maxStreak >= 3, 0.3, [`Longest losing streak this session: ${maxStreak} trades`], { maxStreak });

    return out;
  }
}
