import { NotBuiltYet } from '@/components/workspace-shells/NotBuiltYet';

export const metadata = { title: 'Backtesting — TradeW' };

/**
 * There is no backtesting engine in TradeW.
 *
 * What exists and is easy to mistake for one: `Candle` history and the
 * `/market-data` routes that serve it, the strategy definitions in
 * `UserStrategy`, and Sentinel's forward-looking watch sessions
 * (`WatchSession`/`WatchObservation`), which observe live markets rather than
 * replay past ones. None of that is a simulator: nothing walks a strategy over
 * historical bars, fills orders against them, or computes a result.
 *
 * Building that in the browser — the obvious shortcut — would produce numbers
 * that look like backtest results and are not, because the fills would be
 * invented rather than matched by the engine that fills real paper orders.
 * That is exactly the kind of plausible-but-false surface this page refuses to
 * be.
 */
export default function BacktestingPage() {
  return (
    <NotBuiltYet
      title="Backtesting"
      intent="Replay a strategy over historical market data and see what it would have done, using the same matching engine that fills live paper orders."
      status={
        <>
          No backtesting engine exists in this repository. Historical candles are available
          (<code className="font-mono text-[11px]">Candle</code> and the market-data service) and
          strategies are already modelled (<code className="font-mono text-[11px]">UserStrategy</code>),
          but nothing walks one over the other. A front-end simulation would have to invent its own
          fills, which is why there isn&apos;t one here.
        </>
      }
      planned={[
        'Run a saved strategy over a date range of real historical candles',
        'Fills produced by the existing paper matching engine, not by approximation',
        'Equity curve, drawdown, win rate, expectancy and per-trade detail',
        'Comparison across strategies and across parameter sets',
        'Promotion of a validated strategy into an AI Sentinel watch',
      ]}
      instead={[
        { href: '/sentinel', label: 'AI Sentinel', hint: 'Define a strategy and watch it forward, live' },
        { href: '/portfolio', label: 'Portfolio → Performance', hint: 'Realised performance of your paper account' },
        { href: '/research', label: 'Research', hint: 'Historical analysis of instruments and market structure' },
      ]}
    />
  );
}
