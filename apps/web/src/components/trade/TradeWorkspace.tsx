'use client';

import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { Panel } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { resolveExpiry, mockIvPct, ATM_STRIKE, STRIKE_STEP } from '@/lib/mock/optionChain';
import { LayoutMenu } from '@/components/workspace/LayoutMenu';
import { ClosedPanelsMenu } from '@/components/workspace/ClosedPanelsMenu';
import { BlotterPanel } from '../terminal/panels/BlotterPanel';
import { SentinelPanel } from '../terminal/panels/SentinelPanel';
import { NewsPanel } from '../terminal/panels/NewsPanel';
import { OrdersPanel } from '../terminal/panels/OrdersPanel';

const ChartPanel = dynamic(() => import('../terminal/panels/ChartPanel'), {
  ssr: false,
  loading: () => <Panel title="Chart" loading className="min-h-[420px]" />,
});

/**
 * TradeWorkspace — the Trade page's content, as one integrated page rather
 * than a dock of movable/pinnable/pop-out-able panels. Per the redesign
 * feedback: no multi-workspace-tab switcher, no drag/resize/collapse/pop-out
 * chrome, no empty "drop a panel here" zones — sections render only when
 * they're actually shown. The underlying panel-visibility model
 * (`workspaceStore`) is still used (so Layout presets and the Closed-items
 * restore menu keep working, just relocated here instead of a separate top
 * bar), but `WorkspaceTabs`/`WorkspaceDock`/`DockSlot` are not used on this
 * route anymore — they're untouched and still available, just unused here
 * (never deleted, per repo rule).
 */
export function TradeWorkspace() {
  const searchParams = useSearchParams();
  const symbol = searchParams.get('symbol') ?? undefined;

  const strikeParam = searchParams.get('strike');
  const typeParam = searchParams.get('type');
  const expiryParam = searchParams.get('expiry');
  const actionParam = searchParams.get('action');

  const strike = strikeParam ? Number(strikeParam) : null;
  const optionType: 'CE' | 'PE' | null = typeParam === 'CE' || typeParam === 'PE' ? typeParam : null;
  // expiryParam may be a real ISO date (live Dhan chain) or a mock EXPIRIES
  // label (simulated fallback) — resolveExpiry handles both.
  const expiry = expiryParam ? resolveExpiry(expiryParam) : null;
  const contract =
    strike != null && optionType && expiry
      ? {
          strike,
          optionType,
          expiryLabel: expiry.label,
          yearsToExpiry: expiry.days / 365,
          ivPct: mockIvPct((strike - ATM_STRIKE) / STRIKE_STEP),
        }
      : undefined;
  const orderAction = actionParam === 'buy' ? 'BUY' : actionParam === 'sell' ? 'SELL' : null;

  const tab = useWorkspaceStore((s) => s.activeTab());
  const isVisible = (kind: string) => tab.panels.find((p) => p.kind === kind)?.visible ?? false;

  // Live LTP for the Orders panel's limit-price prefill and order-value
  // readout — same shared singleton feed the rest of the app uses, so this
  // adds no extra network traffic.
  const { quotes, stocks, etfs, commodities } = useDhanLiveFeed();
  const livePrice = symbol
    ? [...(quotes ?? []), ...(stocks ?? []), ...(etfs ?? []), ...(commodities ?? [])].find((q) => q.symbol === symbol)?.ltp
    : undefined;

  return (
    <div className="mx-auto max-w-[1440px] space-y-4 p-4">
      <ChartPanel
        symbol={symbol}
        contract={contract}
        initialExpiryLabel={expiry?.label}
        trailingControls={<><LayoutMenu /><ClosedPanelsMenu /></>}
      />

      <OrdersPanel
        key={`${symbol}-${contract?.strike ?? ''}-${contract?.optionType ?? ''}-${orderAction ?? ''}`}
        symbol={symbol}
        defaultSide={orderAction ?? undefined}
        currentPrice={livePrice}
        isOptionContract={!!contract}
        contractLabel={
          contract
            ? `${symbol ?? 'NIFTY'} ${contract.strike} ${contract.optionType} · ${contract.expiryLabel}`
            : symbol
        }
      />

      {isVisible('blotter') && <BlotterPanel />}

      {(isVisible('sentinel') || isVisible('news')) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {isVisible('sentinel') && <SentinelPanel />}
          {isVisible('news') && <NewsPanel />}
        </div>
      )}
    </div>
  );
}
