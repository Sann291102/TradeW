'use client';

import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { Panel } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { useOptionQuote } from '@/lib/hooks/useOptionQuote';
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
  // label (simulated fallback) — resolveExpiry handles both. If a strike + type
  // are present but the expiry can't be resolved, still open the contract with
  // a sane near-term default instead of silently dropping it and falling back
  // to the underlying's chart — clicking a strike must open THAT strike.
  const resolvedExpiry = expiryParam ? resolveExpiry(expiryParam) : null;
  const expiry =
    resolvedExpiry ?? (strike != null && optionType ? { label: expiryParam ?? 'Near expiry', days: 7 } : null);
  // A real ISO expiry is what the live option chain is addressed by, so it has
  // to survive the trip through the URL — resolveExpiry collapses it to a
  // display label, and without the ISO the chart cannot look up this strike's
  // real premium (see useOptionQuote) and would fall back to a theoretical one.
  const expiryIso = expiryParam && /^\d{4}-\d{2}-\d{2}$/.test(expiryParam) ? expiryParam : undefined;
  const contract =
    strike != null && optionType && expiry
      ? {
          strike,
          optionType,
          expiryLabel: expiry.label,
          expiryIso,
          yearsToExpiry: expiry.days / 365,
          // Placeholder IV only — the chart replaces this with the strike's REAL
          // implied vol from the option chain (useOptionQuote). It used to be
          // mockIvPct((strike - ATM_STRIKE) / STRIKE_STEP) with NIFTY-shaped
          // constants (ATM 23900, step 50), which is nonsense for any other
          // underlying: a SENSEX 76200 strike computed as 1046 "steps" from
          // NIFTY's ATM and produced an IV of ~37,225%. Distance-from-ATM is
          // only meaningful against that underlying's OWN ATM, so no smile is
          // guessed here at all.
          ivPct: mockIvPct(0),
        }
      : undefined;
  const orderAction = actionParam === 'buy' ? 'BUY' : actionParam === 'sell' ? 'SELL' : null;

  const tab = useWorkspaceStore((s) => s.activeTab());
  const isVisible = (kind: string) => tab.panels.find((p) => p.kind === kind)?.visible ?? false;

  // Live LTP for the Orders panel's limit-price prefill and order-value
  // readout — same shared singleton feed the rest of the app uses, so this
  // adds no extra network traffic.
  const { quotes, stocks, etfs, commodities } = useDhanLiveFeed();
  const underlyingPrice = symbol
    ? [...(quotes ?? []), ...(stocks ?? []), ...(etfs ?? []), ...(commodities ?? [])].find((q) => q.symbol === symbol)?.ltp
    : undefined;

  // An option order is priced in PREMIUM, not in the underlying. Feeding the
  // underlying's LTP here made the ticket value an order of magnitude wrong —
  // 1 lot of NIFTY 23800 CE showed 65 x 23,858 instead of 65 x 157.65 — and
  // prefilled a limit price that could never fill. Same shared hook the chart
  // uses, so the ticket and the chart can never quote different prices for the
  // same contract.
  const { quote: contractQuote } = useOptionQuote(
    contract ? symbol : undefined,
    contract?.expiryIso,
    contract?.strike,
    contract?.optionType,
  );
  const livePrice = contract ? contractQuote?.ltp : underlyingPrice;

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
