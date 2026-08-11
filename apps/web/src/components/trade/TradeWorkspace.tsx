'use client';

import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { Panel } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { useOptionQuote } from '@/lib/hooks/useOptionQuote';
import { buildOptionSymbol } from '@/lib/oms';
import { resolveExpiry, mockIvPct, strikeStepFor, ATM_STRIKE, STRIKE_STEP } from '@/lib/mock/optionChain';
import { resolveLegs } from '@/lib/learning/payoff';
import { legMarker } from '@/lib/learning/describe';
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
  // Which ChartPanel tab to land on. Option Chain / Technicals / Depth are tabs
  // inside ChartPanel rather than separate dock panels, so a URL param is the
  // only way to address them — used by the TradeW AI assistant ("show the
  // option chain"). Validated against the known set so a bad param can't put
  // the panel into an unrenderable view.
  const viewParam = searchParams.get('view');
  const initialView = (['markets', 'charts', 'technicals', 'optionChain', 'depth'] as const).find(
    (v) => v === viewParam,
  );

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

  // The symbol the OMS actually trades. For an option we need the real ISO
  // expiry to build the canonical contract symbol the engine resolves; a
  // mock-expiry contract (no expiryIso) can't be placed, so orderSymbol stays
  // undefined and the ticket blocks with a clear reason instead of trading the
  // underlying. For an underlying it's just the symbol.
  const orderSymbol =
    contract && symbol
      ? contract.expiryIso
        ? buildOptionSymbol(symbol, contract.expiryIso, contract.strike, contract.optionType)
        : undefined
      : symbol;
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
          // Descriptive position state, never an action. "+CE 24000" was both
          // cryptic and read as an instruction; "long 24,000" states what the
          // structure holds without telling anyone to do anything.
          title: legMarker(leg),
          colorToken: leg.action === 'BUY' ? '--green' : '--red',
          dashed: true,
        }))
      : undefined;

  return (
    <div className="mx-auto max-w-[1440px] space-y-4 p-4">
      {/* Two-column instrument layout (reference-matched): chart + market
          detail on the left, order ticket + order book on the right. Single
          column below the `lg` breakpoint — same responsive approach already
          used for the Sentinel/News pair further down this page. */}
      <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-4">
          <ChartPanel
            symbol={symbol}
            contract={contract}
            initialExpiryLabel={expiry?.label}
            /**
             * `initialView` was computed above — validated against the known
             * tab set, with a comment explaining that the assistant addresses
             * these tabs by URL — and then never passed here. The parsing was
             * right, the wiring was missing, so `?view=` had no effect at all:
             * ChartPanel always fell back to 'charts'.
             *
             * The symptom was worse than a dead feature. The assistant DID
             * navigate, so it reported "Option Chain is open" while the screen
             * stayed on Charts, and repeated it when told otherwise — from its
             * side the navigation genuinely had succeeded. Reported 2026-08-11
             * with a screenshot of exactly that exchange.
             *
             * Verified by loading /trade?view=optionChain directly: before this
             * line the tab stayed on Charts even on a full page load, which is
             * what proved the fault was here rather than in the assistant.
             */
            initialView={initialView}
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
                  Waiting for a live price on {symbol ?? 'this instrument'} — strikes are resolved around the
                  at-the-money level, so the payoff cannot be drawn until it is known.
                </p>
              </Panel>
            )
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <OrdersPanel
            key={`${symbol}-${contract?.strike ?? ''}-${contract?.optionType ?? ''}-${orderAction ?? ''}`}
            symbol={symbol}
            defaultSide={orderAction ?? undefined}
            currentPrice={livePrice}
            isOptionContract={!!contract}
            orderSymbol={orderSymbol}
            contractLabel={
              contract
                ? `${symbol ?? 'NIFTY'} ${contract.strike} ${contract.optionType} · ${contract.expiryLabel}`
                : symbol
            }
          />

          {/* Positions/Orders/Trades — stacked under the order ticket instead
              of a full-width strip below the whole layout, and stretched
              (min-h-0 so its own scroll area, not the page, absorbs overflow)
              to fill the rest of this column, so the right column's total
              height matches the chart panel's on the left. */}
          {isVisible('blotter') && <BlotterPanel className="min-h-0 flex-1" />}
        </div>
      </div>

      {(isVisible('sentinel') || isVisible('news')) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {isVisible('sentinel') && <SentinelPanel />}
          {isVisible('news') && <NewsPanel />}
        </div>
      )}
    </div>
  );
}
