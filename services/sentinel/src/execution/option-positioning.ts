import type { OptionChainEntry } from '@tradew/types';
import { inferStrikeStep, nearestListedStrike } from './strike-candidates';

/**
 * Option-chain POSITIONING — the battlefield map, not a direction.
 *
 * ## What this adds that `readOptionChain` does not
 *
 * `readOptionChain` (market-intelligence.service.ts) answers "where is the OI"
 * — PCR, max pain, the heaviest call strike above spot and the heaviest put
 * strike below it. Those are STATIC facts about a single moment, and a static
 * fact about positioning is the weakest thing the chain has to say. A 66-lakh
 * call wall that is being ADDED to and a 66-lakh call wall that is being
 * UNWOUND look identical in that read and mean opposite things.
 *
 * This module reads the same chain with the previous close's open interest
 * beside it, which turns every level into a level plus a verb:
 *
 *   · per strike, per side: ΔOI, Δpremium, and the four-quadrant read those
 *     two signs produce (`OIAction`);
 *   · a support/resistance LADDER, each rung tagged `reinforcing`, `eroding`
 *     or `steady` by what its defenders did today;
 *   · MIGRATION — whether the whole structure is moving up the strike grid,
 *     down it, compressing toward spot or expanding away from it;
 *   · a directional judgement that can only ever SUBTRACT from a read the rest
 *     of the engine already published (`judgePositioning`);
 *   · a conditional LADDER of levels between spot and a projected level, each
 *     rung carrying what would confirm it and what would invalidate it
 *     (`buildLadder`).
 *
 * ## The one rule this module is built around
 *
 * **Positioning is a map, not a forecast.** Every output here describes where
 * participants have money at risk and what they did with it today. None of it
 * says where price will go, and the judgement it does produce is expressed as
 * agreement or disagreement with a direction someone else already derived —
 * never as a direction of its own. That is why `judgePositioning` takes the
 * side as an argument: it has no way to invent one.
 *
 * ## Missing ΔOI is never a conflict
 *
 * A feed that publishes no previous-day OI (a simulated provider, a newly
 * listed strike, a bridge serving a cached body from before the field existed)
 * makes three of the four judgement signals unknowable. Those signals then
 * contribute ZERO rather than a negative — `hasOIChange` is false, the
 * judgement degrades to the one signal that survives, and by construction the
 * surviving signal alone cannot reach the conflict threshold. Absence of data
 * is reported as absence of data; it never becomes a refusal wearing
 * evidence's clothes.
 *
 * ## Compliance
 *
 * Every string this module can emit reaches a trader-facing surface through
 * the options-chain agent. They are written to survive `vocabulary.ts`
 * unchanged: no directive verbs, no "target", no bare "short". A level is
 * "defended", a move through it is "accepted" or "rejected", and the top of a
 * ladder is a "projected level".
 */

// ---------------------------------------------------------------------------
// The four-quadrant read
// ---------------------------------------------------------------------------

/**
 * What one option leg's day did, from the signs of ΔOI and Δpremium.
 *
 * The classic matrix, named for what the positions are rather than for the
 * jargon: rising OI with a rising premium is money coming in on the long side;
 * rising OI with a falling premium is money coming in on the WRITING side, and
 * on an index chain the writer is the one who defends a level.
 */
export type OIAction =
  /** OI ↑, premium ↑ — fresh buyers. */
  | 'long-buildup'
  /** OI ↑, premium ↓ — fresh writing. The level is being defended harder. */
  | 'fresh-writing'
  /** OI ↓, premium ↑ — writers covering. The defence is being removed. */
  | 'covering'
  /** OI ↓, premium ↓ — buyers leaving. */
  | 'long-unwinding'
  /** Neither moved enough to read. */
  | 'flat'
  /** No previous OI or no previous close was published for this leg. */
  | 'unknown';

/** Plain-language label for an action, safe for trader-facing text. */
export function describeOIAction(action: OIAction): string {
  switch (action) {
    case 'long-buildup':
      return 'fresh buying';
    case 'fresh-writing':
      return 'fresh writing';
    case 'covering':
      return 'writers covering';
    case 'long-unwinding':
      return 'buyers unwinding';
    case 'flat':
      return 'little change';
    default:
      return 'not readable';
  }
}

/**
 * Fraction of a leg's own open interest that ΔOI must clear to be read as a
 * change at all.
 *
 * Index chains print small OI adjustments on every strike all day. Without a
 * floor, a 0.3% drift on a 70-lakh wall is reported with the same vocabulary
 * as a genuine unwind, and the ladder's `reinforcing`/`eroding` tags become
 * noise that changes on every poll.
 */
