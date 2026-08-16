'use client';

import { cn } from '@tradew/ui';
import type { MarketContextDimension } from '@/lib/sentinel/deriveContext';
import { formatCrore, netStance } from '@/lib/sentinel/nse';
import { useNseContext } from '@/lib/sentinel/useNseContext';

/**
 * Market Context — the structural read of the market, plus the exchange's own
 * institutional numbers.
 *
 * ── WHAT CHANGED, AND WHAT DID NOT ─────────────────────────────────────────
 * This panel previously carried a footer stating that FII/DII flow and market
 * breadth had no data source in TradeW. Two of the three are now real, from
 * NSE's own public publications (`services/api/src/nse`):
 *
 *   · FII/DII cash flow      → /nse/fii-dii       (end of day)
 *   · FII/DII derivatives OI → /nse/participant-oi (end of day)
 *   · Advance/decline breadth → /nse/breadth      (live through the session)
 *
 * This did NOT come from the Dhan token, and it could not have: DhanHQ v2 has
 * no participant-wise or cash-flow endpoint anywhere in its surface. Broker
 * data and exchange data are different publications.
 *
 * ── THE ONE THING THIS PANEL MUST KEEP SAYING ──────────────────────────────
 * FII/DII is an END-OF-DAY publication. There is no intraday version — the
 * exchange does not compute one and no vendor sells one. So during market
 * hours these rows describe the PREVIOUS session, and each is rendered with
 * that session's date rather than under the panel's "Live" header. A dated row
 * is the difference between reporting institutional flow and implying that
 * today's institutions have already moved.
 *
 * The economic calendar is still absent, and still said out loud. NSE publishes
 * a corporate calendar (which companies report when), not a macro one — nothing
 * free gives "US CPI, today", so nothing here claims to.
 */
