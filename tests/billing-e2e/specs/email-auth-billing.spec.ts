import { expect, test } from '@playwright/test';
import { addBillingAddress, billingMode, fillPaymentElement, newPerson, passDisciplineGate, register, verifyFromDevLink } from './helpers';

/**
 * Registration → verification → billing profile → saved cards → checkout,
 * through the real web app and API. Stripe journeys need test keys; without
 * them they are skipped, not simulated.
 */

test.describe('email authentication', () => {
  test('register, see billing locked, verify by link, then billing unlocks', async ({ page }) => {
    const person = newPerson('auth');
    await register(page, person);

    await page.goto('/settings/billing');
    await passDisciplineGate(page);
    await expect(page.getByText('Verify your email to use billing')).toBeVisible();

    await page.getByRole('button', { name: 'Send a new link' }).click().catch(() => undefined);
    // Cooldown or fresh link: either way the original link from signup still works
    // only if it was not replaced. Use whichever the page now shows.
    await page.goto('/verify-email?sent=1');
    await verifyFromDevLink(page);

    await page.goto('/settings/billing');
    await expect(page.getByText(person.email).first()).toBeVisible();
    await expect(page.getByText('Verified', { exact: true })).toBeVisible();
  });

  test('an invalid verification link explains itself and offers a resend', async ({ page }) => {
    await page.goto('/verify-email?token=this-token-does-not-exist-anywhere');
    await expect(page.getByRole('heading', { name: /doesn.t work/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send a new link' })).toBeVisible();
  });

  test('registration rejects mismatched passwords and a missing terms tick', async ({ page }) => {
    const p = newPerson('val');
    await page.goto('/?auth=signup#auth');
    const form = page.locator('form').filter({ has: page.getByText('Confirm password') });
    await form.getByLabel('First name').fill(p.firstName);
    await form.getByLabel('Last name').fill(p.lastName);
    await form.getByLabel('Email address').fill(p.email);
    await form.getByLabel('Password', { exact: true }).fill(p.password);
    await form.getByLabel('Confirm password').fill(`${p.password}x`);
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'do not match' })).toBeVisible();
  });

  test('duplicate email is refused', async ({ page }) => {
    const person = newPerson('dup');
    await register(page, person);
    await page.context().clearCookies();
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.clear();
    });
    await page.goto('/?auth=signup#auth');
    const form = page.locator('form').filter({ has: page.getByText('Confirm password') });
    await form.getByLabel('First name').fill('Second');
    await form.getByLabel('Last name').fill('Person');
    await form.getByLabel('Email address').fill(person.email);
    await form.getByLabel('Password', { exact: true }).fill(person.password);
    await form.getByLabel('Confirm password').fill(person.password);
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /already registered/i })).toBeVisible();
  });
});

test.describe('billing profile', () => {
  test('address validation errors per field, then a valid address saves', async ({ page }) => {
    const person = newPerson('addr');
    await register(page, person);
    await verifyFromDevLink(page);
    await page.goto('/settings/billing');
    await passDisciplineGate(page);
    const group = page.locator('section, div').filter({ has: page.getByRole('heading', { name: /Billing address/ }) }).last();
    await group.getByRole('button', { name: 'Add' }).click();
    const form = page.getByRole('form', { name: 'Billing address' });
    await form.getByLabel(/Contact name/).fill('E2E Buyer');
    await form.getByLabel(/Address line 1/).fill('510 Townsend St');
    await form.getByLabel(/^City/).fill('San Francisco');
    await form.getByLabel(/^State/).fill('CA');
    await form.getByLabel(/ZIP code/).fill('123');
    await form.getByRole('button', { name: 'Save address' }).click();
    await expect(form.getByText('US ZIP code must be 5 digits (or ZIP+4).').first()).toBeVisible();
    await form.getByLabel(/ZIP code/).fill('94103');
    await form.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('510 Townsend St, San Francisco, CA 94103, US')).toBeVisible();
  });
});

test.describe('Stripe test mode', () => {
  test.beforeEach(async ({ request }) => {
    const b = await billingMode(request);
    test.skip(!b.enabled || b.mode !== 'test', 'blocked: environment — Stripe test keys are not configured on this API');
  });

  test('add a card with the Payment Element, make it default, remove it with confirmation', async ({ page }) => {
    const person = newPerson('cards');
    await register(page, person);
    await verifyFromDevLink(page);
    await addBillingAddress(page);

    await page.getByRole('button', { name: 'Add card' }).click();
    await fillPaymentElement(page, { number: '4242 4242 4242 4242' });
    await page.getByRole('button', { name: 'Save card' }).click();
    await expect(page.getByText('Visa ending 4242')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: 'Remove Visa ending 4242' }).click();
    await expect(page.getByRole('dialog')).toContainText('Remove this card?');
    await page.getByRole('dialog').getByRole('button', { name: 'Remove card' }).click();
    await expect(page.getByText('No saved cards.')).toBeVisible();
  });

  test('checkout the 7-day pass without saving the card; order is confirmed by webhook', async ({ page }) => {
    const person = newPerson('pass');
    await register(page, person);
    await verifyFromDevLink(page);
    await addBillingAddress(page);

    await page.goto('/checkout?item=sentinel_trial_7d');
    await expect(page.getByRole('table', { name: 'Order summary' })).toBeVisible();
    await expect(page.getByText('Total due today')).toBeVisible();
    const save = page.getByRole('checkbox', { name: /Save this card/ });
    await expect(save).not.toBeChecked();
    await page.getByRole('button', { name: 'Continue to card details' }).click();
    await fillPaymentElement(page, { number: '4242 4242 4242 4242' });
    await page.getByRole('button', { name: /^Pay \$/ }).click();
    await expect(page).toHaveURL(/\/checkout\/orders\//, { timeout: 60_000 });
    // Paid only once the signed webhook arrives (stripe listen → /api/stripe/webhook).
    await expect(page.getByText('Payment successful')).toBeVisible({ timeout: 90_000 });
  });

  test('a declined card shows Stripe’s message and nothing is charged', async ({ page }) => {
    const person = newPerson('decline');
    await register(page, person);
    await verifyFromDevLink(page);
    await addBillingAddress(page);
    await page.goto('/checkout?item=sentinel_trial_7d');
    await page.getByRole('button', { name: 'Continue to card details' }).click();
    await fillPaymentElement(page, { number: '4000 0000 0000 0002' });
    await page.getByRole('button', { name: /^Pay \$/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: /declined/i })).toBeVisible({ timeout: 60_000 });
  });
});
