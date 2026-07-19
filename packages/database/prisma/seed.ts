import { PrismaClient, InstrumentType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
const prisma = new PrismaClient();

const expiry = new Date('2026-07-30T00:00:00.000Z');

async function upsertInstrument(data: any, ltp: string, prev: string) {
  const instrument = await prisma.instrument.upsert({
    where: { symbol: data.symbol },
    update: data,
    create: data,
  });
  const existing = await prisma.quote.findFirst({ where: { instrumentId: instrument.id } });
  if (existing) {
    await prisma.quote.update({ where: { id: existing.id }, data: { ltp, previousClose: prev, source: 'simulated' } });
  } else {
    await prisma.quote.create({ data: { instrumentId: instrument.id, ltp, previousClose: prev, source: 'simulated' } });
  }
  return instrument;
}

async function main() {
  await upsertInstrument({
    symbol: 'NIFTY', displayName: 'NIFTY 50', type: InstrumentType.INDEX, exchange: 'NSE', lotSize: 1
  }, '24850.00', '24720.00');

  await upsertInstrument({
    symbol: 'BANKNIFTY', displayName: 'NIFTY BANK', type: InstrumentType.INDEX, exchange: 'NSE', lotSize: 1
  }, '52750.00', '52510.00');

  // Milestone 4, Step 2 (Market Data): the Index Dashboard needs 5 indices;
  // only NIFTY/BANKNIFTY existed. Data-only addition — existing Instrument
  // model, no schema change.
  await upsertInstrument({
    symbol: 'FINNIFTY', displayName: 'NIFTY FIN SERVICE', type: InstrumentType.INDEX, exchange: 'NSE', lotSize: 1
  }, '26480.90', '26396.70');

  await upsertInstrument({
    symbol: 'MIDCPNIFTY', displayName: 'NIFTY MIDCAP SELECT', type: InstrumentType.INDEX, exchange: 'NSE', lotSize: 1
  }, '13120.50', '13074.60');

  await upsertInstrument({
    symbol: 'SENSEX', displayName: 'BSE SENSEX', type: InstrumentType.INDEX, exchange: 'BSE', lotSize: 1
  }, '78250.60', '77848.50');

  const strikes = [24700, 24800, 24900, 52600, 52700, 52800];
  for (const strike of strikes) {
    const underlying = strike < 30000 ? 'NIFTY' : 'BANKNIFTY';
    const lotSize = underlying === 'NIFTY' ? 75 : 35;
    for (const optionType of ['CE', 'PE']) {
      const symbol = `${underlying}26JUL${strike}${optionType}`;
      const ltp = optionType === 'CE' ? (Math.max(50, Math.random() * 220 + 80)).toFixed(2) : (Math.max(50, Math.random() * 210 + 70)).toFixed(2);
      await upsertInstrument({
        symbol,
        displayName: `${underlying} ${expiry.toISOString().slice(0,10)} ${strike} ${optionType}`,
        type: InstrumentType.OPTION,
        exchange: 'NSE',
        underlying,
        expiryDate: expiry,
        strikePrice: strike,
        optionType,
        lotSize,
      }, ltp, (Number(ltp) * 0.96).toFixed(2));
    }
  }
  console.log('Seeded TradeW prototype instruments and quotes');

  await seedPlans();
}

// Subscription plans + capability grants (entitlement architecture, Q7).
// Grants use the capability keys from @tradew/types (Capability enum).
async function seedPlans() {
  const plans: {
    code: string;
    name: string;
    description: string;
    trialDays: number;
    graceDays: number;
    grants: { capability: string; quotaMetric?: string; quotaLimit?: number; quotaPeriod?: 'DAY' | 'MONTH' }[];
  }[] = [
    {
      code: 'free',
      name: 'Free',
      description: 'Paper trading with a realistic virtual account.',
      trialDays: 0,
      graceDays: 0,
      grants: [{ capability: 'paper_trading' }],
    },
    {
      code: 'tradew_pro',
      name: 'TradeW Pro',
      description: 'AI Research and the Neural Brain on top of paper trading.',
      trialDays: 14,
      graceDays: 3,
      grants: [
        { capability: 'paper_trading' },
        { capability: 'ai_research', quotaMetric: 'ai_requests', quotaLimit: 200, quotaPeriod: 'DAY' },
        { capability: 'neural_brain', quotaMetric: 'ai_requests', quotaLimit: 200, quotaPeriod: 'DAY' },
      ],
    },
    {
      code: 'sentinel_pro',
      name: 'Sentinel Pro',
      description: 'The Sentinel AI intelligence desk with advanced market intelligence.',
      trialDays: 7,
      graceDays: 3,
      grants: [
        { capability: 'paper_trading' },
        { capability: 'sentinel', quotaMetric: 'sentinel_requests', quotaLimit: 500, quotaPeriod: 'DAY' },
        { capability: 'advanced_market_intelligence' },
        { capability: 'neural_brain', quotaMetric: 'ai_requests', quotaLimit: 300, quotaPeriod: 'DAY' },
      ],
    },
    {
      code: 'tradew_ultimate',
      name: 'TradeW Ultimate',
      description: 'Everything: Sentinel, AI Research, portfolio intelligence and premium agents.',
      trialDays: 7,
      graceDays: 5,
      grants: [
        { capability: 'paper_trading' },
        { capability: 'sentinel', quotaMetric: 'sentinel_requests', quotaLimit: 2000, quotaPeriod: 'DAY' },
        { capability: 'ai_research', quotaMetric: 'ai_requests', quotaLimit: 1000, quotaPeriod: 'DAY' },
        { capability: 'neural_brain', quotaMetric: 'ai_requests', quotaLimit: 1000, quotaPeriod: 'DAY' },
        { capability: 'advanced_market_intelligence' },
        { capability: 'portfolio_intelligence' },
        { capability: 'premium_agents' },
      ],
    },
    {
      code: 'enterprise',
      name: 'Enterprise',
      description: 'Organization plan — unmetered capabilities, custom terms.',
      trialDays: 0,
      graceDays: 15,
      grants: [
        { capability: 'paper_trading' },
        { capability: 'sentinel' },
        { capability: 'ai_research' },
        { capability: 'neural_brain' },
        { capability: 'advanced_market_intelligence' },
        { capability: 'portfolio_intelligence' },
        { capability: 'premium_agents' },
      ],
    },
  ];

  for (const p of plans) {
    const plan = await prisma.plan.upsert({
      where: { code: p.code },
      update: { name: p.name, description: p.description, trialDays: p.trialDays, graceDays: p.graceDays, active: true },
      create: { code: p.code, name: p.name, description: p.description, trialDays: p.trialDays, graceDays: p.graceDays },
    });
    await prisma.planGrant.deleteMany({ where: { planId: plan.id } });
    await prisma.planGrant.createMany({
      data: p.grants.map((g) => ({
        planId: plan.id,
        capability: g.capability,
        quotaMetric: g.quotaMetric ?? null,
        quotaLimit: g.quotaLimit ?? null,
        quotaPeriod: g.quotaPeriod ?? null,
      })),
    });
  }
  console.log(`Seeded ${plans.length} subscription plans with capability grants`);
}

/**
 * Demo account with an already-active Sentinel Pro subscription, so the
 * live Sentinel OS can be verified end to end without building a billing
 * flow first. Real signups start on the Free plan, per the entitlement
 * architecture — this account is the one exception, seeded deliberately.
 */
async function seedDemoAccount() {
  const email = 'founder@tradew.local';
  const passwordHash = await bcrypt.hash('sentinel-demo', 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash },
  });

  const plan = await prisma.plan.findUnique({ where: { code: 'sentinel_pro' } });
  if (!plan) throw new Error('sentinel_pro plan must be seeded before the demo account');

  const existing = await prisma.subscription.findFirst({
    where: { userId: user.id, planId: plan.id, status: 'ACTIVE' },
  });
  if (!existing) {
    await prisma.subscription.create({
      data: { userId: user.id, planId: plan.id, status: 'ACTIVE', billingProvider: 'none' },
    });
  }
  console.log(`Seeded demo account ${email} (password: sentinel-demo) with an active Sentinel Pro subscription`);
}

main()
  .then(seedDemoAccount)
  .finally(() => prisma.$disconnect());
