'use client';

import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { Panel } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { resolveExpiry, mockIvPct, strikeStepFor, ATM_STRIKE, STRIKE_STEP } from '@/lib/mock/optionChain';
import { resolveLegs } from '@/lib/learning/payoff';
import type { Strategy } from '@/lib/learning/types';
import type { ChartPriceLine } from '@/components/charts/TradeChart';
import { StrategyOverlay } from './StrategyOverlay';
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
export function TradeWorkspace({ strategies = [] }: { strategies?: Strategy[] }) {
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

  // `?strategy=<id>` arrives from the Learning Hub's Apply action. It is
  // VISUALISE-ONLY: the legs are drawn on the chart and a payoff diagram is
  // rendered, and nothing is ordered or staged (LEARNING-HUB.md §6).
  const strategyParam = searchParams.get('strategy');
  const strategy = strategyParam ? strategies.find((s) => s.id === strategyParam) : undefined;

  // Strikes resolve against the live price, so the same lesson works on any
  // underlying. Without a price there is no ATM to anchor to, and drawing the
  // legs against a stale mock spot would put them in the wrong place — so the
  // overlay waits rather than rendering something misleading.
  const strikeStep = symbol ? strikeStepFor(symbol) : STRIKE_STEP;
  const strategySpot = livePrice;
  const strategyYears = expiry ? expiry.days / 365 : undefined;

  const strategyPriceLines: ChartPriceLine[] | undefined =
    strategy && strategySpot && strategyYears !== undefined
      ? resolveLegs(strategy.legs, strategySpot, strikeStep, strategyYears).map((leg) => ({
          price: leg.strikePrice,
          title: `${leg.action === 'BUY' ? '+' : '−'}${leg.kind} ${leg.strikePrice}`,
          colorToken: leg.action === 'BUY' ? '--green' : '--red',
          dashed: true,
        }))
      : undefined;

  return (
    <div className="mx-auto max-w-[1440px] space-y-4 p-4">
      <ChartPanel
        symbol={symbol}
        contract={contract}
        initialExpiryLabel={expiry?.label}
        priceLines={strategyPriceLines}
        trailingControls={<><LayoutMenu /><ClosedPanelsMenu /></>}
      />

      {strategy && (
        strategySpot && strategyYears !== undefined ? (
          <StrategyOverlay
            strategy={strategy}
            symbol={symbol ?? 'NIFTY'}
            spot={strategySpot}
            strikeStep={strikeStep}
            yearsToExpiry={strategyYears}
            expiryLabel={expiry?.label ?? '—'}
          />
        ) : (
          <Panel title={strategy.name} elevation={1}>
            <p className="text-[11.5px] text-faint">
              Waiting for a live price on {symbol ?? 'this instrument'} — strikes are resolved around the at-the-money
              level, so the payoff cannot be drawn until it is known.
            </p>
          </Panel>
        )
      )}

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
