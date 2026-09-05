/**
 * Tradable-universe synchronisation CLI.
 *
 *   npm run universe:sync -w @tradew/market-data-service
 *   npm run universe:sync -w @tradew/market-data-service -- --dry
 *   npm run universe:sync -w @tradew/market-data-service -- --markets=INDIA,CRYPTO
 *   npm run universe:sync -w @tradew/market-data-service -- --limit=500
 *   npm run universe:sync -w @tradew/market-data-service -- --delist-missing
 *   npm run universe:sync -w @tradew/market-data-service -- --derivatives
 *
 * A CLI, like the scrip-master sync beside it and for the same reasons: the
 * catalogues change about once a day, downloading them on every restart would
 * be wasteful, and an operator should be able to preview a run with --dry before
 * anything lands.
 *
 * --delist-missing is opt-in. Without it the sync only ever adds and updates,
 * which makes an unattended first run safe: the worst it can do is import
 * something twice, and `ref` uniqueness prevents even that.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') }); // root .env — see .env.example

import { PrismaClient } from '@prisma/client';
import { UNIVERSE_MARKETS, type UniverseMarket } from '@tradew/market-data';
import { UniverseSyncService } from '../src/universe/universe-sync.service';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const service = new UniverseSyncService(prisma as never);

  const marketsArg = arg('markets');
  let markets: UniverseMarket[] | undefined;
  if (marketsArg) {
    const requested = marketsArg.split(',').map((m) => m.trim().toUpperCase());
    const invalid = requested.filter((m) => !(UNIVERSE_MARKETS as readonly string[]).includes(m));
    if (invalid.length > 0) {
      console.error(`unknown market(s): ${invalid.join(', ')}`);
      console.error(`valid markets: ${UNIVERSE_MARKETS.join(', ')}`);
      process.exitCode = 1;
      await prisma.$disconnect();
      return;
    }
    markets = requested as UniverseMarket[];
  }

  const limitArg = arg('limit');
  const limit = limitArg ? Number.parseInt(limitArg, 10) : undefined;

  console.log(`markets        : ${markets ? markets.join(', ') : 'ALL (INDIA, USA, UK, FOREX, CRYPTO)'}`);
  console.log(`mode           : ${flag('dry') ? 'DRY RUN (no writes)' : 'WRITE'}`);
  console.log(`delist missing : ${flag('delist-missing') ? 'yes' : 'no'}`);
  console.log(`derivatives    : ${flag('derivatives') ? 'yes (India F&O + currency)' : 'no (cash + index only)'}`);
  if (limit) console.log(`limit          : ${limit} per source (run marked truncated; cannot delist)`);
  console.log('');

  const report = await service.sync({
    markets,
    dryRun: flag('dry'),
    limit: Number.isFinite(limit as number) && (limit as number) > 0 ? limit : undefined,
    delistMissing: flag('delist-missing'),
    includeDerivatives: flag('derivatives'),
  });

  console.log('');
  for (const source of report.sources) {
    console.log(
      `${source.source.padEnd(12)} ${source.status.padEnd(10)} ` +
        `discovered=${source.discovered} pages=${source.pages} ` +
        `created=${source.created} updated=${source.updated} unchanged=${source.unchanged} ` +
        `delisted=${source.delisted} dupes=${source.duplicates} rejected=${source.rejected} ` +
        `(${Math.round(source.durationMs / 1000)}s)`,
    );
    for (const err of source.errors.slice(0, 5)) console.log(`  ! ${err}`);
  }

  if (report.unavailable.length > 0) {
    console.log('');
    console.log('UNAVAILABLE SOURCES — their markets were skipped, not emptied:');
    for (const u of report.unavailable) console.log(`  ${u.id}: ${u.reason}`);
  }

  console.log('');
  console.log(
    `total: discovered=${report.totals.discovered} created=${report.totals.created} ` +
      `updated=${report.totals.updated} unchanged=${report.totals.unchanged} ` +
      `delisted=${report.totals.delisted} in ${Math.round(report.durationMs / 1000)}s`,
  );

  if (!report.dryRun) {
    const byMarket = await prisma.universeInstrument.groupBy({
      by: ['market', 'status'],
      _count: { _all: true },
    });
    console.log('');
    console.log('universe now holds:');
    for (const row of byMarket.sort((a, b) => a.market.localeCompare(b.market))) {
      console.log(`  ${row.market.padEnd(8)} ${row.status.padEnd(10)} ${row._count._all}`);
    }
  }

  // A source that failed outright is a non-zero exit, so a cron or CI step
  // notices. A PARTIAL run is not: it wrote real data and simply did not finish.
  if (report.sources.some((s) => s.status === 'FAILED')) process.exitCode = 1;

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
});
