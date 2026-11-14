import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Expectation, bodyText, open, signUp } from './common.mjs';

/**
 * "Priya" — has an agent trading on her account and wants to tell its orders
 * from her own, see how each ended, and see what each cost.
 *
 * The agent loop cannot run here (it needs the live market feed and Sentinel),
 * so one agent round-trip is SEEDED into the isolated database straight after
 * she signs up. The report says so: this journey checks how the app SHOWS
 * agent orders, not whether an agent produces them.
 */
const steps = [
  'Sign in',
  'Agent orders are seeded (not produced by a live agent)',
  'See which orders the agent placed',
  'See how the agent exited',
  'See the trade in Trade History',
  'See the charges on an order',
];

const SEED = join(dirname(fileURLToPath(import.meta.url)), '..', 'seedAgentTrade.mjs');

export default {
  name: 'agent-watcher',
  title: 'Priya, whose agent trades for her',
  plannedSteps: steps,
  async run(ctx) {
    const { page } = ctx;
    const account = ctx.accounts.get('agent-watcher');
    await ctx.step(steps[0], () => signUp(ctx, account), { critical: true });

    await ctx.step(
      steps[1],
      async () => {
        execFileSync(process.execPath, [SEED, account.email], { stdio: 'pipe' });
      },
      { critical: true },
    );

    await ctx.step(steps[2], async () => {
      await open(ctx, '/orders');
      await page.getByRole('tab', { name: 'Executed' }).click();
      await page.waitForTimeout(1200);
      const badges = await page.getByText('Agent', { exact: true }).count();
      if (badges < 2) {
        throw new Expectation('The agent\'s orders are not marked as the agent\'s in order history.', {
          expected: 'Both the agent\'s entry and its exit carry an "Agent" badge (2), and the customer\'s own order does not.',
          actual: `${badges} "Agent" badge(s) found among the executed orders.`,
          severity: 'S1',
        });
      }
      if (badges > 2) {
        throw new Expectation('More orders are marked as the agent\'s than the agent placed.', {
          expected: 'Exactly the agent\'s entry and exit are badged; the customer\'s own order is not.',
          actual: `${badges} "Agent" badges for 2 agent orders and 1 manual order.`,
          severity: 'S1',
        });
      }
    });

    await ctx.step(steps[3], async () => {
      const text = await bodyText(page);
      if (!/Exit\s*·\s*Square-off/i.test(text) || !/Entry/.test(text)) {
        throw new Expectation('Order history does not say which half of the agent\'s trade each order was, or why it exited.', {
          expected: 'The agent\'s orders read "Entry" and "Exit · Square-off".',
          actual: 'Those labels were not found next to the Agent badges.',
        });
      }
    });

    await ctx.step(steps[4], async () => {
      await open(ctx, '/portfolio');
      await page.getByRole('button', { name: /trade history/i }).first().click();
      await page.waitForTimeout(1200);
      const text = await bodyText(page);
      if (!/Closed by/i.test(text) || !/Agent/.test(text)) {
        throw new Expectation('Trade History does not show that the agent closed the trade.', {
          expected: 'A "Closed by" column with an Agent badge on the agent\'s closed trade.',
          actual: 'No "Closed by" column, or no Agent badge, on the trade.',
          severity: 'S1',
        });
      }
    });

    await ctx.step(steps[5], async () => {
      await open(ctx, '/orders');
      await page.getByRole('tab', { name: 'Executed' }).click();
      await page.waitForTimeout(1000);
      const text = await bodyText(page);
      if (!/Charges/i.test(text) || !/1\.95|2\.15/.test(text)) {
        throw new Expectation('Order history does not show what each order cost in charges.', {
          expected: 'A Charges column showing each filled order\'s charges (₹1.95 / ₹2.15 for the seeded orders).',
          actual: 'No Charges column, or the seeded charge amounts are not shown.',
        });
      }
    });
  },
};
