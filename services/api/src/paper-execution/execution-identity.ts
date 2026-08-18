import { createHash } from 'node:crypto';

/**
 * The deterministic identity of one execution DECISION.
 *
 * ## Why the Sentinel run id is deliberately NOT in the key
 *
 * The obvious key is "one intent per Sentinel run". It is also wrong, and
 * wrong in the direction that costs money: `runAgentRun` mints a fresh
 * `runId` on every single call, and the execution loop calls `/execution/
 * evaluate` on a timer. Keying on the run would therefore produce a NEW key
 * every tick, so a side that stays in focus for twenty minutes would open a
 * position on every poll — the exact failure idempotency exists to prevent.
 * The run id is still recorded on the intent (it is the provenance link back
 * to the observation), it just cannot be part of the identity.
 *
 * The identity is the DECISION's content: this profile, this contract, this
 * direction, in this decision window. Two polls that reach the same conclusion
 * are the same decision and must collapse to one intent. Two polls that reach
 * different conclusions are different decisions and must not.
 *
 * ## Why there is a time window at all
 *
 * Without one, a profile could never re-enter a contract it had legitimately
 * exited earlier in the session — the key would collide forever and the
 * second, genuinely new decision would be silently dropped. With one, "the
 * same decision" means "the same conclusion, within the same window".
 *
 * The window is coarse relative to the poll interval (default 15 minutes
 * against a 60 s tick) and fine relative to a trading session, so it collapses
 * polling without collapsing the session. It is NOT the only protection:
 * `ExecutionProfile.maxOpenPositions` structurally prevents a second position
 * while one is open, and `Order.executionIntentId` is unique, so even a key
 * collision that slipped through could not produce two orders from one intent.
 * Three independent mechanisms, because a duplicate paper position invalidates
 * the outcome record this whole loop exists to produce.
 *
 * ## Why it is a hash and not a composite unique index
 *
 * A single `@unique` TEXT column is one index and one `P2002` to catch. The
 * composite alternative spreads the guarantee across six nullable columns,
 * where SQL's `NULL != NULL` quietly disables the constraint for any row with
 * an absent component — a uniqueness guarantee that silently stops guaranteeing
 * is worse than none.
 */

export const DEFAULT_DECISION_WINDOW_MINUTES = 15;

export interface DecisionIdentity {
  profileId: string;
  symbol: string;
  optionType: 'CE' | 'PE';
  strike: number;
  /** ISO date (YYYY-MM-DD) of the contract's expiry. */
  expiry: string;
  side: 'BUY' | 'SELL';
  /** When the decision was made. Bucketed, never used raw. */
  decidedAt: Date;
  windowMinutes?: number;
}

/**
 * IST calendar day and minute-of-day for an instant.
 *
 * The window must bucket by INDIAN market time, not UTC or the host's zone:
 * a UTC-bucketed window would roll over at 05:30 IST, mid-session on a normal
 * trading day, splitting one session's decisions across two day keys — and a
 * host in a third zone would bucket differently again, so the same decision
 * would key differently on two replicas.
 */
export function istParts(d: Date): { dayKey: string; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  // `en-CA` with hour12:false renders midnight as '24' in some ICU versions;
  // normalise so the first minute of the day buckets as 0, not 1440.
  const hour = Number(get('hour')) % 24;
  return {
    dayKey: `${get('year')}-${get('month')}-${get('day')}`,
    minuteOfDay: hour * 60 + Number(get('minute')),
  };
}

/** The canonical string the key hashes. Exported so a test can assert the
 *  components rather than only the digest, and so a mismatch is debuggable. */
export function decisionFingerprint(identity: DecisionIdentity): string {
  const windowMinutes = identity.windowMinutes ?? DEFAULT_DECISION_WINDOW_MINUTES;
  const { dayKey, minuteOfDay } = istParts(identity.decidedAt);
  const bucket = Math.floor(minuteOfDay / windowMinutes);

  // Fixed field order and an explicit separator: reordering or concatenating
  // without one lets two different decisions collide (e.g. strike 2450 + 0 CE
  // and strike 245 + 00 CE), which would drop a real trade as a duplicate.
  return [
    'v1',
    identity.profileId,
    identity.symbol.toUpperCase(),
    identity.expiry,
    // Normalised so 24900 and 24900.00 are one decision, not two.
    identity.strike.toFixed(2),
    identity.optionType,
    identity.side,
    dayKey,
    `w${windowMinutes}`,
    `b${bucket}`,
  ].join('|');
}

export function deriveIdempotencyKey(identity: DecisionIdentity): string {
  return createHash('sha256').update(decisionFingerprint(identity)).digest('hex');
}

/**
 * The canonical contract symbol the OMS resolves —
 * `UNDERLYING:YYYYMMDD:STRIKE:CE|PE`.
 *
 * This format is NOT invented here. It is the one `parseOptionSymbol` in
 * `sim/market-price.service.ts` already parses and `resolveOptionInstrument`
 * already looks up against the broker scrip master, which is precisely why the
 * execution loop needs no new instrument plumbing: it hands the existing OMS a
 * symbol shaped the way the existing OMS already understands.
 */
export function contractSymbol(input: {
  underlying: string;
  expiry: Date;
  strike: number;
  optionType: 'CE' | 'PE';
}): string {
  // The expiry is a calendar date, so it must be read in IST — reading it in
  // UTC turns a 20 Aug expiry into 19 Aug for any instant before 05:30 IST,
  // and the scrip-master lookup for a date the contract does not expire on
  // simply fails.
  const ymd = istParts(input.expiry).dayKey.replace(/-/g, '');
  // Strikes are listed in whole points on every Indian index chain; a decimal
  // here would not match the scrip master.
  return `${input.underlying.toUpperCase()}:${ymd}:${Math.round(input.strike)}:${input.optionType}`;
}
