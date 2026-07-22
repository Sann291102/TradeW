'use client';

import { useState } from 'react';
import { Panel, cn } from '@tradew/ui';
import type { DockPanelContentProps } from './types';

export interface OrderTicketPanelProps extends DockPanelContentProps {
  /** Pre-selects BUY/SELL — e.g. arriving from the Option Chain's quick
   *  actions. Still just a visual default; the form itself is unchanged
   *  (preview-only, no order placed). */
  defaultSide?: 'BUY' | 'SELL';
  /** Shown above the form when prefilled from a specific contract, e.g.
   *  "NIFTY 23900 CE · 21 Jul". */
  contractLabel?: string;
}

/**
 * Order Ticket slot — visual order form (BUY/SELL, qty, product, order type).
 * UI architecture only: no order is placed (Milestone 2 scope). The working
 * order-entry logic from the Sprint-0 page is preserved in
 * archive/web-trade-sprint0-page.tsx.txt for re-wiring in a later milestone.
 */
export function OrderTicketPanel({ className, actions, collapsed, defaultSide, contractLabel }: OrderTicketPanelProps) {
  const [side, setSide] = useState<'BUY' | 'SELL'>(defaultSide ?? 'BUY');
  return (
    <Panel title="Order Ticket" subtitle={contractLabel} className={className} scroll={false} actions={actions} collapsed={collapsed}>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-0.5">
        {(['BUY', 'SELL'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            onClick={() => setSide(s)}
            className={cn(
              'rounded-md py-1.5 text-xs font-bold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              side === s
                ? s === 'BUY'
                  ? 'bg-up text-white'
                  : 'bg-down text-white'
                : 'text-muted hover:text-text',
            )}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="mt-3 space-y-2 text-xs">
        <label className="block">
          <span className="text-faint">Quantity</span>
          <input
            type="number"
            defaultValue={75}
            className="mt-1 w-full rounded-lg border border-border2 bg-card px-2 py-1.5 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-faint">Product</span>
            <select className="mt-1 w-full rounded-lg border border-border2 bg-card px-2 py-1.5 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <option>MIS</option>
              <option>NRML/CNC</option>
            </select>
          </label>
          <label className="block">
            <span className="text-faint">Order type</span>
            <select className="mt-1 w-full rounded-lg border border-border2 bg-card px-2 py-1.5 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <option>Market</option>
              <option>Limit</option>
              <option>Stop-loss</option>
            </select>
          </label>
        </div>
      </div>
      <button
        type="button"
        disabled
        title="Order placement is wired in a later milestone"
        className={cn(
          'mt-3 w-full rounded-lg py-2 text-sm font-bold text-white opacity-60',
          side === 'BUY' ? 'bg-up' : 'bg-down',
        )}
      >
        {side} · Paper
      </button>
      <p className="mt-2 text-center text-[10px] text-faint">Preview — no order is placed.</p>
    </Panel>
  );
}
