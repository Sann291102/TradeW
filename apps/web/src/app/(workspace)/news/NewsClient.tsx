'use client';

import { useState } from 'react';
import { Badge, Card, Skeleton, cn } from '@tradew/ui';
import { newsTime } from '@/lib/news';
import { useNews } from '@/lib/query/useNews';

/**
 * Market News — real headlines from Indian financial newswires.
 *
 * Previously six hardcoded strings in lib/mock/market.ts with frozen
 * timestamps, rendered on the dashboard as though it were a live feed.
 *
 * Headlines only: each item links out to the publisher. TradeW deliberately
 * does not summarise, score or interpret them — saying what a headline MEANS
 * for an instrument is a short step from a recommendation, and this product
 * observes rather than instructs. Reporting what was published is not that.
 */

const CATEGORY_TONE: Record<string, 'neutral' | 'brand' | 'warning'> = {
  MARKETS: 'brand',
  STOCKS: 'brand',
  BUSINESS: 'neutral',
  ECONOMY: 'warning',
};

export function NewsClient() {
  const [activeCat, setActiveCat] = useState<string>('All News');
  // Shares one cached request with the dashboard card and the terminal panel.
  const { items, error, refetch } = useNews();

  const categories = ['All News', 'Market', 'Economy', 'Stocks', 'Commodities', 'Global', 'Policy', 'Results'];

  const filteredItems = items?.filter((item) => {
    if (activeCat === 'All News') return true;
    return item.category.toLowerCase().includes(activeCat.toLowerCase());
  });

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      {/* Header title */}
      <div>
        <h1 className="text-xl font-extrabold text-text">Market News</h1>
        <p className="text-xs text-faint">Real-time market news and insights</p>
      </div>

      {/* Filter pills bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card p-2 border border-border/80">
        <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCat(cat)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-bold transition-colors duration-micro',
                activeCat === cat ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
              )}
            >
              {cat}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 pr-1">
          <button className="flex items-center gap-1 rounded-md border border-border2 bg-bg px-2.5 py-1 text-xs text-muted hover:text-text">
            <span>⚙</span> Filter
          </button>
          <select className="rounded-md border border-border2 bg-bg px-2 py-1 text-xs text-muted">
            <option>Latest</option>
            <option>Most Popular</option>
          </select>
        </div>
      </div>

      {/* Main 2-column layout */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        {/* Left column: News Feed */}
        <div className="space-y-3">
          {error && (
            <div role="alert" className="rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">
              <p>{error}</p>
              <button
                type="button"
                onClick={refetch}
                className="mt-1.5 font-semibold underline underline-offset-2 hover:no-underline"
              >
                Try again
              </button>
            </div>
          )}

          {!items && !error && (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-28 w-full" />
              ))}
            </div>
          )}

          {filteredItems && (
            <div className="space-y-3">
              {filteredItems.map((n, idx) => (
                <Card key={n.id} className="p-3 transition-colors hover:border-teal/50">
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <div className="h-24 w-full shrink-0 overflow-hidden rounded-lg bg-border/40 sm:w-36">
                      <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-navy/30 to-teal/10 text-xl font-bold text-teal/40">
                        {n.category.slice(0, 3)}
                      </div>
                    </div>
                    <div className="flex flex-1 flex-col justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge tone={CATEGORY_TONE[n.category] ?? 'brand'} className="px-1.5 py-0 text-[9px] font-bold uppercase">
                            {n.category}
                          </Badge>
                          <span className="text-[10.5px] text-faint">{newsTime(n.publishedAt)}</span>
                        </div>
                        <a
                          href={n.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 block text-sm font-bold leading-snug text-text transition-colors hover:text-teal"
                        >
                          {n.title}
                        </a>
                        {n.summary && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{n.summary}</p>}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[11px] text-faint">
                        <span>{n.publisher}</span>
                        <div className="flex items-center gap-3">
                          <button className="hover:text-text" title="Bookmark">🔖</button>
                          <button className="hover:text-text" title="Share">↗</button>
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Right column: Right Rail Widgets */}
        <div className="space-y-4">
          {/* Market Snapshot */}
          <Card title="Market Snapshot" subtitle="As on 05 Jun 2025, 3:30 PM">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg border border-border/80 bg-bg p-2">
                <div className="text-[10px] text-faint">NIFTY 50</div>
                <div className="font-mono font-bold text-text">24,834.85</div>
                <div className="text-[10px] font-bold text-down">-0.12%</div>
              </div>
              <div className="rounded-lg border border-border/80 bg-bg p-2">
                <div className="text-[10px] text-faint">SENSEX</div>
                <div className="font-mono font-bold text-text">78,581.00</div>
                <div className="text-[10px] font-bold text-down">-0.60%</div>
              </div>
              <div className="rounded-lg border border-border/80 bg-bg p-2">
                <div className="text-[10px] text-faint">NIFTY BANK</div>
                <div className="font-mono font-bold text-text">52,134.30</div>
                <div className="text-[10px] font-bold text-up">+0.32%</div>
              </div>
              <div className="rounded-lg border border-border/80 bg-bg p-2">
                <div className="text-[10px] text-faint">INDIA VIX</div>
                <div className="font-mono font-bold text-text">12.06</div>
                <div className="text-[10px] font-bold text-down">-1.07%</div>
              </div>
            </div>
            <a href="/markets" className="mt-3 block text-center text-xs font-bold text-teal hover:underline">
              View More Market Data →
            </a>
          </Card>

          {/* Top Sectors 3x3 */}
          <Card title="Top Sectors" subtitle="NIFTY 500">
            <div className="grid grid-cols-3 gap-1.5 text-center text-xs">
              <div className="rounded-md bg-up-bg p-2">
                <div className="text-[10px] font-bold text-text">IT</div>
                <div className="text-[10.5px] font-bold text-up">+1.25%</div>
              </div>
              <div className="rounded-md bg-up-bg p-2">
                <div className="text-[10px] font-bold text-text">FMCG</div>
                <div className="text-[10.5px] font-bold text-up">+0.68%</div>
              </div>
              <div className="rounded-md bg-up-bg p-2">
                <div className="text-[10px] font-bold text-text">PHARMA</div>
                <div className="text-[10.5px] font-bold text-up">+0.32%</div>
              </div>
              <div className="rounded-md bg-down-bg p-2">
                <div className="text-[10px] font-bold text-text">BANKING</div>
                <div className="text-[10.5px] font-bold text-down">-0.24%</div>
              </div>
              <div className="rounded-md bg-down-bg p-2">
                <div className="text-[10px] font-bold text-text">AUTO</div>
                <div className="text-[10.5px] font-bold text-down">-0.37%</div>
              </div>
              <div className="rounded-md bg-down-bg p-2">
                <div className="text-[10px] font-bold text-text">METAL</div>
                <div className="text-[10.5px] font-bold text-down">-0.68%</div>
              </div>
              <div className="rounded-md bg-down-bg p-2">
                <div className="text-[10px] font-bold text-text">REALTY</div>
                <div className="text-[10.5px] font-bold text-down">-1.02%</div>
              </div>
              <div className="rounded-md bg-down-bg p-2">
                <div className="text-[10px] font-bold text-text">MEDIA</div>
                <div className="text-[10.5px] font-bold text-down">-1.28%</div>
              </div>
              <div className="rounded-md bg-down-bg p-2">
                <div className="text-[10px] font-bold text-text">PSU BANK</div>
                <div className="text-[10.5px] font-bold text-down">-1.45%</div>
              </div>
            </div>
          </Card>

          {/* Trending Topics */}
          <Card title="Trending Topics">
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between rounded-lg bg-bg p-2">
                <span className="font-semibold text-text">1. Iran Peace Talks</span>
                <Badge tone="negative" className="px-1.5 py-0 text-[9px]">High Impact</Badge>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-bg p-2">
                <span className="font-semibold text-text">2. RBI Interest Rate Policy</span>
                <Badge tone="negative" className="px-1.5 py-0 text-[9px]">High Impact</Badge>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-bg p-2">
                <span className="font-semibold text-text">3. AI Leadership Changes</span>
                <Badge tone="warning" className="px-1.5 py-0 text-[9px]">Medium Impact</Badge>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-bg p-2">
                <span className="font-semibold text-text">4. FDI in E-commerce</span>
                <Badge tone="warning" className="px-1.5 py-0 text-[9px]">Medium Impact</Badge>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
