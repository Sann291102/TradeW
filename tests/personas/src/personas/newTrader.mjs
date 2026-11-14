import { Expectation, Blocked, bodyText, open, signUp } from './common.mjs';

/**
 * "Asha" — has never used TradeW. Signs up, looks around the dashboard, tries
 * to place her first paper trade, then checks where that trade went.
 */
const steps = [
  'Create an account',
  'Read the dashboard',
  'Open the trade screen',
  'Place a first paper order',
  'Find the order in Orders',
  'Find the trade in Trade History',
];

export default {
  name: 'new-trader',
  title: 'Asha, a first-time retail trader',
  plannedSteps: steps,
  async run(ctx) {
    const { page } = ctx;
    const account = ctx.accounts.get('new-trader');

    await ctx.step(steps[0], () => signUp(ctx, account), { critical: true });

    await ctx.step(steps[1], async () => {
      await open(ctx, '/dashboard');
      const text = await bodyText(page);
      // D-06: the dashboard once showed hard-coded "Risk Alerts" every day, to a
      // customer who has done nothing — advice that came from no data at all.
      if (/India VIX up sharply|into today's weekly expiry/i.test(text)) {
        ctx.observe({
          kind: 'canned-risk-alert',
          severity: 'S1',
          message: 'The dashboard shows a canned risk alert to a brand-new account.',
          where: ctx.route(),
          expected: 'A customer with no activity sees no risk alerts, or alerts that come from real observations.',
          actual: "A fixed 'India VIX up sharply into today's weekly expiry…' alert is on screen for everyone, every day (defect D-06).",
        });
      }
      // D-06 (mock watchlist / prices): when the page itself says live data is
      // unreachable, it must not also show index levels and quotes as if live.
      const feedDown = /live chart data unreachable|market-data bridge could not be reached|live feed not connected/i.test(text);
      const showsLevels = /NIFTY 50\s+\d{2},\d{3}\.\d{2}/.test(text) || /RELIANCE\s+[\d,]+\.\d{2}/.test(text);
      if (feedDown && showsLevels) {
        ctx.observe({
          kind: 'prices-while-feed-down',
          severity: 'S1',
          message: 'The dashboard shows index levels and a watchlist with prices while telling the customer live data is unreachable.',
          where: ctx.route(),
          expected: 'With no live feed, prices are shown as unavailable (a dash or "no data"), never as numbers.',
          actual: 'NIFTY 50, NIFTY Bank, Sensex, India VIX and watchlist prices (e.g. RELIANCE, INFY) are on screen next to "Live chart data unreachable". These are the hard-coded sample prices (defect D-06) presented as if current.',
        });
      }
    });

    await ctx.step(steps[2], async () => {
      await open(ctx, '/trade');
      // D-10: a 100%-off Pro code is a fixed string in the source. If the app
      // prints it for every free customer, anyone can take Pro for free.
      const trade = await bodyText(page);
      const promo = trade.match(/Use code\s+(\S+)\s+for\s+[^.]*?100%\s*Free\s*PRO/i);
      if (promo) {
        ctx.observe({
          kind: 'public-100pct-coupon',
          severity: 'S2',
          message: `A 100%-off Pro coupon code is displayed in the app to a brand-new free account (${promo[1]}).`,
          where: ctx.route(),
          expected: 'A free account is not shown a code that gives Pro away for nothing, unless that is a deliberate, time-limited promotion.',
          actual: `The Sentinel card on /trade says "Use code ${promo[1]} for 1 Month 100% Free PRO". Defect D-10 notes the code is hard-coded in source. Confirm whether this is an intended promotion.`,
        });
      }
      const ticket = page.getByRole('button', { name: /(BUY|SELL) · Paper/ }).first();
      await ticket.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {
        throw new Expectation('The trade screen shows no order ticket.', {
          expected: 'A BUY/SELL paper ticket is visible on /trade.',
          actual: 'No "BUY · Paper" / "SELL · Paper" button appeared within 20 s.',
          severity: 'S1',
        });
      });
    });

    await ctx.step(steps[3], async () => {
      const ticket = page.getByRole('button', { name: /BUY · Paper/ }).first();
      if (await ticket.isDisabled()) {
        const why = (await ticket.getAttribute('title')) || (await ticket.evaluate((b) => b.parentElement?.innerText ?? ''));
        // A disabled ticket must say why. A silent grey button is a dead end.
        if (!why || !why.trim()) {
          throw new Expectation('The BUY button is disabled and gives no reason.', {
            expected: 'A disabled order button explains why (e.g. "Sign in", "Enter a quantity").',
            actual: 'Disabled, with no tooltip or helper text.',
          });
        }
        throw new Blocked(`The ticket is disabled ("${why.trim().slice(0, 80)}") — lot size and contract details come from the market-data bridge, which is not running here, so this cannot be judged.`);
      }
      await ticket.click();
      const result = page.getByText(/^(PLACED|FAILED)$/).first();
      await result.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {
        throw new Expectation('Pressing BUY gave the customer no result.', {
          expected: 'A PLACED or FAILED result with a reason appears after pressing BUY.',
          actual: 'Nothing changed on screen within 20 s.',
          severity: 'S1',
        });
      });
      const outcome = (await result.innerText()).trim();
      const detail = await result.locator('xpath=..').innerText().catch(() => '');
      if (outcome === 'FAILED') {
        // The reason is the customer's only clue; whether it is the environment's
        // fault is decided by the runner from the words in it.
        throw new Expectation(`The first paper order failed: ${detail.replace(/\s+/g, ' ').trim()}`, {
          expected: 'A first market order on a liquid instrument is placed.',
          actual: detail.replace(/\s+/g, ' ').trim(),
          envDependent: true,
        });
      }
    });

    await ctx.step(steps[4], async () => {
      await open(ctx, '/orders');
      await page.getByRole('tab', { name: 'Executed' }).click();
      await page.waitForTimeout(800);
      const text = await bodyText(page);
      if (!/Placed by/i.test(text) && !/No executed orders/i.test(text)) {
        throw new Expectation('The Orders screen shows neither orders nor an empty message.', {
          expected: 'Either an order table (with a "Placed by" column) or "No executed orders".',
          actual: 'Neither was found on the Executed tab.',
        });
      }
    });

    await ctx.step(steps[5], async () => {
      await open(ctx, '/portfolio');
      await page.getByRole('button', { name: /trade history/i }).first().click();
      await page.waitForTimeout(800);
      const text = await bodyText(page);
      if (!/Closed by/i.test(text) && !/No trades yet/i.test(text)) {
        throw new Expectation('Trade History shows neither trades nor an empty message.', {
          expected: 'A trade table (with a "Closed by" column) or "No trades yet".',
          actual: 'Neither was found.',
        });
      }
    });
  },
};