export function MarketContextRail({
  tags,
  dimensions,
  live,
}: {
  tags: string[];
  dimensions: MarketContextDimension[];
  /** The exchange session is open, so the STRUCTURAL readings are current. */
  live: boolean;
}) {
  const { flow, breadth, positioning, loading, degraded } = useNseContext();

  const fii = flow?.rows.find((r) => r.category === 'FII') ?? null;
  const dii = flow?.rows.find((r) => r.category === 'DII') ?? null;

  // Index futures long vs short is the positioning fact a cash number cannot
  // express: an institution can be a net cash buyer while heavily short the
  // index. Reported as the raw ratio, with no reading attached to it.
  const fiiOi = positioning?.rows.find((r) => /^FII/i.test(r.participant)) ?? null;
  const fiiSkew =
    fiiOi?.futureIndexLong != null && fiiOi.futureIndexShort != null && fiiOi.futureIndexLong > 0
      ? fiiOi.futureIndexShort / fiiOi.futureIndexLong
      : null;

  return (
    <section className="flex h-full flex-col rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-bold text-text">Market Context</h2>
        <span className={cn('flex items-center gap-1.5 text-[10.5px]', live ? 'text-teal' : 'text-faint')}>
          {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" aria-hidden />}
          {live ? 'Live' : 'Market closed'}
        </span>
      </div>

      {tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {tags.slice(0, 4).map((t) => (
            <span key={t} className="rounded-lg bg-teal-bg px-2 py-0.5 text-[10.5px] font-semibold text-teal">
              {t}
            </span>
          ))}
        </div>
      )}

      {dimensions.length === 0 ? (
        <p className="py-2 text-[11.5px] leading-relaxed text-faint">
          No market read yet. Sentinel fills this in once it has observed the session.
        </p>
      ) : (
        <dl className="flex flex-col gap-1.5">
          {dimensions.map((d) => (
            <Row key={d.label} label={d.label} known={d.known}>
              {d.value}
            </Row>
          ))}
        </dl>
      )}

      {/* ── the exchange's own numbers ─────────────────────────────────────
          Separated by a rule and given their own dated heading, because they
          are a different KIND of claim from everything above: those are
          Sentinel's reading of the live session, these are NSE's publication
          about a finished one. Merging them into one list would put a
          previous-session figure under a "Live" header. */}
      <div className="mt-3 border-t border-border pt-3">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <p className="text-[9.5px] font-bold uppercase tracking-wideTrack text-faint">Institutional activity</p>
          {flow?.session && <span className="text-[10px] text-faint">{flow.session} · NSE</span>}
        </div>

        {loading && !flow && !breadth ? (
          <p className="text-[11.5px] text-faint">Reading NSE…</p>
        ) : (
          <dl className="flex flex-col gap-1.5">
            {/* Breadth is the one genuinely live figure here, so it leads. */}
            <Row label="Breadth" known={breadth?.advances != null}>
              {breadth?.advances != null && breadth.declines != null
                ? `${breadth.advances} advancing · ${breadth.declines} declining${
                    breadth.unchanged ? ` · ${breadth.unchanged} flat` : ''
                  }`
                : 'Not read'}
            </Row>

            <FlowRow label="FII / FPI cash" net={fii?.net ?? null} />
            <FlowRow label="DII cash" net={dii?.net ?? null} />

            <Row label="FII index futures" known={fiiSkew != null}>
              {fiiSkew != null && fiiOi
                ? `${fiiOi.futureIndexLong!.toLocaleString('en-IN')} long · ${fiiOi.futureIndexShort!.toLocaleString(
                    'en-IN',
                  )} short (${fiiSkew.toFixed(1)}× short)`
                : 'Not published for the last sessions yet'}
            </Row>
          </dl>
        )}

        {degraded && (
          <p className="mt-2 text-[10px] leading-relaxed text-amber">
            Some NSE figures could not be refreshed just now — anything shown above is the last reading that loaded.
          </p>
        )}
      </div>

      {/*
        Still named rather than silently dropped. The rule from the first pass
        holds: a reader should be able to tell "Sentinel measured this" from
        "nothing in TradeW can see this".
      */}
      <p className="mt-auto pt-3 text-[10px] leading-relaxed text-faint">
        Cash and derivatives figures are NSE end-of-day publications for the session shown — there is no intraday
        equivalent. The macro calendar (CPI, policy decisions) has no free source and is not shown.
      </p>
    </section>
  );
}

function Row({ label, known, children }: { label: string; known?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn('mt-1.5 h-1 w-1 shrink-0 rounded-full', known ? 'bg-teal' : 'bg-border2')} aria-hidden />
      <dt className="shrink-0 text-[11.5px] text-muted">{label}:</dt>
      <dd className={cn('min-w-0 text-[11.5px] leading-snug', known ? 'font-semibold text-text' : 'italic text-faint')}>
        {children}
      </dd>
    </div>
  );
}

/**
 * One participant's net cash position for the session.
 *
 * "Net buyer"/"net seller" is a description of a completed, published number —
 * it says what institutions DID, never what anyone should do, and carries no
 * implication for direction. That distinction is the reason the label is
 * `buyer`/`seller` (what happened) rather than `bullish`/`bearish` (a read).
 */
function FlowRow({ label, net }: { label: string; net: number | null }) {
  const stance = netStance(net);
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={cn(
          'mt-1.5 h-1 w-1 shrink-0 rounded-full',
          stance === 'buyer' ? 'bg-up' : stance === 'seller' ? 'bg-down' : stance ? 'bg-teal' : 'bg-border2',
        )}
        aria-hidden
      />
      <dt className="shrink-0 text-[11.5px] text-muted">{label}:</dt>
      <dd
        className={cn(
          'min-w-0 text-[11.5px] font-semibold leading-snug',
          stance === 'buyer' ? 'text-up' : stance === 'seller' ? 'text-down' : 'italic font-medium text-faint',
        )}
      >
        {stance == null
          ? 'Not published'
          : `Net ${stance === 'flat' ? 'flat' : stance} ${formatCrore(net)}`}
      </dd>
    </div>
  );
}
