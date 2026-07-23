/**
 * Validates the Learning Hub catalog and its payoff math.
 *
 * Run from `apps/web` (ts-node is hoisted to the repo root, and is not a
 * declared dependency of this app — so this is invoked directly rather than
 * through an npm script):
 *
 *   cd apps/web && ../../node_modules/.bin/ts-node --transpile-only \
 *     --compilerOptions '{"module":"commonjs","target":"es2020","esModuleInterop":true,"moduleResolution":"node"}' \
 *     scripts/validate-learning.ts
 *
 * Two classes of check, both of which have already caught real bugs:
 *
 *  1. **Catalog parsing.** Every lesson's frontmatter parses, ids are unique
 *     and match filenames, legs are well-formed. `catalog.ts` throws on any
 *     violation, so merely building the catalog is the test.
 *
 *  2. **Payoff structure.** Each strategy's computed curve matches what the
 *     structure is by definition — a vertical spread's max profit plus its max
 *     loss equals the spread width, an iron condor has two breakevens, a naked
 *     short has unbounded loss. These caught a flat-vol bug that priced credit
 *     spreads as debits, and a sampling-window bug that cropped breakevens.
 *
 * The strongest check is the last one: the authored `net: credit|debit` in
 * frontmatter must agree with the computed sign. That turns a hand-written
 * field into a machine-checked invariant.
 */

import { getStrategies } from '../src/lib/learning/catalog';
import { buildPayoffProfile, type PayoffProfile } from '../src/lib/learning/payoff';
import type { Strategy } from '../src/lib/learning/types';

/** A representative NIFTY-like underlying: spot, strike step, one week out. */
const SPOT = 24_800;
const STRIKE_STEP = 50;
const YEARS = 7 / 365;

let failures = 0;

function check(name: string, condition: boolean, detail: string): void {
  if (condition) return;
  console.error(`  FAIL  ${name} — ${detail}`);
  failures += 1;
}

