import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/** Fictional, per-run account. example.com only. */
export function newPerson(tag: string) {
  const id = randomUUID().slice(0, 8);
  return {
    firstName: 'E2E',
    lastName: tag,
    email: `e2e-${tag}-${id}@example.com`,
    // Generated per run for a throwaway account on an isolated database.
    password: `E2e-${id}-pw9`,
  };
}

export async function billingMode(request: APIRequestContext): Promise<{ enabled: boolean; mode: string }> {
  const res = await request.get('/api/payments/catalog');
  const body = await res.json();
  return { enabled: Boolean(body.billingEnabled), mode: body.mode };
}

/**
 * The workspace opens a "Set your limits for today" discipline modal on first
 * entry. It is an existing feature, not part of billing; fill it the way a
 * user would so it does not cover the page under test.
 */
export async function passDisciplineGate(page: Page) {
  const dialog = page.getByText('Set your limits for today');
  if (await dialog.isVisible({ timeout: 4000 }).catch(() => false)) {
    await page.getByRole('button', { name: '30m', exact: true }).click();
    await page.getByRole('button', { name: '3', exact: true }).first().click();
    await page.getByRole('button', { name: /1,000/ }).first().click();
    await page.getByRole('button', { name: 'Start the session' }).click();
    await expect(dialog).toBeHidden();
  }
}

export async function register(page: Page, person: ReturnType<typeof newPerson>) {
  await page.goto('/?auth=signup#auth');
  const form = page.locator('form').filter({ has: page.getByText('Confirm password') });
  await form.getByLabel('First name').fill(person.firstName);
  await form.getByLabel('Last name').fill(person.lastName);
  await form.getByLabel('Email address').fill(person.email);
  await form.getByLabel('Password', { exact: true }).fill(person.password);
  await form.getByLabel('Confirm password').fill(person.password);
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/verify-email\?sent=1/);
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
}

/**
 * Verify through the link the server produced. With no mail provider
 * configured (this stack), the API hands the link back and the page shows it;
 * that is the same token a real email would carry.
 */
export async function verifyFromDevLink(page: Page) {
  const link = page.getByRole('link', { name: /verification link/i });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
}

export async function addBillingAddress(page: Page) {
  await page.goto('/settings/billing');
  await passDisciplineGate(page);
  const group = page.locator('section, div').filter({ has: page.getByRole('heading', { name: /Billing address/ }) }).last();
  await group.getByRole('button', { name: /^(Add|Edit)$/ }).click();
  const form = page.getByRole('form', { name: 'Billing address' });
  await form.getByLabel(/Contact name/).fill('E2E Buyer');
  await form.getByLabel(/Address line 1/).fill('510 Townsend St');
  await form.getByLabel(/^City/).fill('San Francisco');
  await form.getByLabel(/^State/).fill('CA');
  await form.getByLabel(/ZIP code/).fill('94103');
  await form.getByRole('button', { name: 'Save address' }).click();
  await expect(page.getByText('510 Townsend St, San Francisco, CA 94103, US')).toBeVisible();
}

/** Type into Stripe's Payment Element (cross-origin iframe). Published test card numbers only. */
export async function fillPaymentElement(page: Page, card: { number: string; exp?: string; cvc?: string }) {
  const frame = page.frameLocator('iframe[title*="payment input"], iframe[name^="__privateStripeFrame"]').first();
  await frame.getByPlaceholder(/1234 1234 1234 1234/).fill(card.number);
  await frame.getByPlaceholder(/MM \/ YY/).fill(card.exp ?? '12 / 34');
  await frame.getByPlaceholder(/CVC/).fill(card.cvc ?? '123');
  const zip = frame.getByPlaceholder(/12345|ZIP/);
  if (await zip.isVisible().catch(() => false)) await zip.fill('94103');
}
