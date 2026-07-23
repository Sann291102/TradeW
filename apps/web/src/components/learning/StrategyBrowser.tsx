'use client';

import { useState } from 'react';
import { Badge, Button, Card, cn } from '@tradew/ui';
import type { Strategy } from '@/lib/learning/types';
import { ApplyStrategyDialog } from './ApplyStrategyDialog';

/**
 * The strategy catalogue on the Learning page, grouped by category, each row
 * carrying an Apply action that opens the market/expiry picker.
 *
 * Receives strategies as props from the server component that reads
 * `docs/learning/` — this component never touches the filesystem, so the
 * catalogue is inlined at build time rather than shipped as a fetch.
 */

const CATEGORY_LABEL: Record<string, string> = {
  directional: 'Directional — single leg',
  'vertical-spread': 'Vertical spreads',
  volatility: 'Volatility structures',
  'ratio-and-backspread': 'Ratio and backspread',
  'time-spread': 'Time spreads',
  'synthetic-and-arbitrage': 'Synthetic and arbitrage',
};

const TIER_TONE = {
  beginner: 'positive',
  intermediate: 'neutral',
  advanced: 'warning',
} as const;

/** Categories in teaching order, so the page reads as a progression. */
const CATEGORY_ORDER = ['directional', 'vertical-spread', 'volatility', 'ratio-and-backspread', 'time-spread', 'synthetic-and-arbitrage'];

export function StrategyBrowser({ strategies }: { strategies: Strategy[] }) {
  const [applying, setApplying] = useState<Strategy | null>(null);

  const categories = strategies
    .map((s) => s.category)
    .filter((c, i, all) => all.indexOf(c) === i)
    .sort(
    (a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99),
  );

  return (
    <>
      {categories.map((category) => {
        const inCategory = strategies.filter((s) => s.category === category);
        return (
          <Card key={category} title={CATEGORY_LABEL[category] ?? category} subtitle={`· ${inCategory.length}`}>
            <div className="grid gap-2">
              {inCategory.map((strategy) => (
                <div
                  key={strategy.id}
                  className={cn(
                    'flex flex-col gap-2 rounded-lg border border-border bg-bg p-3',
                    'transition-colors duration-micro hover:border-teal sm:flex-row sm:items-start sm:gap-3',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-semibold text-text">{strategy.name}</span>
                      <Badge tone={TIER_TONE[strategy.tier]} className="px-1.5 py-0 text-[9px]">
                        {strategy.tier}
                      </Badge>
                      <Badge tone={strategy.net === 'credit' ? 'positive' : 'neutral'} className="px-1.5 py-0 text-[9px]">
                        {strategy.net}
                      </Badge>
                      <span className="text-[10.5px] text-faint">
                        {strategy.legs.length} {strategy.legs.length === 1 ? 'leg' : 'legs'}
                      </span>
                    </div>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{strategy.summary}</p>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-faint">
                      <span>Max profit: {strategy.maxProfit}</span>
                      <span>Max loss: {strategy.maxLoss}</span>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => setApplying(strategy)}
                    aria-label={`Apply ${strategy.name} to a chart`}
                  >
                    Apply
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        );
      })}

      {applying && (
        <ApplyStrategyDialog
          strategyId={applying.id}
          strategyName={applying.name}
          legCount={applying.legs.length}
          onClose={() => setApplying(null)}
        />
      )}
    </>
  );
}
