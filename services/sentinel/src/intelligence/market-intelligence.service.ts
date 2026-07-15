import { Inject, Injectable } from '@nestjs/common';
import { Candle, MarketDataProvider } from '@tradew/types';
import { Signal } from '../domain';
import {
  averageVolume,
  cpr,
  ema,
  macd,
  oiTrend,
  realizedVolatilityPct,
  rsi,
  swingLevels,
  vwap,
} from './indicators';

export const MARKET_DATA = 'MARKET_DATA_PROVIDER';

export interface MarketSnapshot {
  symbol: string;
  lastPrice: number;
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  vwap: number | null;
  macdHistogram: number | null;
  cpr: { pivot: number; bc: number; tc: number } | null;
  volumeVsAvg: number | null; // last volume / 20-period average
  oiTrend: 'rising' | 'falling' | 'flat' | 'unknown';
  realizedVolPct: number | null;
  vix: number | null;
  breadthRatio: number | null; // advances / declines
  support: number | null;
  resistance: number | null;
  candles: Candle[];
}

/**
 * Market & Technical Intelligence agent (deterministic half).
 * Computes structure/indicators and emits observation-only signals —
 * "Momentum is weakening", never "sell".
 */
@Injectable()
export class MarketIntelligenceService {
  constructor(@Inject(MARKET_DATA) private readonly marketData: MarketDataProvider) {}

  async snapshot(symbol: string): Promise<MarketSnapshot> {
    const to = new Date();
    const from = new Date(to.getTime() - 5 * 86_400_000);
    const candles = await this.marketData.getCandles(symbol, '15m', from, to);
    const closes = candles.map((c) => c.close);
    const last = candles[candles.length - 1];
    const ema20Series = ema(closes, 20);
    const ema50Series = ema(closes, 50);
    const breadth = await this.marketData.getMarketBreadth();
    const dayCandles = await this.marketData.getCandles(symbol, '1d', new Date(to.getTime() - 10 * 86_400_000), to);
    const priorDay = dayCandles[dayCandles.length - 2];
    const levels = swingLevels(candles);

    return {
      symbol,
      lastPrice: last?.close ?? 0,
      rsi14: rsi(closes),
      ema20: ema20Series[ema20Series.length - 1] ?? null,
      ema50: ema50Series[ema50Series.length - 1] ?? null,
      vwap: vwap(candles.slice(-26)),
      macdHistogram: macd(closes)?.histogram ?? null,
      cpr: priorDay ? cpr(priorDay) : null,
      volumeVsAvg: last ? last.volume / Math.max(1, averageVolume(candles)) : null,
      oiTrend: oiTrend(candles),
      realizedVolPct: realizedVolatilityPct(closes),
      vix: breadth.vix ?? null,
      breadthRatio: breadth.declines > 0 ? breadth.advances / breadth.declines : null,
      support: levels?.support ?? null,
      resistance: levels?.resistance ?? null,
      candles,
    };
  }

  signals(s: MarketSnapshot): Signal[] {
    const out: Signal[] = [];
    const sig = (name: string, triggered: boolean, weight: number, evidence: string[], data?: Record<string, unknown>) =>
      out.push({ name, agent: 'market-technical', triggered, weight, evidence, data });

    if (s.rsi14 !== null) {
      sig('overbought_rsi', s.rsi14 > 70, 0.2, [`RSI(14) is ${s.rsi14.toFixed(1)}${s.rsi14 > 70 ? ', above 70' : ''}`], { rsi: s.rsi14 });
      sig('oversold_rsi', s.rsi14 < 30, 0.2, [`RSI(14) is ${s.rsi14.toFixed(1)}${s.rsi14 < 30 ? ', below 30' : ''}`], { rsi: s.rsi14 });
    }
    if (s.macdHistogram !== null) {
      sig('weakening_momentum', s.macdHistogram < 0, 0.2, [`MACD histogram is ${s.macdHistogram.toFixed(2)} (below signal line)`]);
    }
    if (s.ema20 !== null && s.ema50 !== null) {
      const below = s.lastPrice < s.ema20 && s.ema20 < s.ema50;
      sig('below_key_emas', below, 0.15, [`Price ${s.lastPrice.toFixed(1)} vs EMA20 ${s.ema20.toFixed(1)} / EMA50 ${s.ema50.toFixed(1)}`]);
    }
    if (s.vix !== null) {
      sig('elevated_vix', s.vix > 18, 0.3, [`India VIX at ${s.vix.toFixed(1)}${s.vix > 18 ? ' — elevated' : ''}`], { vix: s.vix });
    }
    if (s.realizedVolPct !== null) {
      sig('elevated_realized_vol', s.realizedVolPct > 1.2, 0.2, [`Realized volatility ${s.realizedVolPct.toFixed(2)}% per bar over the last 20 bars`]);
    }
    if (s.volumeVsAvg !== null) {
      sig('below_average_participation', s.volumeVsAvg < 0.7, 0.2, [`Current volume is ${(s.volumeVsAvg * 100).toFixed(0)}% of the 20-bar average`]);
    }
    if (s.breadthRatio !== null) {
      sig('weak_breadth', s.breadthRatio < 0.8, 0.15, [`Advance/decline ratio is ${s.breadthRatio.toFixed(2)}`]);
    }
    if (s.cpr) {
      const insideCpr = s.lastPrice >= s.cpr.bc && s.lastPrice <= s.cpr.tc;
      sig('consolidating_in_cpr', insideCpr, 0.1, [`Price is trading inside the Central Pivot Range (${s.cpr.bc.toFixed(1)}–${s.cpr.tc.toFixed(1)})`]);
    }
    return out;
  }
}
