import { Expectation, Blocked } from '../runner.mjs';

export { Expectation, Blocked };

/** Visible text of the page body, whitespace-collapsed. */
export async function bodyText(page) {
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
}

/**
 * A new customer creating an account through the real sign-up form.
 * Credentials come from the run's own generated account (see run.mjs), never
 * from the chat or from anything the customer "typed" in a prior session.
 */
export async function signUp(ctx, account) {
  const { page, baseUrl } = ctx;
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  const email = page.locator('input[type="email"]').first();
  await email.waitFor({ state: 'visible' });

  // The page is server-rendered and then hydrated; a click before hydration is
  // silently lost (the form looks ready but has no handlers). So the switch to
  // sign-up is retried until the button label actually changes.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  const createBtn = page.getByRole('button', { name: /^create account$/i });
  for (let attempt = 0; attempt < 4 && !(await createBtn.isVisible().catch(() => false)); attempt++) {
    await page.getByRole('button', { name: /need an account/i }).click().catch(() => {});
    await createBtn.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
  }
  if (!(await createBtn.isVisible().catch(() => false))) {
    throw new Expectation('The sign-in form has no working way to switch to "Create account".', {
      expected: 'Pressing "Need an account?" turns the form into a sign-up form.',
      actual: 'After four presses the button still read "Sign in".',
      severity: 'S1',
    });
  }

  await email.fill(account.email);
  await page.locator('input[type="password"]').first().fill(account.password);
  // The sign-up call itself is the evidence: the landing page keeps other
  // email fields on screen, so "the form went away" is not a reliable signal.
  const response = page.waitForResponse((r) => /\/auth\/signup$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 20_000 });
  await createBtn.click();
  const res = await response.catch(() => null);
  if (!res) {
    throw new Expectation('Pressing "Create account" sent nothing to the server.', {
      expected: 'The sign-up request is sent and answered.',
      actual: 'No sign-up request was seen within 20 s.',
      severity: 'S1',
    });
  }
  if (!res.ok()) {
    const alert = await page.locator('[role="alert"]').first().innerText().catch(() => '');
    throw new Expectation('Creating an account failed.', {
      expected: 'A new email and password create an account and sign the customer in.',
      actual: `Server answered ${res.status()}${alert ? `; the form said: "${alert.trim()}"` : ' and the form said nothing'}.`,
      severity: 'S1',
    });
  }
  // Let the app store the session and move on before the next step reads the page.
  await page.waitForTimeout(1500);
}

/**
 * The "Set your limits for today" prompt (discipline session). A real customer
 * meets it the first time they open the app and has to deal with it, so the
 * journey does too: it picks modest limits like a cautious beginner would. That
 * it appears, and what it blocks, is itself reported once per run.
 */
async function handleLimitsPrompt(ctx) {
  const { page } = ctx;
  const heading = page.getByText(/set your limits for today/i).first();
  // The prompt arrives a moment after the page, once the session state has
  // loaded. Until it has been dealt with once, give it time to appear; after
  // that, only a quick look (it does not come back the same day).
  const shown = await heading
    .waitFor({ state: 'visible', timeout: ctx.limitsHandled ? 400 : 5000 })
    .then(() => true)
    .catch(() => false);
  if (!shown) return;
  ctx.limitsHandled = true;

  if (!ctx.seenLimitsPrompt) {
    ctx.seenLimitsPrompt = true;
    const closeable = await page.getByRole('button', { name: /close|dismiss|skip|not now/i }).first().isVisible().catch(() => false);
    if (!closeable) {
      ctx.observe({
        kind: 'blocking-prompt',
        severity: 'S3',
        message: 'A "Set your limits for today" prompt covers whatever page a new customer opens, with no way to close it.',
        where: ctx.route(),
        expected: 'A prompt that is not part of the task in hand can be dismissed, or does not cover Settings and read-only pages.',
        actual: `The prompt covered ${ctx.route()} and offered only "Start the session" (all three limits required).`,
      });
    }
  }
  await page.getByRole('button', { name: '30m', exact: true }).click();
  await page.getByRole('button', { name: '5', exact: true }).click();
  await page.getByRole('button', { name: '₹5,000', exact: true }).click();
  await page.getByRole('button', { name: /start the session/i }).click();
  await heading.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

/** Opens an in-app route the way a customer would: by URL, then waits for it to settle. */
export async function open(ctx, path) {
  await ctx.page.goto(`${ctx.baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  await ctx.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await handleLimitsPrompt(ctx);
}

/** The rupee figures visible on a page, as numbers, for sanity checks. */
export function rupeeAmounts(text) {
  return [...text.matchAll(/₹\s?([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
}
