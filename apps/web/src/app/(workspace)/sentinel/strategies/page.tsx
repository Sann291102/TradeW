'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { StrategyCatalogue } from '@/components/sentinel/StrategyCatalogue';
import { StrategyWorkspace } from '@/components/sentinel/StrategyWorkspace';

/**
 * The strategy workspace page: Catalogue → Adopt → Configure → Watch → Focus
 * → Feed → Performance.
 *
 * The whole workflow in one place, and every panel below the catalogue is
 * rendered from a single strategy contract. Nothing on this page knows which
 * strategy is selected beyond its id — the components are identical for an
 * EMA reclaim and a liquidity sweep.
 *
 * Sentinel's boundary is unchanged here: the user adopts, the user configures,
 * the user owns the strategy. Sentinel observes it and explains what state it
 * is in. Nothing on this page ranks strategies or tells anyone to trade.
 */

interface StrategyRow {
  id: string;
  name: string;
  status: string;
}

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<StrategyRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  async function refresh(selectId?: string) {
    const rows = (await api('/sentinel-py/strategies')) as StrategyRow[];
    const active = rows.filter((row) => row.status !== 'archived');
    setStrategies(active);
    setSelected((current) => selectId ?? current ?? active[0]?.id ?? null);
  }

  useEffect(() => {
    refresh().catch(() => setStrategies([]));
  }, []);

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-[22px] font-extrabold tracking-tightTrack text-text">My strategies</h1>
        <p className="mt-1 text-[12.5px] text-muted">
          Adopt a definition, make it yours, and Sentinel will watch it and explain what it sees.
        </p>
      </header>

      {(strategies?.length ?? 0) > 0 && (
        <nav className="flex flex-wrap gap-2">
          {strategies!.map((strategy) => (
            <button
              key={strategy.id}
              type="button"
              onClick={() => setSelected(strategy.id)}
              className={
                strategy.id === selected
                  ? 'rounded-md border border-fg/30 bg-bg2 px-3 py-1.5 text-xs text-fg'
                  : 'rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:bg-bg2'
              }
            >
              {strategy.name}
            </button>
          ))}
        </nav>
      )}

      {selected && <StrategyWorkspace strategyId={selected} />}

      <section>
        <h2 className="mb-3 text-sm font-medium text-fg">Strategy catalogue</h2>
        <StrategyCatalogue onAdopted={(id) => refresh(id)} />
      </section>
    </div>
  );
}
