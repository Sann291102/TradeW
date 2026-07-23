'use client';

import { useId, useMemo } from 'react';
import Link from 'next/link';
import { Badge, Panel, cn } from '@tradew/ui';
import { buildPayoffProfile, payoffZones } from '@/lib/learning/payoff';
import { centredOn, formatPrice, legFunction, legRole, zoneBehaviour, zoneRange } from '@/lib/learning/describe';
import type { Strategy } from '@/lib/learning/types';
import { fmt } from '@/lib/format';

/**
 * The expiry payoff and structural breakdown shown when a strategy is opened
 * from the Learning Hub.
 *
 * Two rules govern everything rendered here.
 *
 * 1. **Nothing is ordered or staged.** This panel only describes a structure.
 * 2. **Nothing is phrased as an instruction.** Bands and behaviour, never
 *    "buy this" / "sell that" — LEARNING-HUB.md §6. All wording comes from
 *    lib/learning/describe.ts so the rule is enforced in one place.
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
  const zones = useMemo(() => payoffZones(profile), [profile]);

  const geometry = useMemo(() => {
    const prices = profile.points.map((p) => p.price);
    const pnls = profile.points.map((p) => p.pnl);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const maxAbs = Math.max(Math.abs(Math.min(...pnls)), Math.abs(Math.max(...pnls)), 1);

    const x = (price: number) => PAD_X + ((price - minPrice) / (maxPrice - minPrice)) * (CHART_WIDTH - PAD_X * 2);
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
          <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
            {strategy.net === 'credit' ? 'opens with a credit' : strategy.net === 'debit' ? 'opens with a debit' : 'zero cost'}
          </Badge>
        </span>
      }
    >
      <p className="text-[12px] font-medium leading-relaxed text-text">
        This setup is centred on {centredOn(profile.legs)}.
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{strategy.chartNote}</p>

      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="mt-3 w-full"
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

        <line x1={PAD_X} y1={geometry.zeroY} x2={CHART_WIDTH - PAD_X} y2={geometry.zeroY} stroke="var(--border2)" strokeWidth="1" />

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
            <text x={geometry.x(leg.strikePrice)} y={PAD_Y} textAnchor="middle" className="fill-faint" style={{ fontSize: 9 }}>
              {formatPrice(leg.strikePrice)}
            </text>
          </g>
        ))}

        <line x1={geometry.x(spot)} y1={PAD_Y / 2} x2={geometry.x(spot)} y2={CHART_HEIGHT - PAD_Y / 2} stroke="var(--teal)" strokeWidth="1" />
        {profile.breakevens.map((be) => (
          <circle key={be} cx={geometry.x(be)} cy={geometry.zeroY} r="3" fill="var(--teal)" />
        ))}

        <polyline points={geometry.curve} fill="none" stroke="var(--text)" strokeWidth="1.75" strokeLinejoin="round" />
      </svg>

      {/* How the structure behaves across each price band — the teaching core
          of this panel, and deliberately the largest thing on it. */}
      <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">How it behaves by price</h3>
      <ul className="mt-1.5 grid gap-1">
        {zones.map((zone, i) => (
          <li
            key={i}
            className={cn(
              'flex flex-col gap-0.5 rounded-lg border-l-2 bg-bg px-2.5 py-1.5 sm:flex-row sm:items-baseline sm:gap-3',
              zone.kind === 'gain' ? 'border-l-up' : 'border-l-down',
            )}
          >
            <span className="w-32 shrink-0 font-mono text-[11px] font-semibold tabular-nums text-text">{zoneRange(zone)}</span>
            <span className="text-[11px] leading-relaxed text-muted">{zoneBehaviour(zone)}</span>
          </li>
        ))}
      </ul>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
        <Stat label="At entry" value={`${profile.netPremium >= 0 ? '+' : ''}${fmt(profile.netPremium)}`} tone={profile.netPremium >= 0 ? 'up' : 'down'} />
        <Stat label="Best case" value={profile.maxProfit === null ? 'No fixed limit' : fmt(profile.maxProfit)} tone="up" />
        <Stat label="Worst case" value={profile.maxLoss === null ? 'No fixed limit' : fmt(Math.abs(profile.maxLoss))} tone="down" />
        <Stat label="Breakeven" value={profile.breakevens.map((b) => fmt(b)).join(' / ') || '—'} />
      </dl>

      <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">What it is made of</h3>
      <table className="mt-1.5 w-full text-left text-[11px]">
        <thead>
          <tr className="text-faint">
            <th className="pb-1 font-medium">Leg</th>
            <th className="pb-1 font-medium">Strike</th>
            <th className="pb-1 font-medium">Role in the structure</th>
          </tr>
        </thead>
        <tbody>
          {profile.legs.map((leg, i) => (
            <tr key={`${leg.kind}-${leg.strikePrice}-${i}`} className="border-t border-border align-top">
              <td className="py-1 pr-2">
                <span className={cn('font-semibold', leg.action === 'BUY' ? 'text-up' : 'text-down')}>
                  {leg.ratio > 1 ? `${leg.ratio}× ` : ''}
                  {legRole(leg)}
                </span>
              </td>
              <td className="py-1 pr-2 font-mono tabular-nums text-text">{formatPrice(leg.strikePrice)}</td>
              <td className="py-1 text-muted">{legFunction(leg)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-2">
        <Link href={`/learning/${strategy.id}`} className="text-[11px] font-semibold text-teal hover:underline">
          Read the full lesson →
        </Link>
        <span className="text-[10px] text-faint">including how this structure typically fails</span>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-faint">
        An illustration of structure, not a recommendation — nothing is ordered and no position is opened. Strikes are
        resolved from the {fmt(strikeStep)}-point step around the {formatPrice(profile.atm)} at-the-money level.
        Premiums are estimated with Black-Scholes at a flat implied volatility, not live option quotes, so the shape and
        the bands are structurally correct while rupee values are indicative. Figures are per unit and exclude STT,
        brokerage and the bid-ask spread, which are material on multi-leg structures.
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