function near(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

function widthOf(profile: PayoffProfile): number {
  const strikes = profile.legs.map((l) => l.strikePrice);
  return Math.max(...strikes) - Math.min(...strikes);
}

const strategies = getStrategies();
if (!strategies.length) {
  console.error('No strategies parsed — expected at least one lesson with `legs` frontmatter.');
  process.exit(1);
}

console.log(`Learning catalog: ${strategies.length} strategies\n`);

const profiles = new Map<string, PayoffProfile>();
for (const strategy of strategies) {
  const profile = buildPayoffProfile(strategy, SPOT, STRIKE_STEP, YEARS);
  profiles.set(strategy.id, profile);
  const maxP = profile.maxProfit === null ? 'unbounded' : profile.maxProfit.toFixed(1);
  const maxL = profile.maxLoss === null ? 'unbounded' : profile.maxLoss.toFixed(1);
  console.log(
    `  ${strategy.id.padEnd(20)} net=${profile.netPremium.toFixed(1).padStart(8)}` +
      `  maxProfit=${maxP.padStart(10)}  maxLoss=${maxL.padStart(10)}` +
      `  breakevens=[${profile.breakevens.map((b) => b.toFixed(0)).join(', ')}]`,
  );
}

console.log('\nInvariants that hold for every strategy:');
for (const strategy of strategies) {
  const profile = profiles.get(strategy.id)!;

  check(`${strategy.id}: curve is finite`, profile.points.every((p) => Number.isFinite(p.pnl)), 'non-finite P&L sample');

  // A sampling window that fails to reach a breakeven reports zero of them,
  // which is how the original window bug presented.
  check(`${strategy.id}: breakeven inside the sampled window`, profile.breakevens.length >= 1, 'no breakeven found');

  // The authored field must agree with the arithmetic.
  if (strategy.net === 'credit') {
    check(`${strategy.id}: frontmatter says credit`, profile.netPremium > 0, `computed ${profile.netPremium.toFixed(2)}`);
  } else if (strategy.net === 'debit') {
    check(`${strategy.id}: frontmatter says debit`, profile.netPremium < 0, `computed ${profile.netPremium.toFixed(2)}`);
  }

  // Any structure whose legs are all long options cannot lose more than it paid.
  const allLongOptions = strategy.legs.every((l) => l.action === 'BUY' && (l.kind === 'CE' || l.kind === 'PE'));
  if (allLongOptions) {
    check(
      `${strategy.id}: long-only loss capped at premium`,
      profile.maxLoss !== null && near(profile.maxLoss, profile.netPremium, 0.01),
      `maxLoss=${profile.maxLoss} netPremium=${profile.netPremium}`,
    );
  }

  // A structure with an uncovered short call has no upper bound on loss.
  const shortCalls = strategy.legs.filter((l) => l.action === 'SELL' && l.kind === 'CE').length;
  const longCalls = strategy.legs.filter((l) => l.action === 'BUY' && l.kind === 'CE').length;
  if (shortCalls > longCalls) {
    check(`${strategy.id}: uncovered short call is unbounded`, profile.maxLoss === null, `maxLoss=${profile.maxLoss}`);
  }
}

console.log('\nStructure-specific checks:');

function profileOf(id: string): { strategy: Strategy; profile: PayoffProfile } | null {
  const strategy = strategies.find((s) => s.id === id);
  if (!strategy) {
    console.log(`  skip  ${id} (not authored yet)`);
    return null;
  }
  return { strategy, profile: profiles.get(id)! };
}

// A vertical spread is fully bounded, and its max profit plus its max loss is
// exactly the distance between the strikes.
for (const id of ['bull-call-spread', 'bear-put-spread', 'bull-put-spread', 'bear-call-spread']) {
  const found = profileOf(id);
  if (!found) continue;
  const { profile } = found;
  const bounded = profile.maxProfit !== null && profile.maxLoss !== null;
  check(`${id}: bounded both ways`, bounded, `${profile.maxProfit}/${profile.maxLoss}`);
  if (bounded) {
    check(
      `${id}: maxProfit + |maxLoss| = spread width`,
      near(profile.maxProfit! - profile.maxLoss!, widthOf(profile), 1.5),
      `${(profile.maxProfit! - profile.maxLoss!).toFixed(2)} vs width ${widthOf(profile)}`,
    );
  }
  check(`${id}: exactly one breakeven`, profile.breakevens.length === 1, `got ${profile.breakevens.length}`);
}

// Four-leg neutral structures are bounded, credit-taking, and have a breakeven
// on each side of spot.
for (const id of ['iron-condor', 'iron-butterfly']) {
  const found = profileOf(id);
  if (!found) continue;
  const { profile } = found;
  check(`${id}: bounded both ways`, profile.maxProfit !== null && profile.maxLoss !== null, `${profile.maxProfit}/${profile.maxLoss}`);
  check(`${id}: two breakevens`, profile.breakevens.length === 2, `got ${profile.breakevens.length}`);
  check(`${id}: straddles spot`, profile.breakevens.length === 2 && profile.breakevens[0] < SPOT && profile.breakevens[1] > SPOT, `${profile.breakevens}`);
}

// Long and short versions of the same structure are mirror images.
for (const [longId, shortId] of [
  ['long-straddle', 'short-straddle'],
  ['long-strangle', 'short-strangle'],
]) {
  const a = profileOf(longId);
  const b = profileOf(shortId);
  if (!a || !b) continue;
  check(
    `${longId} / ${shortId}: net premiums are mirrored`,
    near(a.profile.netPremium, -b.profile.netPremium, 0.01),
    `${a.profile.netPremium.toFixed(2)} vs ${b.profile.netPremium.toFixed(2)}`,
  );
  check(
    `${longId} / ${shortId}: breakevens coincide`,
    a.profile.breakevens.length === b.profile.breakevens.length &&
      a.profile.breakevens.every((v, i) => near(v, b.profile.breakevens[i], 1)),
    `${a.profile.breakevens} vs ${b.profile.breakevens}`,
  );
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
