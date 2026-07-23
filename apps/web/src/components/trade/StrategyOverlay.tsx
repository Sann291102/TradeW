'use client';

import { useId, useMemo } from 'react';
import { Badge, Panel, cn } from '@tradew/ui';
import { buildPayoffProfile } from '@/lib/learning/payoff';
import type { Strategy } from '@/lib/learning/types';
import { fmt } from '@/lib/format';

/**
 * The expiry payoff diagram and leg breakdown shown when a strategy is applied
 * from the Learning Hub.
 *
 * Visualise-only by design — this panel never places an order and never stages
 * one. It exists to answer "what shape is this position", which is the
 * Learning Hub's remit (LEARNING-HUB.md §6: education, not a signal service).
 */

const CHART_WIDTH = 640;
const CHART_HEIGHT = 180;
const PAD_X = 8;
const PAD_Y = 12;

export interface StrategyOverlayProps {
  strategy: Strategy;
  symbol: string;
  spot: number;
  strikeStep: number;
  yearsToExpiry: number;
  expiryLabel: string;
  className?: string;
}

export function StrategyOverlay({
  strategy,
  symbol,
  spot,
  strikeStep,
  yearsToExpiry,
  expiryLabel,
  className,
}: StrategyOverlayProps) {
  const clipId = useId();

  const profile = useMemo(
    () => buildPayoffProfile(strategy, spot, strikeStep, yearsToExpiry),
    [strategy, spot, strikeStep, yearsToExpiry],
  );

  const geometry = useMemo(() => {
    const prices = profile.points.map((p) => p.price);
    const pnls = profile.points.map((p) => p.pnl);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const maxAbs = Math.max(Math.abs(Math.min(...pnls)), Math.abs(Math.max(...pnls)), 1);

    const x = (price: number) => PAD_X + ((price - minPrice) / (maxPrice - minPrice)) * (CHART_WIDTH - PAD_X * 2);
    // Symmetric around zero so the zero line sits mid-height and profit/loss
    // are visually comparable rather than one side being squashed.
    const y = (pnl: number) => CHART_HEIGHT / 2 - (pnl / maxAbs) * (CHART_HEIGHT / 2 - PAD_Y);

    const curve = profile.points.map((p) => `${x(p.price).toFixed(2)},${y(p.pnl).toFixed(2)}`).join(' ');
    const zeroY = y(0);
    const area = `M ${x(minPrice).toFixed(2)},${zeroY.toFixed(2)} L ${curve.split(' ').join(' L ')} L ${x(maxPrice).toFixed(2)},${zeroY.toFixed(2)} Z`;

    return { x, y, curve, zeroY, area, minPrice, maxPrice };
  }, [profile]);

  return (
    <Panel
      className={className}
      elevation={1}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-bold normal-case text-text">{strategy.name}</span>
          <span className="text-[11px] text-muted">
            {symbol} · {expiryLabel}
          </span>
          <Badge tone={strategy.net === 'credit' ? 'positive' : 'neutral'} className="px-1.5 py-0 text-[9px]">
            {strategy.net === 'credit' ? 'net credit' : strategy.net === 'debit' ? 'net debit' : 'zero cost'}
          </Badge>
        </span>
      }
    >
      {/* The one-line explanation authored alongside the lesson. */}
      <p className="mb-3 text-[11.5px] leading-relaxed text-muted">{strategy.chartNote}</p>

      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="w-full"
        style={{ height: CHART_HEIGHT }}
        role="img"
        aria-label={`Expiry payoff for ${strategy.name} on ${symbol}. ${strategy.chartNote}`}
      >
        <defs>
          <clipPath id={`${clipId}-profit`}>
            <rect x="0" y="0" width={CHART_WIDTH} height={geometry.zeroY} />
          </clipPath>
          <clipPath id={`${clipId}-loss`}>
            <rect x="0" y={geometry.zeroY} width={CHART_WIDTH} height={CHART_HEIGHT - geometry.zeroY} />
          </clipPath>
        </defs>

        <path d={geometry.area} fill="var(--green)" opacity="0.18" clipPath={`url(#${clipId}-profit)`} />
        <path d={geometry.area} fill="var(--red)" opacity="0.18" clipPath={`url(#${clipId}-loss)`} />

        {/* Break-even axis */}
        <line x1={PAD_X} y1={geometry.zeroY} x2={CHART_WIDTH - PAD_X} y2={geometry.zeroY} stroke="var(--border2)" strokeWidth="1" />

        {/* Each leg's strike */}
        {profile.legs.map((leg, i) => (
          <g key={`${leg.kind}-${leg.strikePrice}-${i}`}>
            <line
              x1={geometry.x(leg.strikePrice)}
              y1={PAD_Y / 2}
              x2={geometry.x(leg.strikePrice)}
              y2={CHART_HEIGHT - PAD_Y / 2}
              stroke="var(--border2)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <text
              x={geometry.x(leg.strikePrice)}
              y={PAD_Y}
              textAnchor="middle"
              className="fill-faint"
              style={{ fontSize: 9 }}
            >
              {leg.action === 'BUY' ? '+' : '−'}
              {leg.kind}
            </text>
          </g>
        ))}

        {/* Spot */}
        <line
          x1={geometry.x(spot)}
          y1={PAD_Y / 2}
          x2={geometry.x(spot)}
          y2={CHART_HEIGHT - PAD_Y / 2}
          stroke="var(--teal)"
          strokeWidth="1"
        />

        {/* Break-even crossings */}
        {profile.breakevens.map((be) => (
          <circle key={be} cx={geometry.x(be)} cy={geometry.zeroY} r="3" fill="var(--teal)" />
        ))}

        <polyline points={geometry.curve} fill="none" stroke="var(--text)" strokeWidth="1.75" strokeLinejoin="round" />
      </svg>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
        <Stat label="Net at entry" value={`${profile.netPremium >= 0 ? '+' : ''}${fmt(profile.netPremium)}`} tone={profile.netPremium >= 0 ? 'up' : 'down'} />
        <Stat label="Max profit" value={profile.maxProfit === null ? 'Unlimited' : fmt(profile.maxProfit)} tone="up" />
        <Stat label="Max loss" value={profile.maxLoss === null ? 'Unlimited' : fmt(Math.abs(profile.maxLoss))} tone="down" />
        <Stat label="Breakeven" value={profile.breakevens.map((b) => fmt(b)).join(' / ') || '—'} />
      </dl>

      <table className="mt-3 w-full text-left text-[11px]">
        <thead>
          <tr className="text-faint">
            <th className="pb-1 font-medium">Leg</th>
            <th className="pb-1 font-medium">Strike</th>
            <th className="pb-1 text-right font-medium">Est. premium</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {profile.legs.map((leg, i) => (
            <tr key={`${leg.kind}-${leg.strikePrice}-${i}`} className="border-t border-border">
              <td className="py-1">
                <span className={cn('font-semibold', leg.action === 'BUY' ? 'text-up' : 'text-down')}>{leg.action}</span>{' '}
                <span className="text-text">
                  {leg.ratio > 1 ? `${leg.ratio}× ` : ''}
                  {leg.kind}
                </span>
                <span className="ml-1 text-faint">({leg.strike})</span>
              </td>
              <td className="py-1 text-text">{fmt(leg.strikePrice)}</td>
              <td className="py-1 text-right text-muted">{leg.premium ? fmt(leg.premium) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-3 border-t border-border pt-2 text-[10px] leading-relaxed text-faint">
        Illustration only — nothing is ordered. Strikes are resolved from the {fmt(strikeStep)}-point step around the{' '}
        {fmt(profile.atm)} ATM. Premiums are estimated with Black-Scholes at a flat implied volatility, not live option
        quotes, so the shape and breakevens are structurally correct while the rupee values are indicative. Per-lot
        figures exclude STT, brokerage and the bid-ask spread, which are material on multi-leg structures.
      </p>
    </Panel>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className={cn('font-mono font-semibold tabular-nums', tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text')}>
        {value}
      </dd>
    </div>
  );
}
