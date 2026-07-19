'use client';

import { Panel, cn } from '@tradew/ui';
import { fmt } from '@/lib/format';
import type { DockPanelContentProps } from './types';

// mock ATM option chain rows (presentation only)
const STRIKES = [23800, 23850, 23900, 23950, 24000];
const ATM = 23900;
function row(strike: number) {
  const dist = Math.abs(strike - ATM) / 50;
  const callLtp = Math.max(4, 180 - (strike - 23800) * 0.28 + 20);
  const putLtp = Math.max(4, 60 + (strike - 23800) * 0.3);
  return { strike, callOi: 12000 - dist * 1500, callLtp, putLtp, putOi: 9000 + dist * 1200 };
}

/**
 * Option Chain slot — ATM strikes with call/put LTP + OI (mock). Lazy-loaded
 * (next/dynamic) per the performance brief. Default export for dynamic import.
 */
export default function OptionChainPanel({ className, actions, collapsed }: DockPanelContentProps) {
  return (
    <Panel
      title="Option Chain"
      subtitle="NIFTY · nearest expiry"
      className={className}
      actions={actions}
      collapsed={collapsed}
    >
      <table className="w-full text-[11px]">
        <thead className="text-faint">
          <tr className="border-b border-border">
            <th className="py-1 text-left font-semibold">Call OI</th>
            <th className="py-1 text-right font-semibold">Call LTP</th>
            <th className="py-1 text-center font-semibold">Strike</th>
            <th className="py-1 text-left font-semibold">Put LTP</th>
            <th className="py-1 text-right font-semibold">Put OI</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {STRIKES.map((s) => {
            const r = row(s);
            const atm = s === ATM;
            return (
              <tr key={s} className={cn('border-b border-border', atm && 'bg-teal-bg')}>
                <td className="py-1 text-left text-muted">{Math.round(r.callOi)}</td>
                <td className="py-1 text-right text-up">{fmt(r.callLtp)}</td>
                <td className={cn('py-1 text-center font-bold', atm ? 'text-teal' : 'text-text')}>{s}</td>
                <td className="py-1 text-left text-down">{fmt(r.putLtp)}</td>
                <td className="py-1 text-right text-muted">{Math.round(r.putOi)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
