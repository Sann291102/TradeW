/**
 * What the Lab could actually see at the moment it decided — or declined to.
 *
 * ## Why this is a first-class record and not a log line
 *
 * "70% confident" and "70% confident with three inputs missing" are different
 * states, and only the second should be treated with suspicion. Without this
 * record they are indistinguishable in the timeline and in every downstream
 * analysis, so an experiment run on a degraded feed would be averaged in
 * alongside one run on a complete one and would silently poison the evidence
 * the whole laboratory exists to accumulate.
 *
 * It also answers the question an administrator actually asks when nothing is
 * happening. "The Lab did nothing for two hours" and "the Lab could not see
 * anything for two hours" are different facts, and only one of them is a bug.
 *
 * ## It records absence, it never fills it
 *
 * This module has no fallback, no default and no substitution. That is the
 * standing rule of this codebase's market-data layer — the simulated fallback
 * was removed on 2026-07-26 precisely because a complete, confident-looking
 * observation built on invented candles is worse than no observation — and
 * `CandleMarketDataProvider`'s `UnavailableDiagnosis` exists because a
 * hardcoded diagnosis is "a guess that cannot ever be wrong out loud". An
 * absent input is reported as absent, with whatever the upstream actually said.
 */

export type SourceStatus = 'ok' | 'stale' | 'unavailable';

export interface SourceState {
  /** 'candles' | 'sentinel' | 'option-chain' | 'vix' | 'breadth' | 'news' | ... */
  name: string;
  status: SourceStatus;
  /** What was observed. Verbatim upstream text where there is any. Never composed. */
  detail: string;
}

export interface DataAvailability {
  checkedAt: string;
  sources: SourceState[];
  /** Market time of the newest bar the decision could see. */
  newestBarAt: string | null;
  /** Age of that bar at `checkedAt`. Null when there is no bar at all. */
  barAgeSeconds: number | null;
  /**
   * Optional inputs the snapshot could not supply. Named individually because
   * "the option chain was missing" and "the news feed was missing" support very
   * different conclusions about a decision.
   */
  absent: string[];
  /** True only when every REQUIRED source answered and the bars are fresh. */
  sufficient: boolean;
  /** The first reason it is not sufficient, or null. */
  insufficientReason: string | null;
}

export interface AvailabilityInput {
  checkedAt: Date;
  sources: SourceState[];
  newestBarAt: Date | null;
  /**
   * Whether the market session is open right now.
   *
   * THIS IS WHY THE STALENESS RULE IS NOT A SIMPLE AGE COMPARISON. Outside the
   * session the newest bar is always old — that is not a fault, it is the
   * market being shut, and reporting it as degraded would put the Lab in a
   * permanent alarm state every evening and every weekend. Bar age is only
   * evidence of a problem while the exchange is actually trading.
   */
  sessionOpen: boolean;
  /** Age beyond which a bar is stale DURING an open session. */
  maxBarAgeSeconds: number;
  /** Sources without which no decision may be made. */
  requiredSources: string[];
}

export function buildAvailability(input: AvailabilityInput): DataAvailability {
  const barAgeSeconds =
    input.newestBarAt === null
      ? null
      : Math.max(0, Math.round((input.checkedAt.getTime() - input.newestBarAt.getTime()) / 1000));

  const absent = input.sources.filter((s) => s.status !== 'ok').map((s) => s.name);

  let insufficientReason: string | null = null;

  for (const required of input.requiredSources) {
    const found = input.sources.find((s) => s.name === required);
    if (!found) {
      insufficientReason = `Required source "${required}" was not checked.`;
      break;
    }
    if (found.status !== 'ok') {
      insufficientReason = `Required source "${required}" is ${found.status}: ${found.detail}`;
      break;
    }
  }

  if (!insufficientReason && input.newestBarAt === null) {
    insufficientReason = 'No bar is available for this instrument.';
  }

  if (
    !insufficientReason &&
    input.sessionOpen &&
    barAgeSeconds !== null &&
    barAgeSeconds > input.maxBarAgeSeconds
  ) {
    insufficientReason =
      `The newest bar is ${barAgeSeconds}s old during an open session ` +
      `(limit ${input.maxBarAgeSeconds}s) — the feed is behind.`;
  }

  return {
    checkedAt: input.checkedAt.toISOString(),
    sources: input.sources,
    newestBarAt: input.newestBarAt?.toISOString() ?? null,
    barAgeSeconds,
    absent,
    sufficient: insufficientReason === null,
    insufficientReason,
  };
}
