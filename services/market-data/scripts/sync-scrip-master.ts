/**
 * Instrument master synchronisation CLI.
 *
 *   npm run scrip:sync -w @tradew/market-data-service
 *   npm run scrip:sync -w @tradew/market-data-service -- --dry
 *   npm run scrip:sync -w @tradew/market-data-service -- --segments=IDX_I,NSE_EQ,NSE_FNO
 *   npm run scrip:sync -w @tradew/market-data-service -- --deactivate-missing
 *   npm run scrip:sync -w @tradew/market-data-service -- --file=./master.csv
 *
 * A CLI rather than a boot-time job on purpose: the master changes about once a
 * day, downloading ~10 MiB on every restart would be wasteful, and an operator
 * should be able to preview changes with --dry before they land.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') }); // root .env — see .env.example
import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { ExchangeSegment, isExchangeSegment } from '@tradew/market-data';
import { DEFAULT_SEGMENTS, DEFAULT_SERIES, ScripMasterService } from '../src/scrip-master/scrip-master.service';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const service = new ScripMasterService(prisma as never);

  const segmentsArg = arg('segments');
  let segments: ExchangeSegment[] = DEFAULT_SEGMENTS;
  if (segmentsArg) {
    const requested = segmentsArg.split(',').map((s) => s.trim().toUpperCase());
    const invalid = requested.filter((s) => !isExchangeSegment(s));
    if (invalid.length > 0) {
      console.error(`unknown segment(s): ${invalid.join(', ')}`);
      process.exitCode = 1;
      await prisma.$disconnect();
      return;
    }
    segments = requested as ExchangeSegment[];
  }

  const limitArg = arg('limit');
  // --file is the compact master (the one carrying the ticker); --detailed-file
  // is optional and only adds ISIN/underlying.
  const fileArg = arg('file');
  const detailedFileArg = arg('detailed-file');
  const seriesArg = arg('series');
  // `--series=all` disables the filter; anything else is an explicit allowlist.
  const series = seriesArg
    ? seriesArg.toLowerCase() === 'all'
      ? undefined
      : seriesArg.split(',').map((s) => s.trim().toUpperCase())
    : DEFAULT_SERIES;

  console.log(`segments        : ${segments.join(', ')}`);
  console.log(`series          : ${series ? series.join(', ') : 'ALL (no filter)'}`);
  console.log(`mode            : ${flag('dry') ? 'DRY RUN (no writes)' : 'apply'}`);
  if (limitArg) console.log(`limit           : ${limitArg}`);
  if (fileArg) console.log(`source          : ${fileArg}`);
  console.log('');

  try {
    const report = await service.sync({
      segments,
      series,
      dryRun: flag('dry'),
      deactivateMissing: flag('deactivate-missing'),
      limit: limitArg ? Number.parseInt(limitArg, 10) : undefined,
      compactCsv: fileArg ? readFileSync(fileArg, 'utf8') : undefined,
      detailedCsv: detailedFileArg ? readFileSync(detailedFileArg, 'utf8') : undefined,
      compactUrl: arg('compact-url'),
      detailedUrl: arg('detailed-url'),
    });

    console.log('--- sync report ---');
    console.log(`rows in scope   : ${report.totalRowsParsed}`);
    console.log(`out of scope    : ${report.outOfScopeRows} (filtered by segment/series — expected)`);
    console.log(`rows skipped    : ${report.skippedRows} (malformed — investigate if non-zero)`);
    console.log(`created         : ${report.created}`);
    console.log(`updated         : ${report.updated}`);
    console.log(`unchanged       : ${report.unchanged}`);
    console.log(`deactivated     : ${report.deactivated}`);
    console.log(`duration        : ${(report.durationMs / 1000).toFixed(1)}s`);

    if (report.symbolCollisions.length > 0) {
      // Reported, never silently resolved — Instrument.symbol is globally
      // unique and importing a colliding segment needs an explicit policy.
      console.log(`\nsymbol collisions: ${report.symbolCollisions.length} (rejected, not imported)`);
      for (const c of report.symbolCollisions.slice(0, 10)) {
        console.log(`  ${c.symbol}: kept ${c.keptSecurityId}, rejected ${c.rejected}`);
      }
      if (report.symbolCollisions.length > 10) console.log(`  ... and ${report.symbolCollisions.length - 10} more`);
    }

    if (report.errors.length > 0) {
      console.error(`\n${report.errors.length} error(s):`);
      for (const e of report.errors.slice(0, 10)) console.error(`  ${e}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
