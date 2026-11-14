import { Expectation, Blocked, bodyText, open, signUp } from './common.mjs';

/**
 * "Ravi" — trades weekly index options. Wants the option chain, a strike to
 * trade, a way out of the position, and honest numbers on every screen.
 */
const steps = [
  'Sign in',
  'Open the option chain',
  'Check the chain is not inventing numbers',
  'Look at open positions',
  'Read order history columns',
];

export default {
  name: 'options-trader',
  title: 'Ravi, a weekly-expiry options trader',
  plannedSteps: steps,
  async run(ctx) {
    const { page } = ctx;
    await ctx.step(steps[0], () => signUp(ctx, ctx.accounts.get('options-trader')), { critical: true });

    let chainText = '';
    await ctx.step(steps[1], async () => {
      await open(ctx, '/trade');
      const chainTab = page.getByRole('tab', { name: /option chain/i }).or(page.getByRole('button', { name: /option chain/i })).first();
      await chainTab.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {
        throw new Expectation('There is no way to reach the option chain from the trade screen.', {
          expected: 'An "Option Chain" tab or button on /trade.',
          actual: 'Not found within 20 s.',
          severity: 'S2',
        });
      });
      await chainTab.click();
      await page.waitForTimeout(2500);
      chainText = await bodyText(page);
    });

    await ctx.step(steps[2], async () => {
      // D-07: with no live chain the screen used to fall back to a NIFTY
      // constant of 23900 and compute Greeks from a placeholder IV — numbers
      // that look like market data and are not.
      const showsInvented = /\b23,?900\b/.test(chainText);
      const says = /unavailable|not available|no (live )?(option )?chain|try again|could not reach|connection problem/i.test(chainText);
      if (showsInvented && !says) {
        throw new Expectation('The option chain shows a spot price that was not read from any market.', {
          expected: 'With no live chain, the screen says the chain is unavailable and shows no spot, strikes or Greeks.',
          actual: 'A spot of 23,900 (a hard-coded NIFTY constant) is on screen with no "unavailable" notice.',
          severity: 'S1',
        });
      }
      if (!says && !/CE|PE|strike/i.test(chainText)) {
        throw new Expectation('The option chain tab is blank — no chain and no explanation.', {
          expected: 'Either a chain, or a plain statement that it is unavailable.',
          actual: 'Neither. The customer cannot tell whether it is loading, broken or empty.',
        });
      }
      if (says && !showsInvented) throw new Blocked('No live option chain in this environment (no market-data feed); the screen said so plainly, which is the correct behaviour.');
    });

    await ctx.step(steps[3], async () => {
      await open(ctx, '/positions');
      const text = await bodyText(page);
      if (!/position/i.test(text)) {
        throw new Expectation('The positions screen does not say anything about positions.', {
          expected: 'A positions table or "no open positions".',
          actual: 'No mention of positions on the page.',
        });
      }
    });

    await ctx.step(steps[4], async () => {
      await open(ctx, '/orders');
      await page.getByRole('tab', { name: 'Executed' }).click();
      await page.waitForTimeout(800);
      const text = await bodyText(page);
      // With no orders there is no table; the columns are only checkable once one exists.
      if (/No executed orders/i.test(text)) {
        throw new Blocked('This customer has no executed orders (no live prices to fill one), so the Placed by / Charges columns could not be checked. Seed agent-linked orders to cover them.');
      }
      for (const col of ['Placed by', 'Charges']) {
        if (!new RegExp(col, 'i').test(text)) {
          throw new Expectation(`Order history has no "${col}" column.`, {
            expected: 'Order history shows who placed each order and the charges on it.',
            actual: `No "${col}" column found.`,
          });
        }
      }
    });
  },
};
