// Seeds ONE agent round-trip (entry + square-off exit) and ONE manual order into
// the ISOLATED persona database, for a customer who already signed up through
// the real UI.
//
// Why seeding is needed: the agent loop cannot place orders here (it needs the
// live market feed and Sentinel), so without seeded rows the "Placed by: Agent"
// badge could never be looked at. Everything is written through the app's own
// Prisma schema, and every row is clearly named "persona-seeded" — the report
// says these orders are seeded, not produced by an agent.
//
//   node src/seedAgentTrade.mjs <email>
//
// Refuses to touch any database that is not the isolated one (port 5435).

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const url = env.DATABASE_URL ?? '';
if (!/@(127\.0\.0\.1|localhost):5435\//.test(url)) {
  console.error('Refusing to seed: DATABASE_URL is not the isolated persona database (port 5435).');
  process.exit(2);
}
process.env.DATABASE_URL = url;

const require = createRequire(join(ROOT, 'package.json'));
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const email = process.argv[2];
if (!email) {
  console.error('usage: node src/seedAgentTrade.mjs <email>');
  process.exit(2);
}

try {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No such customer: ${email}`);

  const instrument = await prisma.instrument.upsert({
    where: { symbol: 'NIFTY:20261110:24000:CE' },
    update: {},
    create: {
      symbol: 'NIFTY:20261110:24000:CE',
      displayName: 'NIFTY 10 Nov 24000 CE (seeded)',
      type: 'OPTION',
      exchange: 'NSE',
      underlying: 'NIFTY',
      expiryDate: new Date('2026-11-10T00:00:00Z'),
      strikePrice: 24000,
      optionType: 'CE',
      lotSize: 65,
    },
  });

  await prisma.paperWallet.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } });

  const profile = await prisma.executionProfile.upsert({
    where: { name: `persona-seeded-${user.id.slice(0, 8)}` },
    update: {},
    create: { name: `persona-seeded-${user.id.slice(0, 8)}`, agent: 'sentinel-alpha', symbol: 'NIFTY', accountUserId: user.id },
  });

  const now = Date.now();
  const intent = await prisma.executionIntent.create({
    data: {
      profileId: profile.id,
      idempotencyKey: `persona-seeded-${user.id}-${now}`,
      agent: 'sentinel-alpha',
      symbol: 'NIFTY',
      side: 'BUY',
      optionType: 'CE',
      bias: 'bullish',
      strike: 24000,
      expiry: new Date('2026-11-10T00:00:00Z'),
      contractSymbol: instrument.symbol,
      lots: 1,
      quantity: 65,
      productType: 'MIS',
      orderType: 'MARKET',
      confidence: 70,
      status: 'CLOSED',
    },
  });

  const entryAt = new Date(now - 3 * 3600_000);
  const exitAt = new Date(now - 3600_000);
  const common = { userId: user.id, instrumentId: instrument.id, quantity: 65, filledQuantity: 65, type: 'MARKET', productType: 'MIS', status: 'FILLED' };

  const entry = await prisma.order.create({
    data: { ...common, side: 'BUY', avgFillPrice: 100, charges: 1.95, placedAt: entryAt, executionIntentId: intent.id },
  });
  await prisma.trade.create({
    data: { orderId: entry.id, userId: user.id, instrumentId: instrument.id, side: 'BUY', quantity: 65, fillPrice: 100, charges: 1.95, executedAt: entryAt },
  });
  const exit = await prisma.order.create({
    data: { ...common, side: 'SELL', avgFillPrice: 110, charges: 2.15, placedAt: exitAt, exitOfIntentId: intent.id },
  });
  await prisma.trade.create({
    data: { orderId: exit.id, userId: user.id, instrumentId: instrument.id, side: 'SELL', quantity: 65, fillPrice: 110, charges: 2.15, realizedPnl: 650, closedQuantity: 65, executedAt: exitAt },
  });
  await prisma.executionOutcome.create({
    data: { intentId: intent.id, entryPrice: 100, quantity: 65, realizedPnl: 650, charges: 4.1, result: 'WIN', exitReason: 'SQUARE_OFF', entryAt, exitPrice: 110, exitAt },
  });

  // One order the customer placed themselves, so the two can be told apart.
  const manual = await prisma.order.create({
    data: { ...common, side: 'BUY', avgFillPrice: 101, charges: 1.97, placedAt: new Date(now - 1800_000) },
  });
  await prisma.trade.create({
    data: { orderId: manual.id, userId: user.id, instrumentId: instrument.id, side: 'BUY', quantity: 65, fillPrice: 101, charges: 1.97, executedAt: new Date(now - 1800_000) },
  });

  console.log('seeded: 1 agent entry + 1 agent square-off exit + 1 manual order');
} finally {
  await prisma.$disconnect();
}