const OI_CHANGE_FLOOR_PCT = 0.03;
/** Same idea for the premium: a paisa of drift is not a directional move. */
const PREMIUM_CHANGE_FLOOR_PCT = 0.02;

function readAction(oi: number, prevOi: number | null, ltp: number | null, prevClose: number | null): OIAction {
  if (prevOi === null || !Number.isFinite(prevOi)) return 'unknown';
  const deltaOi = oi - prevOi;
  const oiFloor = Math.max(1, Math.abs(prevOi) * OI_CHANGE_FLOOR_PCT);
  if (Math.abs(deltaOi) < oiFloor) return 'flat';

  // The premium half can be missing on its own — an unpriced leg with a real
  // OI change. The OI direction is still worth half the read, so rather than
  // returning `unknown` and discarding it, fall back to the reading that does
  // not depend on price: OI up is money arriving, OI down is money leaving.
  // Writing vs buying is the part that needs the premium, so the fallback
  // deliberately picks the DEFENSIVE reading for a rise (that is what an index
  // chain's marginal OI overwhelmingly is) and the neutral one for a fall.
  if (ltp === null || prevClose === null || !Number.isFinite(ltp) || !Number.isFinite(prevClose) || prevClose <= 0) {
    return deltaOi > 0 ? 'fresh-writing' : 'covering';
  }

  const deltaPrice = ltp - prevClose;
  if (Math.abs(deltaPrice) < prevClose * PREMIUM_CHANGE_FLOOR_PCT) {
    return deltaOi > 0 ? 'fresh-writing' : 'covering';
  }
  if (deltaOi > 0) return deltaPrice > 0 ? 'long-buildup' : 'fresh-writing';
  return deltaPrice > 0 ? 'covering' : 'long-unwinding';
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/** One strike, both legs, with today's change beside today's total. */
export interface StrikePositioning {
  strike: number;
  callOI: number;
  putOI: number;
  /** Null when the feed published no previous OI for that leg. */
  callOIChange: number | null;
  putOIChange: number | null;
  callPremiumChange: number | null;
  putPremiumChange: number | null;
  callAction: OIAction;
  putAction: OIAction;
  /**
   * Put OI over call OI AT THIS STRIKE — not the chain's PCR.
   *
   * Strike-level PCR answers a different question from the aggregate: it says
   * which side of THIS level participants are positioned on, which is the
   * question a level-by-level read is made of. Null when the call leg carries
   * no OI, because the ratio is then unbounded rather than infinite-and-therefore
   * meaningful.
   */
  pcr: number | null;
  /** This strike's share of the chain's total OI on each side, 0..1. */
  callShare: number;
  putShare: number;
}

/** How the defenders of one level behaved today. */
export type LevelDefence = 'reinforcing' | 'eroding' | 'steady' | 'unknown';

/** One rung of the support/resistance ladder. */
export interface PositioningLevel {
  strike: number;
  role: 'support' | 'resistance';
  /** Share of the defending side's total chain OI that sits here, 0..1. */
  weight: number;
  /** OI on the defending side (calls for a resistance, puts for a support). */
  defendingOI: number;
  /** Today's change on the defending side. Null when unreadable. */
  defendingOIChange: number | null;
  defence: LevelDefence;
  /** Distance from spot in strike steps, always positive. */
  stepsFromSpot: number;
  note: string;
}

/**
 * Where the whole structure moved today.
 *
 * Measured as the shift in the OI-weighted centroid of each side between the
 * previous close and now, expressed in strike steps. Centroids rather than
 * wall positions because a wall is one strike and jumps discontinuously — the
 * centroid moves continuously and therefore says something on a day when the
 * heaviest strike has not changed hands yet.
 */
export interface PositioningMigration {
  direction: 'up' | 'down' | 'compressing' | 'expanding' | 'none' | 'unknown';
  /** Call OI centroid shift in strike steps, signed. Null when unreadable. */
  callShiftSteps: number | null;
  putShiftSteps: number | null;
  note: string;
}

export interface OptionPositioningRead {
  spot: number;
  frontExpiry: Date;
  strikesAnalysed: number;
  strikeStep: number | null;
  /** The listed strike nearest spot. */
  atmStrike: number | null;
  /** Chain-wide put OI over call OI. */
  pcr: number;
  /**
   * True when enough legs published a previous OI to read change at all.
   *
   * Every consumer must branch on this rather than on a null ΔOI: a chain
   * where one strike is unreadable is a usable chain, and a chain where none
   * is readable must never be described in the vocabulary of change.
   */
  hasOIChange: boolean;
  /** Fraction of legs that carried a previous OI, 0..1. */
  oiChangeCoverage: number;
  strikes: StrikePositioning[];
  /** Nearest first, walking down from spot. */
  supports: PositioningLevel[];
  /** Nearest first, walking up from spot. */
  resistances: PositioningLevel[];
  /**
   * The strike where the two sides are most evenly matched near spot — the
   * level that is neither support nor resistance yet, and therefore the one
   * whose acceptance or rejection is informative.
   */
  pivot: number | null;
  migration: PositioningMigration;
  /** One line, trader-safe, describing the map. */
  summary: string;
}

/** How many rungs of each ladder to carry. Four covers a week of index range. */
const LADDER_DEPTH = 4;

/**
 * Read positioning from a front-expiry chain.
 *
 * `entries` must already be narrowed to one expiry — mixing expiries makes
 * every aggregate here meaningless in exactly the way it makes PCR meaningless.
 * Returns null when the chain is empty or spot is unusable, never a read with
 * fabricated zeroes.
 */
export function readOptionPositioning(input: {
  symbol: string;
  spot: number;
  /** Front-expiry entries. Order does not matter; they are sorted here. */
  entries: OptionChainEntry[];
}): OptionPositioningRead | null {
  const { symbol, spot } = input;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const entries = [...input.entries].sort((a, b) => a.strike - b.strike);
  if (entries.length === 0) return null;

  const frontExpiry = entries.reduce(
    (earliest, e) => (e.expiry.getTime() < earliest.getTime() ? e.expiry : earliest),
    entries[0].expiry,
  );
  const step = inferStrikeStep(symbol, entries.map((e) => e.strike));
  const atmStrike = nearestListedStrike(entries.map((e) => e.strike), spot);

  const totalCallOI = entries.reduce((s, e) => s + e.callOI, 0);
  const totalPutOI = entries.reduce((s, e) => s + e.putOI, 0);
  if (totalCallOI <= 0) return null;

  let legsWithPrev = 0;
  const strikes: StrikePositioning[] = entries.map((e) => {
    const callPrevOI = numberOrNull(e.callPrevOI);
    const putPrevOI = numberOrNull(e.putPrevOI);
    if (callPrevOI !== null) legsWithPrev++;
    if (putPrevOI !== null) legsWithPrev++;
    const callLtp = numberOrNull(e.callLtp);
    const putLtp = numberOrNull(e.putLtp);
    const callPrevClose = numberOrNull(e.callPrevClose);
    const putPrevClose = numberOrNull(e.putPrevClose);
    return {
      strike: e.strike,
      callOI: e.callOI,
      putOI: e.putOI,
      callOIChange: callPrevOI === null ? null : e.callOI - callPrevOI,
      putOIChange: putPrevOI === null ? null : e.putOI - putPrevOI,
      callPremiumChange: callLtp !== null && callPrevClose !== null ? callLtp - callPrevClose : null,
      putPremiumChange: putLtp !== null && putPrevClose !== null ? putLtp - putPrevClose : null,
      callAction: readAction(e.callOI, callPrevOI, callLtp, callPrevClose),
      putAction: readAction(e.putOI, putPrevOI, putLtp, putPrevClose),
      pcr: e.callOI > 0 ? e.putOI / e.callOI : null,
      callShare: totalCallOI > 0 ? e.callOI / totalCallOI : 0,
      putShare: totalPutOI > 0 ? e.putOI / totalPutOI : 0,
    };
  });

  const oiChangeCoverage = entries.length > 0 ? legsWithPrev / (entries.length * 2) : 0;
  // Half the legs is the floor for describing the chain in the vocabulary of
  // change. Below it the sample is a handful of strikes, and a ladder tagged
  // from a handful of strikes is a ladder tagged from whichever strikes the
  // feed happened to complete.
  const hasOIChange = oiChangeCoverage >= 0.5;

  const resistances = buildLevelLadder(strikes, spot, step, 'resistance', totalCallOI, hasOIChange);
  const supports = buildLevelLadder(strikes, spot, step, 'support', totalPutOI, hasOIChange);
  const migration = readMigration(strikes, step, hasOIChange);
  const pivot = findPivot(strikes, spot, step);

  const pcr = totalPutOI / totalCallOI;
  return {
    spot,
    frontExpiry,
    strikesAnalysed: entries.length,
    strikeStep: step,
    atmStrike,
    pcr,
    hasOIChange,
    oiChangeCoverage,
    strikes,
    supports,
    resistances,
    pivot,
    migration,
    summary: summarise({ spot, pcr, supports, resistances, pivot, migration, hasOIChange }),
  };
}

function numberOrNull(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The heaviest levels on one side, nearest to spot first.
 *
 * Ranked by OI to pick WHICH strikes matter, then re-ordered by distance so the
 * consumer walks them in the order price would meet them. Both orderings are
 * needed and they are not the same: the heaviest resistance in the chain is
 * frequently not the first one price has to get through, and a ladder that
 * listed it first would describe a journey in the wrong sequence.
 */
function buildLevelLadder(
  strikes: StrikePositioning[],
  spot: number,
  step: number | null,
  role: 'support' | 'resistance',
  totalOI: number,
  hasOIChange: boolean,
): PositioningLevel[] {
  const side = role === 'resistance' ? 'call' : 'put';
  const inRange = strikes.filter((s) => (role === 'resistance' ? s.strike > spot : s.strike < spot));
  const defendingOI = (s: StrikePositioning) => (side === 'call' ? s.callOI : s.putOI);
  const defendingChange = (s: StrikePositioning) => (side === 'call' ? s.callOIChange : s.putOIChange);
  const action = (s: StrikePositioning) => (side === 'call' ? s.callAction : s.putAction);

  const heaviest = [...inRange]
    .filter((s) => defendingOI(s) > 0)
    .sort((a, b) => defendingOI(b) - defendingOI(a))
    .slice(0, LADDER_DEPTH)
    .sort((a, b) => (role === 'resistance' ? a.strike - b.strike : b.strike - a.strike));

  return heaviest.map((s) => {
    const change = defendingChange(s);
    const act = action(s);
    const defence: LevelDefence = !hasOIChange || change === null || act === 'unknown'
      ? 'unknown'
      : act === 'flat'
        ? 'steady'
        : change > 0
          ? 'reinforcing'
          : 'eroding';
    const steps = step && step > 0 ? Math.abs(s.strike - spot) / step : 0;
    return {
      strike: s.strike,
      role,
      weight: totalOI > 0 ? defendingOI(s) / totalOI : 0,
      defendingOI: defendingOI(s),
      defendingOIChange: change,
      defence,
      stepsFromSpot: Number(steps.toFixed(2)),
      note: levelNote(role, s.strike, defence, change, act),
    };
  });
}

function levelNote(
  role: 'support' | 'resistance',
  strike: number,
  defence: LevelDefence,
  change: number | null,
  action: OIAction,
): string {
  const who = role === 'resistance' ? 'Call writers' : 'Put writers';
  const magnitude = change === null ? '' : ` (${change > 0 ? '+' : ''}${formatOI(change)})`;
  switch (defence) {
    case 'reinforcing':
      return `${who} added at ${strike}${magnitude} — ${describeOIAction(action)}, so the level is being defended harder than yesterday.`;
    case 'eroding':
      return `${who} reduced at ${strike}${magnitude} — ${describeOIAction(action)}, so the defence of the level is thinner than yesterday.`;
    case 'steady':
      return `${who} at ${strike} are neither adding nor reducing materially — the level stands where it stood.`;
    default:
      return `${who} hold ${formatOI(change === null ? 0 : change)} at ${strike}; today's change was not published, so the level's size is known and its direction is not.`;
  }
}

function formatOI(oi: number): string {
  const abs = Math.abs(oi);
  if (abs >= 1e7) return `${(oi / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${(oi / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${(oi / 1e3).toFixed(1)}K`;
  return `${Math.round(oi)}`;
}

/**
 * Whether the structure moved up or down the strike grid today.
 *
 * Both centroids up = the whole book has been re-laid higher: writers are
 * defending higher resistance and are willing to write puts at higher strikes.
 * Both down is the mirror. The two mixed cases are genuinely different from
 * "no migration" and are named rather than collapsed: puts up with calls down
 * is a range tightening around spot, calls up with puts down is a range
 * opening out, and neither is a directional statement.
 */
function readMigration(
  strikes: StrikePositioning[],
  step: number | null,
  hasOIChange: boolean,
): PositioningMigration {
  if (!hasOIChange || !step || step <= 0) {
    return {
      direction: 'unknown',
      callShiftSteps: null,
      putShiftSteps: null,
      note: 'Previous-day open interest was not published for enough of the chain, so migration cannot be read.',
    };
  }
  const callShift = centroidShift(strikes, 'call');
  const putShift = centroidShift(strikes, 'put');
  if (callShift === null || putShift === null) {
    return {
      direction: 'unknown',
      callShiftSteps: null,
      putShiftSteps: null,
      note: 'Open interest on one side summed to zero either today or at the previous close, so migration cannot be read.',
    };
  }
  const callSteps = Number((callShift / step).toFixed(3));
  const putSteps = Number((putShift / step).toFixed(3));
  // A tenth of a strike step. Below it the centroid has not moved by an amount
  // an index chain can distinguish from rounding on individual strikes.
  const floor = 0.1;
  const up = (v: number) => v >= floor;
  const down = (v: number) => v <= -floor;

  let direction: PositioningMigration['direction'] = 'none';
  if (up(callSteps) && up(putSteps)) direction = 'up';
  else if (down(callSteps) && down(putSteps)) direction = 'down';
  else if (down(callSteps) && up(putSteps)) direction = 'compressing';
  else if (up(callSteps) && down(putSteps)) direction = 'expanding';
  else if (up(callSteps) || up(putSteps)) direction = 'up';
  else if (down(callSteps) || down(putSteps)) direction = 'down';

  return {
    direction,
    callShiftSteps: callSteps,
    putShiftSteps: putSteps,
    note: migrationNote(direction, callSteps, putSteps),
  };
}

function migrationNote(direction: PositioningMigration['direction'], call: number, put: number): string {
  const detail = `call OI centre ${call >= 0 ? '+' : ''}${call.toFixed(2)} steps, put OI centre ${put >= 0 ? '+' : ''}${put.toFixed(2)} steps`;
  switch (direction) {
    case 'up':
      return `Positioning migrated up the strike grid today (${detail}) — the levels being defended are higher than they were at yesterday's close.`;
    case 'down':
      return `Positioning migrated down the strike grid today (${detail}) — the levels being defended are lower than they were at yesterday's close.`;
    case 'compressing':
      return `Positioning compressed toward spot today (${detail}) — both sides moved in, which narrows the range participants are defending rather than pointing at a direction.`;
    case 'expanding':
      return `Positioning expanded away from spot today (${detail}) — both sides moved out, which widens the defended range rather than pointing at a direction.`;
    default:
      return `Positioning has not migrated materially today (${detail}).`;
  }
}

/** OI-weighted centroid now, minus the same centroid at the previous close. */
function centroidShift(strikes: StrikePositioning[], side: 'call' | 'put'): number | null {
  let nowNum = 0;
  let nowDen = 0;
  let prevNum = 0;
  let prevDen = 0;
  for (const s of strikes) {
    const oi = side === 'call' ? s.callOI : s.putOI;
    const change = side === 'call' ? s.callOIChange : s.putOIChange;
    if (change === null) continue;
    const prev = oi - change;
    nowNum += s.strike * oi;
    nowDen += oi;
    prevNum += s.strike * prev;
    prevDen += prev;
  }
  if (nowDen <= 0 || prevDen <= 0) return null;
  return nowNum / nowDen - prevNum / prevDen;
}

/**
 * The most evenly-matched strike near spot.
 *
 * Searched within two steps of the at-the-money strike, because a balanced
 * strike five steps away is balanced for the uninteresting reason that neither
 * side has positioned there at all. Falls back to the ATM strike, which is the
 * honest answer when nothing near spot is balanced.
 */
function findPivot(strikes: StrikePositioning[], spot: number, step: number | null): number | null {
  const window = step && step > 0 ? step * 2 : Math.max(1, spot * 0.005);
  const near = strikes.filter((s) => Math.abs(s.strike - spot) <= window && s.callOI + s.putOI > 0);
  if (near.length === 0) return nearestListedStrike(strikes.map((s) => s.strike), spot);
  return near.reduce((best, s) => {
    const imbalance = (x: StrikePositioning) => Math.abs(x.callOI - x.putOI) / (x.callOI + x.putOI);
    return imbalance(s) < imbalance(best) ? s : best;
  }).strike;
}

function summarise(args: {
  spot: number;
  pcr: number;
  supports: PositioningLevel[];
  resistances: PositioningLevel[];
  pivot: number | null;
  migration: PositioningMigration;
  hasOIChange: boolean;
}): string {
  const s = args.supports[0];
  const r = args.resistances[0];
  const parts: string[] = [];
  parts.push(
    `Spot ${args.spot.toFixed(0)} sits between the nearest defended support at ${s ? s.strike : 'none in the chain'} and the nearest defended resistance at ${r ? r.strike : 'none in the chain'}; chain PCR ${args.pcr.toFixed(2)}.`,
  );
  if (args.pivot !== null) parts.push(`The most evenly-matched strike near spot is ${args.pivot}.`);
  if (args.hasOIChange) {
    if (s) parts.push(`Support ${s.strike} is ${s.defence}.`);
    if (r) parts.push(`Resistance ${r.strike} is ${r.defence}.`);
    parts.push(args.migration.note);
  } else {
    parts.push("Previous-day open interest was not published, so today's change in positioning could not be read.");
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// The judgement
// ---------------------------------------------------------------------------

export type PositioningVerdictKind = 'confirms' | 'neutral' | 'conflicts';

/** One weighted input to the judgement, kept separate so a refusal is explainable. */
export interface PositioningSignal {
  id: 'defence-ahead' | 'defence-behind' | 'migration' | 'headroom';
  label: string;
  /** −1 opposes the side, +1 supports it, 0 unknown or neutral. */
  value: number;
  weight: number;
  detail: string;
}

export interface PositioningJudgement {
  side: 'CE' | 'PE';
  verdict: PositioningVerdictKind;
  /** Weighted sum of the signals, −1..+1, signed toward the side asked about. */
  score: number;
  signals: PositioningSignal[];
  /** Distance in strike steps to the first level standing in the way. Null with no ladder. */
  headroomSteps: number | null;
  /** The level price must be accepted through next, in the direction asked about. */
  nextLevel: number | null;
  summary: string;
}

export interface PositioningPolicy {
  /** Score at or below which positioning is judged to CONFLICT. */
  conflictBelow: number;
  /** Score at or above which positioning is judged to CONFIRM. */
  confirmAbove: number;
  /**
   * Steps of clearance below which the next level is treated as "immediately
   * in the way". Half a step means price is between two listed strikes and the
   * defended one is the nearer of them.
   */
  minHeadroomSteps: number;
  /** Steps of clearance above which headroom is read as genuinely open. */
  openHeadroomSteps: number;
}

/**
 * Defaults chosen so that the gate can only ever SUBTRACT.
 *
 * `conflictBelow` sits at −0.30, and the only signal available when ΔOI is
 * unreadable is `headroom` at weight 0.20 — so a chain with no previous OI can
 * reach at worst −0.20 and can never produce a refusal. That relationship is
 * load-bearing: if `headroom`'s weight is ever raised above the conflict
 * threshold, a missing feed field starts blocking trades.
 */
export const DEFAULT_POSITIONING_POLICY: PositioningPolicy = {
  conflictBelow: -0.3,
  confirmAbove: 0.2,
  minHeadroomSteps: 0.5,
  openHeadroomSteps: 1.5,
};

/**
 * Does positioning agree with a side someone else already chose?
 *
 * The side is an ARGUMENT, never an output. This function cannot produce a
 * direction, which is what keeps it a confirmation gate rather than a second,
 * quieter signal generator sitting beside the first.
 *
 * For a CE side the reading is: the resistance ahead should be thinning, the
 * support behind should be thickening, the structure should be migrating up,
 * and there should be room between spot and the first defended level. For a PE
 * side every one of those is mirrored — support ahead, resistance behind.
 */
export function judgePositioning(
  read: OptionPositioningRead,
  side: 'CE' | 'PE',
  policy: PositioningPolicy = DEFAULT_POSITIONING_POLICY,
): PositioningJudgement {
  const ahead = side === 'CE' ? read.resistances[0] ?? null : read.supports[0] ?? null;
  const behind = side === 'CE' ? read.supports[0] ?? null : read.resistances[0] ?? null;

  const signals: PositioningSignal[] = [];

  // 1. The level standing in the way. Eroding helps the side; reinforcing opposes it.
  signals.push({
    id: 'defence-ahead',
    label: side === 'CE' ? 'Resistance ahead' : 'Support ahead',
    weight: 0.3,
    value: ahead === null ? 0 : ahead.defence === 'eroding' ? 1 : ahead.defence === 'reinforcing' ? -1 : 0,
    detail:
      ahead === null
        ? `No defended level sits ${side === 'CE' ? 'above' : 'below'} spot in this chain.`
        : ahead.note,
  });

  // 2. The level at the back. Reinforcing helps the side; eroding opposes it.
  signals.push({
    id: 'defence-behind',
    label: side === 'CE' ? 'Support behind' : 'Resistance behind',
    weight: 0.25,
    value: behind === null ? 0 : behind.defence === 'reinforcing' ? 1 : behind.defence === 'eroding' ? -1 : 0,
    detail:
      behind === null
        ? `No defended level sits ${side === 'CE' ? 'below' : 'above'} spot in this chain.`
        : behind.note,
  });

  // 3. Migration. `compressing` and `expanding` are explicitly NOT directional
  //    and score zero — treating a tightening range as bearish for a call was
  //    the single easiest way to make this gate wrong.
  const m = read.migration.direction;
  signals.push({
    id: 'migration',
    label: 'Structure migration',
    weight: 0.25,
    value: m === 'up' ? (side === 'CE' ? 1 : -1) : m === 'down' ? (side === 'CE' ? -1 : 1) : 0,
    detail: read.migration.note,
  });

  // 4. Headroom. Distance to the first defended level in the direction of travel.
  const headroomSteps = ahead?.stepsFromSpot ?? null;
  signals.push({
    id: 'headroom',
    label: 'Room to the next level',
    weight: 0.2,
    value:
      headroomSteps === null
        ? 0
        : headroomSteps < policy.minHeadroomSteps
          ? -1
          : headroomSteps >= policy.openHeadroomSteps
            ? 1
            : 0,
    detail:
      headroomSteps === null
        ? 'No defended level ahead, so there is no measurable clearance.'
        : `${headroomSteps.toFixed(2)} strike steps of clearance to ${ahead!.strike}.`,
  });

  const score = Number(signals.reduce((sum, s) => sum + s.value * s.weight, 0).toFixed(3));
  const verdict: PositioningVerdictKind =
    score <= policy.conflictBelow ? 'conflicts' : score >= policy.confirmAbove ? 'confirms' : 'neutral';

  return {
    side,
    verdict,
    score,
    signals,
    headroomSteps,
    nextLevel: ahead?.strike ?? null,
    summary: judgementSummary(side, verdict, score, ahead, read),
  };
}

function judgementSummary(
  side: 'CE' | 'PE',
  verdict: PositioningVerdictKind,
  score: number,
  ahead: PositioningLevel | null,
  read: OptionPositioningRead,
): string {
  const direction = side === 'CE' ? 'upward' : 'downward';
  const where = ahead ? `${ahead.strike} (${ahead.defence})` : 'no defended level in the chain';
  if (!read.hasOIChange) {
    return `Positioning could only be read as static levels — the first level in the ${direction} path is ${where}, and previous-day open interest was not published, so whether it is being defended harder or lighter is unknown. Score ${score.toFixed(2)}.`;
  }
  switch (verdict) {
    case 'confirms':
      return `Option positioning agrees with the ${direction} read: the first level in the path is ${where}, and ${read.migration.note.toLowerCase()} Score ${score.toFixed(2)}.`;
    case 'conflicts':
      return `Option positioning disagrees with the ${direction} read: the first level in the path is ${where}, and ${read.migration.note.toLowerCase()} Score ${score.toFixed(2)}.`;
    default:
      return `Option positioning is neither for nor against the ${direction} read: the first level in the path is ${where}. Score ${score.toFixed(2)}.`;
  }
}

// ---------------------------------------------------------------------------
// The conditional ladder
// ---------------------------------------------------------------------------

/**
 * One level on the path between spot and a projected level.
 *
 * `confirms` and `invalidates` are the whole point. A level on its own is a
 * number; a level with the chain behaviour that would mean it was ACCEPTED,
 * and the behaviour that would mean it was REJECTED, is a conditional plan —
 * which is the only thing an option chain can honestly produce.
 */
export interface LadderStep {
  strike: number;
  role: 'support' | 'pivot' | 'level' | 'projected';
  /** Where spot currently is relative to this rung. */
  position: 'below' | 'at' | 'above';
  defence: LevelDefence;
  /** What the chain would have to do for this rung to be read as accepted. */
  confirms: string;
  /** What would say the rung rejected price instead. */
  invalidates: string;
}

export interface PositioningLadder {
  direction: 'bullish' | 'bearish';
  spot: number;
  /** Ordered in the direction of travel: the next rung price meets is first. */
  steps: LadderStep[];
  /** The nearest rung that is still ahead — the level worth watching now. */
  nextDecisionPoint: number | null;
  summary: string;
}

/**
 * Turn the map into an ordered, conditional path.
 *
 * This is the "staircase": the support that has to hold, the pivot that has to
 * be reclaimed, each defended level that has to be accepted, and the projected
 * level at the top. It states, per rung, the option-chain behaviour that would
 * confirm the rung and the behaviour that would invalidate it — so a thesis is
 * held or dropped on what positioning does, rather than on whether the number
 * at the top was reached.
 *
 * `projectedLevel` is optional and is the caller's own number, carried through
 * as the last rung. This function never invents one: a projected level is a
 * forecast, and nothing in an option chain produces a forecast.
 */
export function buildLadder(
  read: OptionPositioningRead,
  direction: 'bullish' | 'bearish',
  projectedLevel?: number,
): PositioningLadder {
  const steps: LadderStep[] = [];
  const bullish = direction === 'bullish';

  // The level at the back is the first rung: the thesis rests on it holding.
  const back = bullish ? read.supports[0] ?? null : read.resistances[0] ?? null;
  if (back) {
    steps.push({
      strike: back.strike,
      role: 'support',
      position: bullish ? 'below' : 'above',
      defence: back.defence,
      confirms: bullish
        ? `Price holds above ${back.strike} while put writers there keep adding — the level is defended from the side the thesis needs.`
        : `Price holds below ${back.strike} while call writers there keep adding — the level is defended from the side the thesis needs.`,
      invalidates: bullish
        ? `Price is accepted below ${back.strike} while put open interest there falls — the defenders left rather than defended.`
        : `Price is accepted above ${back.strike} while call open interest there falls — the defenders left rather than defended.`,
    });
  }

  if (read.pivot !== null) {
    steps.push({
      strike: read.pivot,
      role: 'pivot',
      position: read.pivot < read.spot ? 'below' : read.pivot > read.spot ? 'above' : 'at',
      defence: defenceAt(read, read.pivot, bullish ? 'call' : 'put'),
      confirms: bullish
        ? `Price is accepted above ${read.pivot} with call open interest there falling and put open interest rising — the level changes hands from resistance to support.`
        : `Price is accepted below ${read.pivot} with put open interest there falling and call open interest rising — the level changes hands from support to resistance.`,
      invalidates: bullish
        ? `Price is rejected at ${read.pivot} with call open interest there still rising — writers held the level.`
        : `Price is rejected at ${read.pivot} with put open interest there still rising — writers held the level.`,
    });
  }

  // Every defended level in the direction of travel, in the order price meets them.
  const ahead = bullish ? read.resistances : read.supports;
  for (const level of ahead) {
    if (projectedLevel !== undefined && (bullish ? level.strike > projectedLevel : level.strike < projectedLevel)) {
      continue;
    }
    steps.push({
      strike: level.strike,
      role: 'level',
      position: bullish ? 'above' : 'below',
      defence: level.defence,
      confirms: bullish
        ? `Price trades through ${level.strike} while call open interest there FALLS — writers covering rather than reinforcing — and put open interest at the same strike rises.`
        : `Price trades through ${level.strike} while put open interest there FALLS — writers covering rather than reinforcing — and call open interest at the same strike rises.`,
      invalidates: bullish
        ? `Price reaches ${level.strike} and call open interest there increases while put open interest does not build — the level absorbed the move.`
        : `Price reaches ${level.strike} and put open interest there increases while call open interest does not build — the level absorbed the move.`,
    });
  }

  if (projectedLevel !== undefined && Number.isFinite(projectedLevel)) {
    steps.push({
      strike: projectedLevel,
      role: 'projected',
      position: bullish ? 'above' : 'below',
      defence: defenceAt(read, projectedLevel, bullish ? 'call' : 'put'),
      confirms: bullish
        ? `Open interest continues to build at strikes above ${projectedLevel} — the structure has moved past the projected level rather than stalling under it.`
        : `Open interest continues to build at strikes below ${projectedLevel} — the structure has moved past the projected level rather than stalling above it.`,
      invalidates: `Positioning stops migrating ${bullish ? 'up' : 'down'} the grid before ${projectedLevel} is reached, which says the structure did not follow price.`,
    });
  }

  const nextDecisionPoint =
    steps.find((s) => (bullish ? s.strike > read.spot : s.strike < read.spot))?.strike ?? null;

  return {
    direction,
    spot: read.spot,
    steps,
    nextDecisionPoint,
    summary:
      steps.length === 0
        ? 'The chain published no defended levels, so no conditional path could be laid out.'
        : `${direction === 'bullish' ? 'Upward' : 'Downward'} path from ${read.spot.toFixed(0)}: ${steps.map((s) => s.strike).join(' → ')}. Next level to be resolved: ${nextDecisionPoint ?? 'none ahead'}.`,
  };
}

function defenceAt(read: OptionPositioningRead, strike: number, side: 'call' | 'put'): LevelDefence {
  const row = read.strikes.find((s) => s.strike === strike);
  if (!row || !read.hasOIChange) return 'unknown';
  const change = side === 'call' ? row.callOIChange : row.putOIChange;
  const action = side === 'call' ? row.callAction : row.putAction;
  if (change === null || action === 'unknown') return 'unknown';
  if (action === 'flat') return 'steady';
  return change > 0 ? 'reinforcing' : 'eroding';
}
