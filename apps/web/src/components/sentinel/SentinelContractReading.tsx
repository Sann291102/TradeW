import { cn } from '@tradew/ui';
import type { ContractLegRead, ContractWatch } from '@/lib/sentinel/types';

/**
 * What `/observe` read across the three panels above it.
 *
 * The counterpart of `SentinelChartReading` (which reports a sentinel-py
 * watch). This one reports the engine that runs the moment a market is
 * selected, and it exists because the three-chart panel spent its whole life
 * making a claim nobody could check: an index, a CALL and a PUT drawn side by
 * side, with only the index actually read.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 * It does not rank strikes, score contracts, or name a "best" one. It reads
 * ONE pair — the at-the-money CE and PE — and says so out loud, because a
 * reading that quietly covers one strike while sitting under a heading about
 * option behaviour would imply a ladder-wide search that never happened. The
 * strongest statement available here is which of the two legs MOVED with the
 * underlying, past tense, over stated bars. Ranking contracts by
 * attractiveness is a recommendation however it is phrased (Rule 2).
 */

const ALIGNMENT_LABEL: Record<NonNullable<ContractWatch['alignment']>, { text: string; tone: string }> = {
  'call-side-tracking': { text: 'Call leg moved with the underlying', tone: 'text-up' },
  'put-side-tracking': { text: 'Put leg moved with the underlying', tone: 'text-down' },
  'both-sides-bid': { text: 'Both legs bid — a volatility reading', tone: 'text-amber' },
  'both-sides-decaying': { text: 'Both legs decaying', tone: 'text-muted' },
  'index-flat': { text: 'Underlying has no direction on these bars', tone: 'text-muted' },
  mixed: { text: 'Neither leg tracked the underlying', tone: 'text-muted' },
};

function legFigure(leg: ContractLegRead | null, label: string) {
  if (!leg) {
    return { label, value: '—', detail: 'Not read', read: false };
  }
  if (!leg.series) {
    // Never rendered as 0.00% — see the type's docstring. A leg that could not
    // be read and a leg that did not move are different facts.
    return { label: `${label} ${leg.strike}`, value: 'unreadable', detail: leg.unavailableReason ?? '', read: false };
  }
  const { changePct, bars } = leg.series;
  return {
    label: `${label} ${leg.strike}`,
    value: `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`,
    detail: `${bars} bars`,
    read: true,
    up: changePct >= 0,
  };
}

export function SentinelContractReading({ watch }: { watch: ContractWatch }) {
  const alignment = watch.alignment ? ALIGNMENT_LABEL[watch.alignment] : null;

  const figures = [
    watch.index
      ? {
          label: watch.underlying,
          value: `${watch.index.changePct >= 0 ? '+' : ''}${watch.index.changePct.toFixed(2)}%`,
          detail: `${watch.index.bars} bars`,
          read: true,
          up: watch.index.changePct >= 0,
        }
      : { label: watch.underlying, value: 'unreadable', detail: 'No bars returned', read: false },
    legFigure(watch.ce, 'CALL'),
    legFigure(watch.pe, 'PUT'),
  ];

  return (
    <div className="mt-3.5 rounded-xl border border-border bg-bg p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[11px] font-bold uppercase tracking-wideTrack text-faint">Sentinel&apos;s reading</p>
        <p className="text-[10.5px] text-faint">
          {watch.strike != null ? `at-the-money pair · ${watch.strike}` : 'no option pair for this instrument'}
          {watch.expiry ? ` · ${watch.expiry}` : ''} · {watch.interval} bars
        </p>
      </div>

      {alignment && <p className={cn('mt-1.5 text-[12.5px] font-bold', alignment.tone)}>{alignment.text}</p>}

      <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {figures.map((f) => (
          <div key={f.label} className="rounded-lg border border-border bg-card px-2.5 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wideTrack text-faint">{f.label}</p>
            <p
              className={cn(
                'mt-0.5 font-mono text-[13px] font-bold',
                !f.read ? 'text-faint' : f.up ? 'text-up' : 'text-down',
              )}
            >
              {f.value}
            </p>
            <p className="mt-0.5 text-[10px] leading-snug text-faint">{f.detail}</p>
          </div>
        ))}
      </div>

      {watch.notes.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {watch.notes.map((note, i) => (
            <li key={i} className="text-[11px] leading-relaxed text-muted">
              {note}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2.5 text-[10px] leading-relaxed text-faint">
        Observation only. Sentinel reads the at-the-money pair to describe how the two legs behaved against the
        underlying — it does not compare strikes, rate contracts, or suggest holding either one.
      </p>
    </div>
  );
}
