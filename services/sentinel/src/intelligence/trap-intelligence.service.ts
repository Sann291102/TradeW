import { Injectable } from '@nestjs/common';
import { Signal, TradeSummary } from '../domain';
import { averageVolume } from './indicators';
import { MarketSnapshot } from './market-intelligence.service';

/**
 * Trap & Safety Intelligence agent (deterministic half).
 * Composite by design (SENTINEL.md §3): each detector is a *signal*, never a
 * standalone verdict — the orchestrator only surfaces a warning when enough
 * signals corroborate (e.g. breakout + low volume + falling OI together).
 */
@Injectable()
export class TrapIntelligenceService {
  signals(s: MarketSnapshot, trades: TradeSummary[] = []): Signal[] {
    const out: Signal[] = [];
    const sig = (name: string, triggered: boolean, weight: number, evidence: string[], data?: Record<string, unknown>) =>
      out.push({ name, agent: 'trap-safety', triggered, weight, evidence, data });

    const candles = s.candles;
    const last = candles[candles.length - 1];
    if (!last) return out;
    const avgVol = averageVolume(candles);

    // breakout / breakdown state vs recent swing levels
    const brokeResistance = s.resistance !== null && last.close > s.resistance;
    const brokeSupport = s.support !== null && last.close < s.support;

    // low-volume breakout — the canonical composite example
    sig(
      'low_volume_breakout',
      brokeResistance && last.volume < avgVol,
      0.4,
      [
        ...(s.resistance !== null ? [`Price ${last.close.toFixed(1)} crossed resistance ${s.resistance.toFixed(1)}`] : []),
        `Breakout volume is ${avgVol > 0 ? ((last.volume / avgVol) * 100).toFixed(0) : '?'}% of the 20-bar average`,
        ...(s.oiTrend === 'falling' ? ['Open interest is declining'] : []),
      ],
      { brokeResistance, volumeVsAvg: avgVol > 0 ? last.volume / avgVol : null, oiTrend: s.oiTrend },
    );

    // bull trap: recent breakout above resistance reversed back below within 3 candles
    let bullTrap = false;
    if (s.resistance !== null && candles.length >= 4) {
      const recent = candles.slice(-4);
      const crossed = recent.slice(0, 3).some((c) => c.close > s.resistance!);
      bullTrap = crossed && last.close < s.resistance;
    }
    sig('bull_trap', bullTrap, 0.45, ['A move above resistance reversed back below it within a few candles'], {
      resistance: s.resistance,
    });

    // bear trap: sharp dip below support reclaimed within 2 candles (mockup's example)
    let bearTrap = false;
    if (s.support !== null && candles.length >= 3) {
      const recent = candles.slice(-3);
      const dipped = recent.slice(0, 2).some((c) => c.low < s.support!);
      bearTrap = dipped && last.close > s.support;
    }
    sig('bear_trap', bearTrap, 0.45, ['A sharp dip below support was reclaimed within 2 candles'], {
      support: s.support,
    });

    // liquidity sweep / stop hunt: long wick through a level with no follow-through
    let sweep = false;
    const wickEvidence: string[] = [];
    if (s.support !== null) {
      const range = last.high - last.low;
      const lowerWick = Math.min(last.open, last.close) - last.low;
      if (range > 0 && last.low < s.support && last.close > s.support && lowerWick / range > 0.6) {
        sweep = true;
        wickEvidence.push(
          `A wick pierced ${s.support.toFixed(1)} (a likely stop cluster) and closed back above it with ${((lowerWick / range) * 100).toFixed(0)}% of the bar as lower wick`,
        );
      }
    }
    sig('liquidity_sweep', sweep, 0.35, wickEvidence.length ? wickEvidence : ['No sweep pattern in the latest bars']);

    // expiry-day options trap: symbol looks like a near-expiry option
    const expiryLike = /\d{2}[A-Z]{3}.*(CE|PE)$/.test(s.symbol);
    sig('expiry_day_conditions', expiryLike && (s.vix ?? 0) > 15, 0.25, [
      expiryLike ? 'Instrument appears to be an option near expiry; pin/whipsaw risk rises into expiry' : 'Not an expiry-sensitive instrument',
    ]);

    // high-risk regime: index-level volatility elevated regardless of symbol
    sig('high_risk_market_conditions', (s.vix ?? 0) > 20, 0.3, [`India VIX at ${s.vix?.toFixed(1) ?? 'n/a'}`]);

    // FOMO entry: user's latest BUY came after most of the recent move already happened
    const lastBuy = [...trades].reverse().find((t) => t.side === 'BUY' && t.symbol === s.symbol);
    if (lastBuy && candles.length >= 12) {
      const window = candles.slice(-12);
      const moveStart = window[0].close;
      // Units: movePct is the signed size of the recent 12-bar move, in *percent*
      // (e.g. 0.674 == +0.67%). entryLateness is a *fraction in [0, 1]*: how far
      // through that move the BUY filled — 0 = entered at the move's start,
      // 1 = entered at the current price (maximally late). A fill that lands
      // outside the move's price band (e.g. one predating this window, so below
      // moveStart) falls outside [0, 1], so we clamp it. Without the clamp the
      // derived "captured" figure overshoots 100% or goes negative — the source
      // of the nonsensical "last 254%" / entryLateness -1.54 evidence.
      const movePct = ((last.close - moveStart) / moveStart) * 100;
      const moveRange = last.close - moveStart;
      const rawLateness = moveRange !== 0 ? (lastBuy.fillPrice - moveStart) / moveRange : 0;
      const entryLateness = Math.max(0, Math.min(1, rawLateness));
      // Complement of lateness: the slice of the move still ahead of the entry,
      // i.e. what the entry actually "captured". Bounded to 0–100% by the clamp.
      const capturedPct = (1 - entryLateness) * 100;
      sig(
        'fomo_entry',
        movePct > 0.8 && entryLateness > 0.75,
        0.3,
        [
          `Entry at ${lastBuy.fillPrice.toFixed(1)} came after ${(entryLateness * 100).toFixed(0)}% of a ${Math.abs(movePct).toFixed(1)}% move had already played out, capturing the final ${capturedPct.toFixed(0)}%`,
        ],
        { movePct, entryLateness, capturedPct },
      );
    }

    return out;
  }
}
