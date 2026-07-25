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

import { getLessons, getStrategies } from '../src/lib/learning/catalog';
import { buildPayoffProfile, payoffZones, type PayoffProfile } from '../src/lib/learning/payoff';
import type { Strategy } from '../src/lib/learning/types';
import { zoneRange } from '../src/lib/learning/describe';

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


// --- Payoff zones -----------------------------------------------------------
// Zones are what the UI renders instead of buy/sell instructions, so a wrong
// zone is a wrong lesson. These assert the shapes that are true by definition.

console.log('\nPayoff zones:');
for (const strategy of strategies) {
  const profile = profiles.get(strategy.id)!;
  const zones = payoffZones(profile);
  const render = (z: (typeof zones)[number]) =>
    `${z.kind}/${z.slope} ${z.from === null ? '−∞' : z.from.toFixed(0)}..${z.to === null ? '+∞' : z.to.toFixed(0)}`;
  console.log(`  ${strategy.id.padEnd(20)} ${zones.map(render).join('  |  ')}`);

  // The stated slope must match what the sampled curve actually does. A zone
  // that says "gain builds" while the curve falls is a wrong lesson, not a
  // cosmetic slip — this is the check that caught exactly that.
  for (const zone of zones) {
    const lo = zone.from ?? profile.points[0].price;
    const hi = zone.to ?? profile.points[profile.points.length - 1].price;
    const inside = profile.points.filter((p) => p.price > lo && p.price < hi);
    if (inside.length < 2) continue;
    const delta = inside[inside.length - 1].pnl - inside[0].pnl;
    const expected = zone.capped ? 'flat' : delta > 0 ? 'rising' : 'falling';
    check(`${strategy.id}: zone ${zoneRange(zone)} slope is ${expected}`, zone.slope === expected, `declared ${zone.slope}, curve moves ${delta.toFixed(2)}`);
    // And a gain zone must actually be positive throughout, likewise loss.
    const allPositive = inside.every((p) => p.pnl >= -1e-6);
    const allNegative = inside.every((p) => p.pnl <= 1e-6);
    check(`${strategy.id}: zone ${zoneRange(zone)} sign matches its kind`, zone.kind === 'gain' ? allPositive : allNegative, `kind=${zone.kind}`);
  }

  check(`${strategy.id}: has at least one gain and one loss zone`, zones.some((z) => z.kind === 'gain') && zones.some((z) => z.kind === 'loss'), `zones=${zones.length}`);

  // Zones must tile the window in order, with no gaps between them.
  for (let i = 1; i < zones.length; i += 1) {
    check(`${strategy.id}: zone ${i} is contiguous with the previous`, zones[i - 1].to === zones[i].from, `${zones[i - 1].to} != ${zones[i].from}`);
  }

  // An unbounded max profit must show an uncapped gain zone at an open end,
  // and likewise for loss. This is the property the UI depends on to avoid
  // claiming a limit that does not exist.
  if (profile.maxProfit === null) {
    check(`${strategy.id}: unbounded profit shows an uncapped open gain zone`, zones.some((z) => z.kind === 'gain' && !z.capped && (z.from === null || z.to === null)), render(zones[zones.length - 1]));
  }
  if (profile.maxLoss === null) {
    check(`${strategy.id}: unbounded loss shows an uncapped open loss zone`, zones.some((z) => z.kind === 'loss' && !z.capped && (z.from === null || z.to === null)), render(zones[zones.length - 1]));
  }
  // Conversely, a bounded structure must not present an open uncapped band.
  if (profile.maxProfit !== null && profile.maxLoss !== null) {
    check(`${strategy.id}: fully bounded, no uncapped open band`, !zones.some((z) => !z.capped && (z.from === null || z.to === null)), zones.map(render).join(' | '));
  }
}


// --- Non-directive language lint --------------------------------------------
// LEARNING-HUB.md §6: the Hub teaches, it does not instruct. Prose that says
// "sell the lower strike" reads as a signal; "the lower strike is the short
// leg" states the same fact as a property. This lint exists because the first
// draft of every strategy lesson used the imperative form without anyone
// noticing until it was rendered in the product.
//
// It scans the authored markdown, not the UI, since that is where the prose
// actually lives.

console.log('\nNon-directive language:');

const IMPERATIVES: Array<{ pattern: RegExp; note: string }> = [
  { pattern: /\b(buy|sell)\s+(the|a|an|one|two)\b/gi, note: 'imperative "buy/sell the …" — describe the leg as long/short instead' },
  { pattern: /^\s*[-*]\s*(buy|sell)\b/gim, note: 'list item starting with buy/sell — name the leg, do not instruct' },
  { pattern: /\byou should\b|\bmake sure to\b|\bconsider (buying|selling)\b/gi, note: 'direct instruction to the reader' },
  { pattern: /\b(enter|exit) (this|the) (trade|position) when\b/gi, note: 'entry/exit timing instruction' },
];

// Descriptive uses that are not instructions to the reader.
const ALLOWED = [
  /must (buy|sell) it/i,          // describing a settlement obligation
  /obliged to (buy|sell)/i,
  /obliging .{0,40}(buy|sell)/i,
  /a trader without the stock must buy/i,
];

for (const entry of [...strategies, ...getLessons()]) {
  const text = `${entry.summary}\n${entry.body}`;
  for (const { pattern, note } of IMPERATIVES) {
    // exec-in-a-loop rather than matchAll: this file is typechecked by
    // `next build`, whose target does not allow iterating a RegExp iterator.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const around = text.slice(Math.max(0, match.index - 60), match.index + 60).replace(/\s+/g, ' ');
      if (!ALLOWED.some((ok) => ok.test(around))) {
        check(`${entry.id}: non-directive prose`, false, `${note} — "…${around}…"`);
      }
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1; // zero-width guard
    }
  }
}
if (!failures) console.log('  no directive phrasing found');

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
