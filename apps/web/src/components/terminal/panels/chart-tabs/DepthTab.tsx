import { cn } from '@tradew/ui';
import { fmt } from '@/lib/format';

// mock 5-level market depth ladder (presentation only)
const BIDS = [
  { price: 23880.5, qty: 1275 },
  { price: 23880.0, qty: 900 },
  { price: 23879.5, qty: 2100 },
  { price: 23879.0, qty: 1500 },
  { price: 23878.5, qty: 675 },
];
const ASKS = [
  { price: 23881.0, qty: 1050 },
  { price: 23881.5, qty: 1425 },
  { price: 23882.0, qty: 825 },
  { price: 23882.5, qty: 1950 },
  { price: 23883.0, qty: 600 },
];
const maxQty = Math.max(...BIDS.map((b) => b.qty), ...ASKS.map((a) => a.qty));

function Ladder({ rows, side }: { rows: typeof BIDS; side: 'bid' | 'ask' }) {
  return (
    <div className="space-y-0.5">
      {rows.map((r, i) => (
        <div key={i} className="relative flex items-center justify-between px-1.5 py-0.5 text-[11px]">
          <span
            aria-hidden
            className={cn('absolute inset-y-0', side === 'bid' ? 'right-0 bg-up-bg' : 'left-0 bg-down-bg')}
            style={{ width: `${(r.qty / maxQty) * 100}%` }}
          />
          <span className={cn('relative font-mono tabular-nums', side === 'bid' ? 'text-up' : 'text-down')}>{fmt(r.price)}</span>
          <span className="relative font-mono tabular-nums text-muted">{r.qty}</span>
        </div>
      ))}
    </div>
  );
}

/** Depth tab — 5-level bid/ask ladder (mock), extracted from the former
 *  standalone `DepthPanel` so it renders inside the consolidated chart panel. */
export function DepthTab() {
  return (
    <div className="grid grid-cols-2 gap-2 p-3">
      <Ladder rows={BIDS} side="bid" />
      <Ladder rows={ASKS} side="ask" />
    </div>
  );
}
