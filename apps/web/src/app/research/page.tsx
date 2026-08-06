'use client';

import { useState } from 'react';
import { Card, Badge, cn } from '@tradew/ui';
import { TradeChart } from '@/components/charts/TradeChart';
import { useCandles } from '@/lib/hooks/useCandles';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { fmt } from '@/lib/format';

export default function ResearchPage() {
  const [symbol, setSymbol] = useState('RELIANCE');
  const [searchInput, setSearchInput] = useState('');
  const [activeTab, setActiveTab] = useState('Overview');
  const { stocks, quotes } = useDhanLiveFeed();

  const POPULAR_STOCKS = [
    { symbol: 'RELIANCE', name: 'Reliance Industries' },
    { symbol: 'TCS', name: 'Tata Consultancy Services' },
    { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd' },
    { symbol: 'INFY', name: 'Infosys Ltd' },
    { symbol: 'TATAMOTORS', name: 'Tata Motors Ltd' },
    { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd' },
    { symbol: 'SBIN', name: 'State Bank of India' },
    { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd' },
    { symbol: 'ITC', name: 'ITC Ltd' },
  ];

  const allSymbols = [...(stocks ?? []), ...(quotes ?? [])];
  const liveStock = allSymbols.find((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
  const { candles } = useCandles(symbol, '1d', 365);

  const price = liveStock?.ltp ?? (symbol === 'RELIANCE' ? 2945.20 : 1500.00);
  const changePct = liveStock?.changePct ?? 1.45;
  const changeVal = price * (changePct / 100);
  const displayName = POPULAR_STOCKS.find((p) => p.symbol === symbol)?.name ?? liveStock?.displayName ?? `${symbol} LTD`;

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchInput.trim()) {
      setSymbol(searchInput.trim().toUpperCase());
      setSearchInput('');
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      {/* Search & Breadcrumb bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form onSubmit={handleSearchSubmit} className="relative flex-1 max-w-md">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search stock (e.g. TCS, HDFCBANK, INFY)..."
            className="w-full rounded-xl bg-card py-2.5 pl-9 pr-20 text-xs font-semibold text-text placeholder:text-faint focus:outline-none"
          />
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-faint">🔍</span>
          <button
            type="submit"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg bg-teal px-2.5 py-1 text-[11px] font-bold text-white transition-opacity hover:opacity-90"
          >
            Research
          </button>
        </form>

        <div className="flex items-center gap-2 text-xs">
          <button className="rounded-md bg-card px-2.5 py-1.5 font-semibold text-text hover:bg-hover">+ Watchlist</button>
          <button className="rounded-md bg-card px-2.5 py-1.5 font-semibold text-text hover:bg-hover">Compare</button>
          <button className="rounded-md bg-card px-2.5 py-1.5 font-semibold text-text hover:bg-hover">Export PDF</button>
          <button className="rounded-md bg-card px-2.5 py-1.5 font-semibold text-text hover:bg-hover">Share</button>
        </div>
      </div>

      {/* Quick stock selection pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
        <span className="text-[11px] font-bold text-faint shrink-0">Popular:</span>
        {POPULAR_STOCKS.map((s) => (
          <button
            key={s.symbol}
            type="button"
            onClick={() => setSymbol(s.symbol)}
            className={cn(
              'shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
              symbol === s.symbol ? 'bg-teal-bg text-teal font-bold' : 'bg-card text-muted hover:text-text',
            )}
          >
            {s.symbol}
          </button>
        ))}
      </div>

      {/* Stock Hero Header */}
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-extrabold text-text">{displayName}</h1>
                <span className="text-amber">★</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                <span className="font-bold text-muted">{symbol}</span>
                <span className="text-faint">· NSE</span>
                <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">Large Cap</Badge>
                <Badge tone="positive" className="px-1.5 py-0 text-[9px]">High Quality</Badge>
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-2xl font-extrabold text-text">₹{fmt(price)}</div>
            <div className={cn('text-xs font-bold', changePct >= 0 ? 'text-up' : 'text-down')}>
              {changePct >= 0 ? '+' : ''}{changeVal.toFixed(2)} ({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)
            </div>
            <div className="mt-0.5 text-[11px] text-faint">Market Cap <b className="text-text">₹{(price * 670).toLocaleString('en-IN')} Cr</b></div>
          </div>
        </div>

        {/* TradeW AI Summary bar */}
        <div className="mt-4 rounded-xl bg-teal-bg/20 p-3">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 font-bold text-teal">
              <span>🤖</span> TradeW AI Summary
            </div>
            <span className="text-[10px] text-faint">Generated by TradeW AI</span>
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7 text-xs">
            <div className="rounded-lg bg-card p-2 text-center">
              <div className="text-[10px] text-faint">Overall Outlook</div>
              <div className="mt-0.5 font-extrabold text-up">Bullish 🐂</div>
            </div>
            <div className="rounded-lg bg-card p-2 text-center">
              <div className="text-[10px] text-faint">Confidence</div>
              <div className="mt-0.5 font-extrabold text-teal">87%</div>
            </div>
            <div className="rounded-lg bg-card p-2 text-center">
              <div className="text-[10px] text-faint">Business Quality</div>
              <div className="mt-0.5 font-extrabold text-up">9.2 /10</div>
              <div className="text-[9px] text-faint">Excellent</div>
            </div>
            <div className="rounded-lg bg-card p-2 text-center">
              <div className="text-[10px] text-faint">Financial Health</div>
              <div className="mt-0.5 font-extrabold text-up">8.8 /10</div>
              <div className="text-[9px] text-faint">Very Good</div>
            </div>
            <div className="rounded-lg bg-card p-2 text-center">
              <div className="text-[10px] text-faint">Valuation</div>
              <div className="mt-0.5 font-extrabold text-amber">Slightly Expensive</div>
            </div>
            <div className="rounded-lg bg-card p-2 text-center">
              <div className="text-[10px] text-faint">Risk</div>
              <div className="mt-0.5 font-extrabold text-amber">Medium</div>
            </div>
            <div className="rounded-lg bg-card p-2 text-center">
              <div className="text-[10px] text-faint">Momentum</div>
              <div className="mt-0.5 font-extrabold text-up">Strong</div>
            </div>
          </div>
        </div>

        {/* Sub-nav tabs */}
        <div className="mt-4 flex gap-1 overflow-x-auto border-t border-border pt-3 text-xs font-bold">
          {['Overview', 'Fundamentals', 'Financials', 'Shareholding', 'Peers', 'News', 'Technicals', 'Corporate Actions', 'Risk Factors'].map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={cn(
                'shrink-0 rounded-md px-3 py-1.5 transition-colors',
                activeTab === t ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </Card>

      {/* Main 2-column Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        {/* Left Column */}
        <div className="space-y-4">
          {/* Price Chart */}
          <Card title="Price Chart">
            <div className="min-h-[260px] w-full rounded-lg bg-bg p-2">
              <TradeChart
                candles={candles ?? []}
                height={260}
                seriesType="candlestick"
                liveLast={price}
                fitKey={`${symbol}|1d`}
                aria-label={`${symbol} chart`}
              />
            </div>
          </Card>

          {/* Key Metrics */}
          <Card title="Key Metrics">
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
              <div><span className="text-faint">Market Cap</span><div className="font-mono font-bold text-text">₹19,81,568 Cr</div></div>
              <div><span className="text-faint">P/E Ratio (TTM)</span><div className="font-mono font-bold text-text">24.62</div></div>
              <div><span className="text-faint">P/B Ratio</span><div className="font-mono font-bold text-text">2.12</div></div>
              <div><span className="text-faint">ROE (TTM)</span><div className="font-mono font-bold text-text">14.28%</div></div>
              <div><span className="text-faint">ROCE (TTM)</span><div className="font-mono font-bold text-text">17.62%</div></div>
              <div><span className="text-faint">EPS (TTM)</span><div className="font-mono font-bold text-text">₹119.61</div></div>
              <div><span className="text-faint">Dividend Yield</span><div className="font-mono font-bold text-text">0.34%</div></div>
              <div><span className="text-faint">Debt to Equity</span><div className="font-mono font-bold text-text">0.15</div></div>
              <div><span className="text-faint">Current Ratio</span><div className="font-mono font-bold text-text">1.52</div></div>
            </div>
          </Card>

          {/* Bottom Grid: Financials & Shareholding */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Financial Performance */}
            <Card title="Financial Performance">
              <div className="h-44 w-full flex items-end justify-between gap-2 pt-4">
                <div className="text-center flex-1">
                  <div className="flex items-end gap-1 h-32 justify-center">
                    <div className="w-4 bg-up h-20 rounded-t-sm" />
                    <div className="w-4 bg-teal h-10 rounded-t-sm" />
                  </div>
                  <span className="text-[10px] text-faint mt-1 block">Jun '24</span>
                </div>
                <div className="text-center flex-1">
                  <div className="flex items-end gap-1 h-32 justify-center">
                    <div className="w-4 bg-up h-24 rounded-t-sm" />
                    <div className="w-4 bg-teal h-12 rounded-t-sm" />
                  </div>
                  <span className="text-[10px] text-faint mt-1 block">Sep '24</span>
                </div>
                <div className="text-center flex-1">
                  <div className="flex items-end gap-1 h-32 justify-center">
                    <div className="w-4 bg-up h-28 rounded-t-sm" />
                    <div className="w-4 bg-teal h-14 rounded-t-sm" />
                  </div>
                  <span className="text-[10px] text-faint mt-1 block">Dec '24</span>
                </div>
                <div className="text-center flex-1">
                  <div className="flex items-end gap-1 h-32 justify-center">
                    <div className="w-4 bg-up h-32 rounded-t-sm" />
                    <div className="w-4 bg-teal h-16 rounded-t-sm" />
                  </div>
                  <span className="text-[10px] text-faint mt-1 block">Mar '25</span>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-center gap-4 text-[10px]">
                <span className="flex items-center gap-1"><span className="h-2 w-2 bg-up rounded-full" /> Revenue</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 bg-teal rounded-full" /> Net Profit</span>
              </div>
            </Card>

            {/* Shareholding Pattern */}
            <Card title="Shareholding Pattern">
              <div className="space-y-2 text-xs pt-2">
                <div className="flex justify-between border-b border-border/60 pb-1">
                  <span className="text-muted">Promoters</span>
                  <span className="font-bold text-text">50.13%</span>
                </div>
                <div className="flex justify-between border-b border-border/60 pb-1">
                  <span className="text-muted">FIIs</span>
                  <span className="font-bold text-text">24.71%</span>
                </div>
                <div className="flex justify-between border-b border-border/60 pb-1">
                  <span className="text-muted">DIIs</span>
                  <span className="font-bold text-text">15.36%</span>
                </div>
                <div className="flex justify-between border-b border-border/60 pb-1">
                  <span className="text-muted">Public</span>
                  <span className="font-bold text-text">8.13%</span>
                </div>
                <div className="flex justify-between pb-1">
                  <span className="text-muted">Others</span>
                  <span className="font-bold text-text">1.67%</span>
                </div>
              </div>
            </Card>
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-4">
          {/* AI Fair Value */}
          <Card title="AI Fair Value">
            <div className="text-xs space-y-2">
              <div className="flex justify-between">
                <span className="text-faint">Intrinsic Value</span>
                <span className="font-mono font-bold text-text">₹2,820.00</span>
              </div>
              <div className="flex justify-between">
                <span className="text-faint">Current Price</span>
                <span className="font-mono font-bold text-amber">₹2,945.20</span>
              </div>
              <div className="h-2 w-full rounded-full bg-border overflow-hidden flex">
                <div className="w-[80%] bg-teal h-full" />
                <div className="w-[20%] bg-amber h-full" />
              </div>
              <div className="text-center text-[10px] font-bold text-amber">
                Overvalued by 4.43%
              </div>
            </div>
          </Card>

          {/* News & Sentiment */}
          <Card title="News & Sentiment">
            <div className="text-xs space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-faint">Overall Sentiment</span>
                <Badge tone="positive" className="px-2 py-0.5 text-xs font-bold">78% Positive</Badge>
              </div>
              <p className="text-[11px] text-muted leading-relaxed">
                12 articles in the last 24h highlight strong quarterly earnings guidance and telecom expansion.
              </p>
            </div>
          </Card>

          {/* Risk Factors */}
          <Card title="Risk Factors">
            <div className="space-y-2 text-xs">
              <div className="flex justify-between"><span>Business Risk</span><span className="font-bold text-amber">Medium</span></div>
              <div className="flex justify-between"><span>Debt Risk</span><span className="font-bold text-up">Low</span></div>
              <div className="flex justify-between"><span>Political Risk</span><span className="font-bold text-amber">Medium</span></div>
              <div className="flex justify-between"><span>Commodity Risk</span><span className="font-bold text-amber">Medium</span></div>
              <div className="flex justify-between"><span>Management Risk</span><span className="font-bold text-up">Low</span></div>
            </div>
          </Card>

          {/* Sentinel Analysis */}
          <Card title="Sentinel Analysis">
            <div className="space-y-2 text-xs">
              <div className="flex justify-between"><span>Market Structure</span><span className="font-bold text-up">Bullish</span></div>
              <div className="flex justify-between"><span>Emotional Risk</span><span className="font-bold text-up">Low</span></div>
              <div className="flex justify-between"><span>FOMO Score</span><span className="font-mono font-bold text-text">12%</span></div>
              <div className="flex justify-between"><span>Trap Probability</span><span className="font-mono font-bold text-text">18%</span></div>
              <div className="flex justify-between"><span>Historical Similarity</span><span className="font-mono font-bold text-teal">82%</span></div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
