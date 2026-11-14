import { Expectation, Blocked, bodyText, open, signUp, rupeeAmounts } from './common.mjs';

/**
 * "Meera" — has been paper trading for a while, wants a clean slate. Looks for
 * the reset in Settings, changes her mind once, then goes through with it and
 * checks the rest of the app agrees her balance is back to ₹10,00,000.
 */
const steps = [
  'Sign in',
  'Find the reset in Settings',
  'Back out of the reset',
  'Reset the balance',
  'Check the portfolio shows ₹10,00,000',
];

const TEN_LAKH = 1_000_000;

export default {
  name: 'housekeeping',
  title: 'Meera, wanting a clean slate',
  plannedSteps: steps,
  async run(ctx) {
    const { page } = ctx;
    await ctx.step(steps[0], () => signUp(ctx, ctx.accounts.get('housekeeping')), { critical: true });

    await ctx.step(steps[1], async () => {
      await open(ctx, '/settings/trading');
      const btn = page.getByRole('button', { name: /reset balance/i });
      await btn.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {
        throw new Expectation('Settings → Trading has no way to reset the paper balance.', {
          expected: 'A "Reset balance to ₹10,00,000" control.',
          actual: 'No such button found.',
          severity: 'S1',
        });
      });
    });

    await ctx.step(steps[2], async () => {
      await page.getByRole('button', { name: /reset balance/i }).click();
      const text = await bodyText(page);
      if (!/cannot be undone/i.test(text)) {
        throw new Expectation('Reset happens (or is offered) without a warning that it cannot be undone.', {
          expected: 'A confirmation that says this cannot be undone.',
          actual: 'No such warning shown after pressing the reset button.',
        });
      }
      await page.getByRole('button', { name: /^cancel$/i }).click();
      if (await page.getByText(/balance reset to/i).isVisible().catch(() => false)) {
        throw new Expectation('Pressing Cancel on the reset confirmation still reset the balance.', {
          expected: 'Cancel leaves the account untouched.',
          actual: 'A "Balance reset" message appeared after Cancel.',
          severity: 'S1',
        });
      }
    });

    await ctx.step(steps[3], async () => {
      await page.getByRole('button', { name: /reset balance/i }).click();
      await page.getByRole('button', { name: /yes, reset my balance/i }).click();
      const done = page.getByText(/balance reset to/i);
      await done.waitFor({ state: 'visible', timeout: 15_000 }).catch(async () => {
        const alert = await page.locator('[role="alert"]').first().innerText().catch(() => '');
        throw new Expectation('Confirming the reset gave no success message.', {
          expected: 'A "Balance reset to ₹10,00,000" confirmation.',
          actual: alert ? `An error appeared: "${alert.trim()}"` : 'No message of any kind.',
          severity: 'S1',
        });
      });
    });

    await ctx.step(steps[4], async () => {
      await open(ctx, '/portfolio');
      const text = await bodyText(page);
      const amounts = rupeeAmounts(text);
      if (!amounts.includes(TEN_LAKH)) {
        // On a fresh wallet this also fails if the portfolio never loaded.
        if (/sign in|temporarily unavailable|could not load/i.test(text)) {
          throw new Blocked('The portfolio did not load, so the balance could not be read.');
        }
        throw new Expectation('After the reset the portfolio does not show ₹10,00,000.', {
          expected: 'Available balance / net worth of ₹10,00,000 on the portfolio summary.',
          actual: `Rupee amounts on the page: ${amounts.slice(0, 8).join(', ') || 'none'}.`,
          severity: 'S1',
        });
      }
    });
  },
};
