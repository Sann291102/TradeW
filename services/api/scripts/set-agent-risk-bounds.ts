/**
 * Turn on the give-back and concentration bounds for every armed profile.
 *
 *   npm run agents:risk-bounds -w @tradew/api            # show current values
 *   npm run agents:risk-bounds -w @tradew/api -- --apply # write the defaults
 *
 * Both bounds ship NULL (= disabled) so that adding them changed no existing
 * profile's behaviour. This turns them on with conservative defaults.
 *
 * They can only ever REDUCE what an agent may do — there is no value of either
 * that permits more risk than the profile already had — so applying them is a
 * tightening, never a loosening. The numbers are a starting point and are meant
 * to be tuned per agent; they are deliberately not hard-coded anywhere in the
 * execution path.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { PrismaService } from '../src/prisma/prisma.service';

/** Give back 30% of the day's PEAK realised equity and entries stop. */
const MAX_DRAWDOWN_PCT = 30;
/** Combined premium at risk across a profile's open positions, % of equity. */
const MAX_PORTFOLIO_EXPOSURE_PCT = 40;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaService();
  await prisma.$connect();

  const profiles = await prisma.executionProfile.findMany({
    where: { environment: 'PAPER' },
    select: {
      id: true, name: true, enabled: true, capitalAllocationPct: true,
      maxLossPerDay: true, maxDrawdownPct: true, maxPortfolioExposurePct: true,
      partialExitEnabled: true, partialExitRMultiple: true, partialExitPct: true,
    },
    orderBy: { name: 'asc' },
  });

  console.log(`\n${profiles.length} PAPER profile(s)\n`);
  for (const p of profiles) {
    console.log(`  ${p.enabled ? '[ARMED]' : '[  off ]'} ${p.name}`);
    console.log(
      `      allocation/position ${Number(p.capitalAllocationPct)}%  ·  maxLossPerDay ₹${Number(p.maxLossPerDay).toLocaleString('en-IN')}`,
    );
    console.log(
      `      drawdown ${p.maxDrawdownPct == null ? 'OFF' : `${Number(p.maxDrawdownPct)}%`}` +
        `  ·  portfolio exposure ${p.maxPortfolioExposurePct == null ? 'OFF' : `${Number(p.maxPortfolioExposurePct)}%`}` +
        `  ·  partial exits ${p.partialExitEnabled ? `${Number(p.partialExitRMultiple)}R / ${p.partialExitPct}%` : 'OFF'}`,
    );
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to set drawdown ${MAX_DRAWDOWN_PCT}% and exposure ${MAX_PORTFOLIO_EXPOSURE_PCT}%.`);
    console.log('Partial exits are deliberately NOT set here — see the note in the schema: taking half off at +1R');
    console.log('raises the hit rate and caps the right tail, so it is a strategy choice per agent, not a default.\n');
    await prisma.$disconnect();
    return;
  }

  const updated = await prisma.executionProfile.updateMany({
    where: { environment: 'PAPER' },
    data: {
      maxDrawdownPct: MAX_DRAWDOWN_PCT,
      maxPortfolioExposurePct: MAX_PORTFOLIO_EXPOSURE_PCT,
    },
  });

  console.log(
    `\nApplied to ${updated.count} profile(s): drawdown ${MAX_DRAWDOWN_PCT}%, portfolio exposure ${MAX_PORTFOLIO_EXPOSURE_PCT}%.`,
  );
  console.log('Both are enforced in `evaluatePolicy` on the NEXT evaluate tick — no restart needed,');
  console.log('because the policy reads the profile row every pass.\n');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
