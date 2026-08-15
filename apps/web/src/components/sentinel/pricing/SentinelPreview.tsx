'use client';

/**
 * A preview of what Sentinel actually puts on screen.
 *
 * ── WHY THIS SAMPLE IS SHAPED THE WAY IT IS ────────────────────────────────
 *
 * Two rules bind this component, and both are product constraints rather than
 * design taste:
 *
 * 1. NOTHING DIRECTIONAL. Sentinel is observation and education only — it never
 *    emits Buy/Sell/Entry/Target, and neither may a page selling it. The sample
 *    below is a STRUCTURE-and-RISK read: it describes what the market did and
 *    what that historically precedes, and stops there. A mock card showing a
 *    call/put bias would be advertising a product that does not exist and a
 *    compliance exposure on a financial platform.
 *
 * 2. VISIBLY AN ILLUSTRATION. It is labelled as one, and carries no symbol,
 *    price or timestamp that could be mistaken for a live read. Fabricated
 *    market data dressed as real output is the one thing a pre-payment page
 *    must not do.
 *
 * The figures are shape, not claims: they show the FORM of an observation —
 * a state, a confidence, the evidence beneath it — which is what a buyer is
 * actually trying to evaluate.
 */

/** The publication gate, as it is really implemented (four conditions, not one threshold). */
const GATE = [
  ['Adaptive confidence ≥ 70%', 'Weighted by how this pattern has actually behaved live.'],
  ['Every mandatory confirmation met', 'A rule left unmet blocks the read, however confident it is.'],
  ['No conflicting evidence', 'Disagreement between engines suppresses, it does not average out.'],
  ['≥ 2 independent corroborating sources', 'The detection that led cannot corroborate itself.'],
];

const PIPELINE = [
  ['Watch', 'Live candles for the instruments on your board, swept continuously — not only when a tab is open.'],
  ['Detect', 'Structure, liquidity, traps and your own behaviour, evaluated in parallel.'],
  ['Corroborate', 'Two independent reasoning engines, each citing the knowledge it used.'],
  ['Gate', 'Four conditions, all of which must hold, or nothing is surfaced at all.'],
  ['Explain', 'The card, and the evidence underneath it, in plain language.'],
];

export function SentinelPreview() {
  return (
    <div className="grid gap-5 lg:grid-cols-[1.05fr_1fr]">
      {/* ── The sample observation ─────────────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-[12px] font-bold text-text">A Sentinel observation</span>
          <span className="rounded-full border border-border2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
            Illustration
          </span>
        </div>

        {/* Tint tokens, not `/opacity` — see the note in TrialOffer.tsx. */}
        <div className="rounded-xl border border-amber bg-amber-bg p-4">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-amber" aria-hidden="true" />
            <span className="text-[11px] font-bold uppercase tracking-wide text-amber">Risk elevated</span>
          </div>

          <p className="mt-2.5 text-[13px] font-semibold leading-relaxed text-text">
            Price swept the session low and closed back above it. Liquidity was taken below support without
            acceptance beneath it.
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            Structurally this is a failed breakdown, not a trend continuation. Conditions like this one
            historically resolve quickly and in either direction — position size is the exposure that matters
            here, not the call.
          </p>

          <div className="mt-3.5 grid grid-cols-3 gap-2 border-t border-border pt-3">
            <Metric label="State" value="Sweep reclaimed" />
            <Metric label="Confidence" value="74%" />
            <Metric label="Composite risk" value="0.68" />
          </div>
        </div>

        <div className="mt-3 space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Evidence cited</p>
          {['Liquidity sweep — defined by the close, not the wick', 'Change of character vs. break of structure', 'Volatility expansion into the level'].map(
            (e) => (
              <p key={e} className="flex gap-2 text-[11.5px] leading-relaxed text-muted">
                <span className="text-teal" aria-hidden="true">
                  ·
                </span>
                {e}
              </p>
            ),
          )}
        </div>

        <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-faint">
          Observation only. Sentinel never issues a buy or sell instruction, never suggests an entry, target
          or stop, and is never a gate in the order flow.
        </p>
      </div>

      {/* ── How it gets there ──────────────────────────────────────────── */}
      <div className="space-y-5">
        <div className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
          <p className="text-[12px] font-bold text-text">How it gets there</p>
          <ol className="mt-3.5 space-y-3">
            {PIPELINE.map(([step, body], i) => (
              <li key={step} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-teal text-[10px] font-bold text-teal">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-[12.5px] font-semibold text-text">{step}</p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
          <p className="text-[12px] font-bold text-text">What it takes to be shown anything</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
            Most of what Sentinel notices, it never surfaces. All four must hold:
          </p>
          <ul className="mt-3 space-y-2.5">
            {GATE.map(([cond, why]) => (
              <li key={cond} className="flex gap-2.5">
                <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] bg-teal text-[9px] font-bold text-white">
                  ✓
                </span>
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-text">{cond}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-faint">{why}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</p>
      <p className="mt-0.5 text-[12.5px] font-bold text-text">{value}</p>
    </div>
  );
}
