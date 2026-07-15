import { PrismaClient, InstrumentType } from '@prisma/client';
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
    await prisma.quote.update({ where: { id: existing.id }, data: { ltp, previousClose: prev } });
  } else {
    await prisma.quote.create({ data: { instrumentId: instrument.id, ltp, previousClose: prev } });
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
}

main().finally(() => prisma.$disconnect());
