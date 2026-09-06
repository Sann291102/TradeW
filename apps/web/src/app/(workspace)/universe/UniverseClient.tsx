'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@tradew/ui';
import { UniverseExplorer } from '@/components/universe/UniverseExplorer';
import { qk } from '@/lib/query/keys';
import {
  MARKET_LABELS,
  fetchUniverseStats,
  quoteCurrencyLabel,
  type UniverseInstrument,
} from '@/lib/universe';

/**
 * Universe workspace — the explorer plus the selected instrument's identity
 * card and a per-market freshness strip.
 *
 * Deliberately no prices anywhere on this page. It answers "what exists, where,
 * in what currency, and is the catalogue current" — the live-price question is
 * the Markets board's, served by a different pipeline at a different cadence.
 * Mixing them would put a polling price next to a catalogue row that has no
 * quote source, and the empty cells would read as an outage.
 */
export function UniverseClient() {
  const [selected, setSelected] = useState<UniverseInstrument | null>(null);

  const stats = useQuery({
    queryKey: qk.universe.stats(),
    queryFn: fetchUniverseStats,
    staleTime: 5 * 60_000,
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-xl font-bold text-text">Tradable universe</h1>
        <p className="mt-1 text-sm text-muted">
          Every instrument TradeW can quote, across five markets. Prices are always shown in the currency
          the venue quotes in; the paper account each market settles into is shown separately and nothing
          is converted without a live rate.
        </p>
      </header>

      {stats.data && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {stats.data.markets.map((m) => (
            <Card key={m.market} className="p-3">
              <div className="text-[11px] uppercase tracking-wider text-faint">
                {MARKET_LABELS[m.market].flag} {MARKET_LABELS[m.market].label}
              </div>
              <div className="mt-1 font-mono text-lg font-bold tabular-nums text-text">
                {m.active.toLocaleString()}
              </div>
              <div className="text-[11px] text-muted">
                {MARKET_LABELS[m.market].venues}
              </div>
              <div className="mt-1 text-[11px] text-faint">
                {/* The account currency, stated per market. This is the one place
                    a user is told that a UK trade settles in dollars. */}
                paper account: {m.accountCurrency}
                {m.delisted > 0 && ` · ${m.delisted.toLocaleString()} delisted`}
              </div>
            </Card>
          ))}
        </div>
      )}

      <UniverseExplorer onSelect={setSelected} />

      {selected && <InstrumentIdentityCard instrument={selected} onClose={() => setSelected(null)} />}

      {stats.data && stats.data.recentSyncs.length > 0 && (
        <details className="text-xs text-faint">
          <summary className="cursor-pointer">Catalogue freshness</summary>
          <ul className="mt-2 space-y-1">
            {stats.data.recentSyncs.slice(0, 8).map((run, i) => (
              <li key={`${run.source}-${run.startedAt}-${i}`} className="font-mono">
                {new Date(run.startedAt).toLocaleString()} · {run.source} · {run.status}
                {run.truncated && ' (truncated)'} · +{run.created} ~{run.updated} -{run.delisted}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * What a selected instrument actually is — identity and addressing, no prices.
 *
 * The currency block is the point of this card: it states the venue's quotation
 * currency and the settlement currency as two separate lines, and where they
 * differ it says so in words rather than leaving a reader to notice.
 */
function InstrumentIdentityCard({
  instrument,
  onClose,
}: {
  instrument: UniverseInstrument;
  onClose: () => void;
}) {
  return (
    <Card
      title={instrument.symbol}
      subtitle={instrument.displayName}
      actions={
        <button type="button" onClick={onClose} className="text-xs text-muted hover:text-text">
          Close
        </button>
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
        <Field label="Market">
          {MARKET_LABELS[instrument.market].flag} {MARKET_LABELS[instrument.market].label}
        </Field>
        <Field label="Exchange">
          {instrument.exchange}
          {instrument.mic && <span className="text-faint"> · {instrument.mic}</span>}
        </Field>
        <Field label="Status">{instrument.status}</Field>
        <Field label="Quoted in">{quoteCurrencyLabel(instrument.quoteCurrency)}</Field>
        <Field label="Settles in">{instrument.accountCurrency}</Field>
        <Field label="Identifier">{instrument.isin ?? '—'}</Field>
        {instrument.baseAsset && <Field label="Base">{instrument.baseAsset}</Field>}
        {instrument.quoteAsset && <Field label="Quote">{instrument.quoteAsset}</Field>}
        <Field label="Data source">
          {instrument.provider} · {instrument.providerSymbol}
        </Field>
        <Field label="Universe ref">
          <span className="font-mono">{instrument.ref}</span>
        </Field>
      </dl>

      {instrument.requiresFxConversion && (
        <p className="mt-3 rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">
          {instrument.exchange} quotes this instrument in {quoteCurrencyLabel(instrument.quoteCurrency)},
          but its paper account settles in {instrument.accountCurrency}. Prices shown anywhere in TradeW
          are the venue&apos;s own figures — they are never rescaled or converted. Any figure expressed in{' '}
          {instrument.accountCurrency} carries the exchange rate it was converted at.
        </p>
      )}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-faint">{label}</dt>
      <dd className="mt-0.5 text-text">{children}</dd>
    </div>
  );
}
