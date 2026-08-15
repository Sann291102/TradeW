'use client';

/**
 * What Sentinel does, as it is actually built.
 *
 * Binding rule, inherited from the landing page: nothing that has not been
 * built may be described as though it ships today, and every figure traces to
 * something real. The counts below come from the seeded concept ontology and
 * the citation corpus, not from marketing.
 *
 * Anything genuinely not built yet is stated as such rather than omitted — a
 * buyer discovering the gap after paying is the outcome this avoids.
 */
const FEATURES: { title: string; body: string }[] = [
  {
    title: 'A continuous watch, not a refresh button',
    body: 'Sentinel sweeps live candles for the instruments on your board throughout the session. A setup that forms and resolves between two glances still happened, and is still recorded.',
  },
  {
    title: 'Trap and structure detection',
    body: 'Bull traps, fake breakouts, liquidity sweeps and failed breakdowns — evaluated against market structure, where a sweep is defined by the close rather than the wick.',
  },
  {
    title: 'An eight-factor risk radar',
    body: 'Volatility, momentum, trap probability, structure and exposure scored together into a composite read, with every contributing factor legible on its own.',
  },
  {
    title: 'It watches your behaviour too',
    body: 'Revenge-trading patterns, size drift after a loss, and over-trading into chop are observed in parallel with the market. Emotional risk is banded, never scored to a false precision.',
  },
  {
    title: 'Your own strategy, watched for you',
    body: 'Write a strategy in plain text. A deterministic parser turns it into rules and watches live candles against them — idle, forming, then confirmed — and tells you when your conditions are met.',
  },
  {
    title: 'Reasoning you can audit',
    body: 'Two independent engines reason over a citable knowledge base of 66 market concepts and 273 semantic relations. A verdict that cannot cite what it used is dropped, not flagged.',
  },
  {
    title: 'Backtesting on real market data',
    body: 'Strategy rules replay against real historical candles from the live feed, not a simulator — the difference between a result you can trust and one that flatters itself.',
  },
  {
    title: 'It reaches you when the tab is closed',
    body: 'Observations that clear the publication gate persist as notifications rather than living only as long as a browser tab.',
  },
];

/** Stated plainly, because a buyer finding these out afterwards is worse. */
const NOT_INCLUDED = [
  'Sentinel never places, modifies or cancels an order, and is never a gate in the order flow.',
  'No buy, sell, entry, target or stop is ever issued — the vocabulary is enforced on the output, not just requested in a prompt.',
  'It is not a signal service, and it does not predict prices.',
];

export function FeatureList() {
  return (
    <div className="space-y-6">
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="flex gap-3">
            <span
              className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-teal"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-[13px] font-bold text-text">{f.title}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">{f.body}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
          What Sentinel is not
        </p>
        <ul className="mt-2.5 space-y-1.5">
          {NOT_INCLUDED.map((n) => (
            <li key={n} className="text-[12px] leading-relaxed text-muted">
              {n}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
