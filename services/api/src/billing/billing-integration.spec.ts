import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import Stripe = require('stripe');
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { EmailService } from '../mail/email.service';
import { SmsService } from '../sms/sms.service';
import { OtpService } from '../auth/otp.service';
import { AuthService, MAX_FAILED_LOGINS } from '../auth/auth.service';
import { EmailVerificationService } from '../auth/email-verification.service';
import { VerifiedEmailGuard } from '../auth/verified-email.guard';
import { PersonaService } from '../ai/persona/persona.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { NotificationService } from '../notification/notification.service';
import { StripeGateway } from './stripe.gateway';
import { StripeCustomerService } from './stripe-customer.service';
import { StripePriceService } from './stripe-price.service';
import { CustomerService } from './customer.service';
import { PaymentMethodsService } from './payment-methods.service';
import { CheckoutService } from './checkout.service';
import { BillingFulfilmentService } from './billing-fulfilment.service';
import { StripeWebhookService } from './stripe-webhook.service';
import { TRIAL_ITEM } from './billing.catalog';

/**
 * Email auth + Stripe billing, against a REAL Postgres and (when a test key
 * is present) the REAL Stripe test-mode API.
 *
 *   TEST_DATABASE_URL       required; an isolated database, never shared dev data
 *   STRIPE_TEST_SECRET_KEY  optional sk_test_… key; enables the Stripe cases
 *   STRIPE_TEST_PUBLISHABLE_KEY  its pk_test_… pair
 *
 * Without a Stripe key the Stripe-calling cases are SKIPPED (reported as
 * blocked by environment), never simulated. Webhook cases always run: they
 * sign payloads with a local secret through Stripe's own
 * `generateTestHeaderString`, which is how Stripe documents testing
 * signature verification. In online mode those payloads are the real
 * PaymentIntent/Invoice/Charge objects just created in test mode.
 *
 * Card data: only Stripe's published test PaymentMethods (pm_card_visa,
 * pm_card_chargeDeclined, pm_card_threeDSecure2Required) are used. No card
 * number is ever sent from this code.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const LIVE_STRIPE_KEY = process.env.STRIPE_TEST_SECRET_KEY ?? '';
const ONLINE = /^sk_test_|^rk_test_/.test(LIVE_STRIPE_KEY);
const WEBHOOK_SECRET = 'whsec_integration_local_secret';
const T = 90_000;

const db = DATABASE_URL ? describe : describe.skip;
const online = DATABASE_URL && ONLINE ? describe : describe.skip;

let prisma: PrismaService;
let email: EmailService;
let gateway: StripeGateway;
let auth: AuthService;
let verification: EmailVerificationService;
let customers: StripeCustomerService;
let customerSvc: CustomerService;
let methods: PaymentMethodsService;
let checkout: CheckoutService;
let webhooks: StripeWebhookService;
let entitlements: EntitlementsService;
const createdEmails: string[] = [];

function uniqueEmail(tag: string) {
  const e = `it-${tag}-${randomUUID().slice(0, 8)}@example.com`;
  createdEmails.push(e);
  return e;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

function signed(payload: object) {
  const body = JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET });
  return { raw: Buffer.from(body), header };
}

function eventFor(type: string, object: unknown, livemode = false) {
  return {
    id: `evt_it_${randomUUID().replace(/-/g, '')}`,
    object: 'event',
    api_version: '2026-10-28.endive',
    created: Math.floor(Date.now() / 1000),
    livemode,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

async function signup(tag: string, password = 'Passw0rd!x') {
  const addr = uniqueEmail(tag);
  const res = await auth.signup({ email: addr, password, firstName: 'Test', lastName: tag, acceptTerms: true }, { ip: '203.0.113.9' });
  return { email: addr, password, res };
}

async function verifiedUser(tag: string) {
  const s = await signup(tag);
  await prisma.user.update({ where: { id: s.res.user.id }, data: { emailVerifiedAt: new Date() } });
  return s;
}

const US_ADDRESS = { name: 'Test Buyer', line1: '510 Townsend St', city: 'San Francisco', state: 'CA', postalCode: '94103', country: 'US' };

beforeAll(async () => {
  if (!DATABASE_URL) return;
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.EMAIL_PROVIDER = 'console';
  process.env.STRIPE_MODE = 'test';
  process.env.STRIPE_RETRY_SWEEP = 'false';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  // Offline: syntactically valid test keys that Stripe will reject, which is
  // exactly the "Stripe is unavailable" case for provisioning.
  process.env.STRIPE_SECRET_KEY = ONLINE ? LIVE_STRIPE_KEY : 'sk_test_offline_integration';
  process.env.STRIPE_PUBLISHABLE_KEY = ONLINE ? process.env.STRIPE_TEST_PUBLISHABLE_KEY || 'pk_test_unused' : 'pk_test_offline_integration';

  prisma = new PrismaService();
  await prisma.$connect();
  const mail = new MailService();
  email = new EmailService(prisma, mail);
  gateway = new StripeGateway();
  customers = new StripeCustomerService(prisma, gateway);
  verification = new EmailVerificationService(prisma, email);
  const otp = new OtpService(prisma, mail, new SmsService(), email);
  auth = new AuthService(prisma, new JwtService({ secret: 'integration-only-secret' }), otp, email, new PersonaService(prisma), verification, customers);
  entitlements = new EntitlementsService(prisma);
  const notifications = new NotificationService(prisma);
  const prices = new StripePriceService(gateway);
  customerSvc = new CustomerService(prisma, customers, gateway, email);
  methods = new PaymentMethodsService(prisma, gateway, customers, email);
  checkout = new CheckoutService(prisma, gateway, customers, prices, methods, entitlements, customerSvc);
  const fulfilment = new BillingFulfilmentService(prisma, gateway, entitlements, email, notifications, customers);
  webhooks = new StripeWebhookService(prisma, gateway, customers, methods, fulfilment);
}, T);

afterAll(async () => {
  if (!prisma) return;
  // Remove only what this suite created.
  const users = await prisma.user.findMany({ where: { email: { in: createdEmails } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.billingOrder.deleteMany({ where: { userId: { in: ids } } });
    await prisma.subscription.deleteMany({ where: { userId: { in: ids } } });
    await prisma.usageCounter.deleteMany({ where: { userId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditEvent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.emailDeliveryLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.otp.deleteMany({ where: { destination: { in: createdEmails } } });
  await prisma.$disconnect();
});

// ============================================================ registration

db('registration', () => {
  it('creates an unverified account with names and terms, and emails a verification link', async () => {
    const { email: addr, res } = await signup('reg');
    expect(res.user.emailVerified).toBe(false);
    expect((res as { devVerifyUrl?: string }).devVerifyUrl).toMatch(/\/verify-email\?token=/);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: addr } });
    expect(user).toMatchObject({ firstName: 'Test', lastName: 'reg', emailVerifiedAt: null });
    expect(user.termsAcceptedAt).toBeInstanceOf(Date);
    expect(user.passwordHash).not.toContain('Passw0rd');
    const log = await prisma.emailDeliveryLog.findFirst({ where: { toAddress: addr, templateKey: 'verify_email' } });
    expect(log?.status).toBe('console');
  }, T);

  it('rejects a duplicate email, whatever its case or spacing', async () => {
    const { email: addr } = await signup('dup');
    await expect(
      auth.signup({ email: `  ${addr.toUpperCase()} `, password: 'Passw0rd!x', firstName: 'A', lastName: 'B', acceptTerms: true }),
    ).rejects.toThrow(/already registered/);
  }, T);

  it('refuses registration without terms acceptance', async () => {
    await expect(
      auth.signup({ email: uniqueEmail('terms'), password: 'Passw0rd!x', firstName: 'A', lastName: 'B', acceptTerms: false }),
    ).rejects.toThrow(/Terms/);
  }, T);

  (ONLINE ? it.skip : it)('keeps the account when Stripe is unavailable, and records the error for retry', async () => {
    const { email: addr } = await signup('stripedown');
    const user = await waitFor(async () => {
      const u = await prisma.user.findUnique({ where: { email: addr } });
      return u?.stripeCustomerError ? u : null;
    }, 20_000);
    expect(user.stripeCustomerId).toBeNull();
    expect(user.stripeCustomerError).toBeTruthy();
  }, T);
});

// ============================================================ verification

db('email verification', () => {
  it('verifies once, then reports already-verified, and sends the welcome email', async () => {
    const { email: addr, res } = await signup('verify');
    const token = new URL((res as { devVerifyUrl: string }).devVerifyUrl).searchParams.get('token')!;
    expect(await auth.verifyEmail(token)).toEqual({ status: 'verified', email: addr });
    expect(await auth.verifyEmail(token)).toEqual({ status: 'already_verified', email: addr });
    const u = await prisma.user.findUniqueOrThrow({ where: { email: addr } });
    expect(u.emailVerifiedAt).toBeInstanceOf(Date);
    await waitFor(() => prisma.emailDeliveryLog.findFirst({ where: { toAddress: addr, templateKey: 'welcome' } }));
  }, T);

  it('rejects an invalid token', async () => {
    await expect(auth.verifyEmail('not-a-real-token-but-long-enough')).rejects.toThrow(/not valid/);
    await expect(auth.verifyEmail('short')).rejects.toThrow(/not valid/);
  }, T);

  it('answers 410 for an expired token', async () => {
    const { email: addr, res } = await signup('expired');
    const token = new URL((res as { devVerifyUrl: string }).devVerifyUrl).searchParams.get('token')!;
    await prisma.otp.updateMany({ where: { destination: addr, purpose: 'email_verify' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(auth.verifyEmail(token)).rejects.toMatchObject({ status: 410 });
  }, T);

  it('resend replaces the old link, is enumeration-safe, and has a cooldown', async () => {
    const { email: addr, res } = await signup('resend');
    const oldToken = new URL((res as { devVerifyUrl: string }).devVerifyUrl).searchParams.get('token')!;
    await prisma.otp.updateMany({ where: { destination: addr }, data: { createdAt: new Date(Date.now() - 120_000) } });
    const again = await auth.resendVerification(addr);
    expect(again.ok).toBe(true);
    expect(again.devVerifyUrl).toBeTruthy();
    await expect(auth.verifyEmail(oldToken)).rejects.toThrow(/replaced/);
    await expect(auth.resendVerification(addr)).rejects.toThrow(/wait a minute/);
    // Unknown address: identical response, nothing sent.
    const unknown = await auth.resendVerification(`nobody-${randomUUID()}@example.com`);
    expect(unknown).toEqual({ ok: true });
  }, T);

  it('blocks billing routes for an unverified user', async () => {
    const { res } = await signup('guard');
    const guard = new VerifiedEmailGuard(prisma);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ user: { sub: res.user.id } }) }) } as never;
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ response: { code: 'EMAIL_NOT_VERIFIED' } });
    await prisma.user.update({ where: { id: res.user.id }, data: { emailVerifiedAt: new Date() } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  }, T);
});

// ============================================================ login / reset

db('login lockout and password reset', () => {
  it(`locks after ${MAX_FAILED_LOGINS} wrong passwords, answering exactly like a wrong password`, async () => {
    const { email: addr, password } = await verifiedUser('lock');
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await expect(auth.login(addr, 'wrong-password-1')).rejects.toThrow('Invalid credentials');
    const u = await prisma.user.findUniqueOrThrow({ where: { email: addr } });
    expect(u.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // Correct password while locked: same answer.
    await expect(auth.login(addr, password)).rejects.toThrow('Invalid credentials');
    await waitFor(() =>
      prisma.emailDeliveryLog.findFirst({ where: { toAddress: addr, templateKey: 'login_security_notification', subject: { contains: 'locked' } } }),
    );
  }, T);

  it('signs in after the lock expires and resets the counter', async () => {
    const { email: addr, password } = await verifiedUser('unlock');
    await prisma.user.update({ where: { email: addr }, data: { lockedUntil: new Date(Date.now() - 1000), failedLoginCount: 3 } });
    const res = await auth.login(addr, password);
    expect(res.user.emailVerified).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: addr } })).failedLoginCount).toBe(0);
  }, T);

  it('resets a password with a single-use code and sends a confirmation', async () => {
    const { email: addr } = await verifiedUser('reset');
    const { devCode } = await auth.requestPasswordReset(addr);
    expect(devCode).toMatch(/^\d{6}$/);
    await auth.resetPassword(addr, devCode!, 'N3wPassword!');
    await expect(auth.resetPassword(addr, devCode!, 'An0therOne!')).rejects.toThrow(/invalid or has expired/);
    await expect(auth.login(addr, 'N3wPassword!')).resolves.toBeTruthy();
    await waitFor(() => prisma.emailDeliveryLog.findFirst({ where: { toAddress: addr, templateKey: 'password_reset_confirmation' } }));
    expect(await prisma.emailDeliveryLog.findFirst({ where: { toAddress: addr, templateKey: 'forgot_password' } })).toBeTruthy();
  }, T);

  it('does not reveal whether an address has an account', async () => {
    expect(await auth.requestPasswordReset(`nobody-${randomUUID()}@example.com`)).toEqual({ ok: true });
  }, T);
});

// ============================================================ addresses

db('billing address validation', () => {
  it('rejects invalid addresses field by field', async () => {
    const { res } = await verifiedUser('addr-bad');
    await expect(
      customerSvc.putAddress(res.user.id, 'billing', { ...US_ADDRESS, state: 'XX', postalCode: '123', country: 'ZZ' }),
    ).rejects.toMatchObject({ response: { code: 'address_invalid', fields: expect.objectContaining({ country: expect.any(String) }) } });
  }, T);

  it('saves a valid address and reports its Stripe sync state honestly', async () => {
    const { res } = await verifiedUser('addr-ok');
    const view = await customerSvc.putAddress(res.user.id, 'billing', { ...US_ADDRESS, country: 'us' });
    expect(view).toMatchObject({ country: 'US', state: 'CA', postalCode: '94103' });
    expect(view.stripeSync.status).toBe(ONLINE ? 'synced' : 'pending');
    await waitFor(() => prisma.emailDeliveryLog.findFirst({ where: { userId: res.user.id, templateKey: 'billing_address_updated' } }));
  }, T);
});

// ============================================================ webhooks

db('stripe webhook', () => {
  it('rejects an invalid signature and stores nothing', async () => {
    const event = eventFor('customer.created', { id: 'cus_x', object: 'customer', metadata: {} });
    const body = Buffer.from(JSON.stringify(event));
    const bad = Stripe.webhooks.generateTestHeaderString({ payload: body.toString(), secret: 'whsec_wrong_secret' });
    await expect(webhooks.handle(body, bad)).rejects.toThrow(/Invalid Stripe signature/);
    await expect(webhooks.handle(body, undefined)).rejects.toThrow(/Missing/);
    expect(await prisma.stripeWebhookEvent.findUnique({ where: { eventId: event.id } })).toBeNull();
  }, T);

  it('rejects a body altered after signing', async () => {
    const { raw, header } = signed(eventFor('customer.created', { id: 'cus_y', object: 'customer', metadata: {} }));
    const tampered = Buffer.from(raw.toString().replace('cus_y', 'cus_z'));
    await expect(webhooks.handle(tampered, header)).rejects.toThrow(/Invalid Stripe signature/);
  }, T);

  it('processes a valid event once and acknowledges duplicates without re-running', async () => {
    const { res } = await verifiedUser('wh-dup');
    const cusId = `cus_it${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    await prisma.user.update({ where: { id: res.user.id }, data: { stripeCustomerId: null } });
    const event = eventFor('customer.created', { id: cusId, object: 'customer', metadata: { applicationUserId: res.user.id } });
    const { raw, header } = signed(event);
    expect(await webhooks.handle(raw, header)).toEqual({ received: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: res.user.id } })).stripeCustomerId).toBe(cusId);
    expect(await webhooks.handle(raw, header)).toEqual({ received: true, duplicate: true });
    const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { eventId: event.id } });
    expect(row).toMatchObject({ status: 'processed', attempts: 1 });
  }, T);

  it('ignores an event from the other mode', async () => {
    const { raw, header } = signed(eventFor('customer.created', { id: 'cus_live', object: 'customer', metadata: {} }, true));
    expect(await webhooks.handle(raw, header)).toEqual({ received: true, ignored: true });
  }, T);

  async function seedOneTimeOrder(tag: string, totalMinor = TRIAL_ITEM.amountMinor) {
    const { res } = await verifiedUser(tag);
    const pi = `pi_it${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const order = await prisma.billingOrder.create({
      data: {
        userId: res.user.id,
        itemId: TRIAL_ITEM.id,
        kind: 'one_time',
        currency: 'usd',
        subtotalMinor: TRIAL_ITEM.amountMinor,
        totalMinor,
        idempotencyKey: `${res.user.id}:${randomUUID()}`,
        stripePaymentIntentId: pi,
      },
    });
    return { userId: res.user.id, order, pi };
  }

  function piObject(id: string, orderId: string, status: string, amount: number, extra: object = {}) {
    return { id, object: 'payment_intent', amount, amount_received: status === 'succeeded' ? amount : 0, currency: 'usd', status, metadata: { orderId }, latest_charge: null, payment_method: null, ...extra };
  }

  it('marks a one-time order paid only from payment_intent.succeeded, grants once, and emails confirmation + receipt', async () => {
    const { userId, order, pi } = await seedOneTimeOrder('wh-paid');
    expect((await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('pending');
    const e1 = signed(eventFor('payment_intent.succeeded', piObject(pi, order.id, 'succeeded', order.totalMinor)));
    await webhooks.handle(e1.raw, e1.header);
    const paid = await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(paid.status).toBe('paid');
    const subs = await prisma.subscription.findMany({ where: { userId } });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: 'TRIALING', billingProvider: 'stripe', billingReference: pi });
    expect((await entitlements.check(userId, 'sentinel')).allowed).toBe(true);
    // A second, DIFFERENT event for the same payment (Stripe can send one) grants nothing more.
    const e2 = signed(eventFor('payment_intent.succeeded', piObject(pi, order.id, 'succeeded', order.totalMinor)));
    await webhooks.handle(e2.raw, e2.header);
    expect(await prisma.subscription.count({ where: { userId } })).toBe(1);
    await waitFor(() => prisma.emailDeliveryLog.findFirst({ where: { userId, templateKey: 'order_confirmation' } }));
    await waitFor(() => prisma.emailDeliveryLog.findFirst({ where: { userId, templateKey: 'order_receipt' } }));
    expect(await prisma.emailDeliveryLog.count({ where: { userId, templateKey: 'order_confirmation' } })).toBe(1);
  }, T);

  it('refuses to grant when the charged amount differs from the server total', async () => {
    const { userId, order, pi } = await seedOneTimeOrder('wh-mismatch');
    const e = signed(eventFor('payment_intent.succeeded', piObject(pi, order.id, 'succeeded', order.totalMinor - 1)));
    await webhooks.handle(e.raw, e.header);
    expect((await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('pending');
    expect(await prisma.subscription.count({ where: { userId } })).toBe(0);
  }, T);

  it('marks a failed payment failed and emails the customer', async () => {
    const { userId, order, pi } = await seedOneTimeOrder('wh-fail');
    const e = signed(
      eventFor('payment_intent.payment_failed', piObject(pi, order.id, 'requires_payment_method', order.totalMinor, { last_payment_error: { message: 'Your card was declined.', code: 'card_declined' } })),
    );
    await webhooks.handle(e.raw, e.header);
    const o = await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(o).toMatchObject({ status: 'failed', failureReason: 'Your card was declined.' });
    await waitFor(() => prisma.emailDeliveryLog.findFirst({ where: { userId, templateKey: 'payment_failed' } }));
  }, T);

  it('a full refund ends the access it bought and sends a refund confirmation', async () => {
    const { userId, order, pi } = await seedOneTimeOrder('wh-refund');
    const paid = signed(eventFor('payment_intent.succeeded', piObject(pi, order.id, 'succeeded', order.totalMinor)));
    await webhooks.handle(paid.raw, paid.header);
    const charge = { id: `ch_it${randomUUID().replace(/-/g, '').slice(0, 14)}`, object: 'charge', payment_intent: pi, amount: order.totalMinor, amount_refunded: order.totalMinor, currency: 'usd' };
    const r = signed(eventFor('charge.refunded', charge));
    await webhooks.handle(r.raw, r.header);
    const o = await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(o).toMatchObject({ status: 'refunded', refundedMinor: order.totalMinor });
    expect((await entitlements.check(userId, 'sentinel')).allowed).toBe(false);
    await waitFor(() => prisma.emailDeliveryLog.findFirst({ where: { userId, templateKey: 'refund_confirmation' } }));
  }, T);
});

// ============================================================ Stripe test mode (online)

online('Stripe test mode: customer, cards, checkout, tax, refunds', () => {
  const stripe = () => gateway.stripe;

  it('creates exactly one Stripe Customer per user, tagged with applicationUserId', async () => {
    const { res } = await verifiedUser('cus');
    const [a, b, c] = await Promise.all([customers.ensureCustomer(res.user.id), customers.ensureCustomer(res.user.id), customers.ensureCustomer(res.user.id)]);
    expect(a).toMatch(/^cus_/);
    expect(new Set([a, b, c]).size).toBe(1);
    const cus = (await stripe().customers.retrieve(a)) as Stripe.Customer;
    expect(cus.metadata.applicationUserId).toBe(res.user.id);
    expect(await customers.ensureCustomer(res.user.id)).toBe(a);
  }, T);

  it('syncs the billing address to the Stripe Customer', async () => {
    const { res } = await verifiedUser('sync');
    await customerSvc.putAddress(res.user.id, 'billing', US_ADDRESS);
    const cusId = (await prisma.user.findUniqueOrThrow({ where: { id: res.user.id } })).stripeCustomerId!;
    const cus = (await stripe().customers.retrieve(cusId)) as Stripe.Customer;
    expect(cus.address).toMatchObject({ line1: US_ADDRESS.line1, city: US_ADDRESS.city, state: 'CA', postal_code: '94103', country: 'US' });
  }, T);

  it('adds a card through a SetupIntent, lists it, sets default, refuses others, then deletes it', async () => {
    const { res } = await verifiedUser('cards');
    const other = await verifiedUser('cards-other');
    const { setupIntentId } = await methods.createSetupIntent(res.user.id);
    const si = await stripe().setupIntents.confirm(setupIntentId, { payment_method: 'pm_card_visa' });
    expect(si.status).toBe('succeeded');
    const pmId = si.payment_method as string;
    let list = await methods.list(res.user.id);
    expect(list.cards).toHaveLength(1);
    expect(list.cards[0]).toMatchObject({ brand: 'visa', last4: '4242' });
    list = await methods.setDefault(res.user.id, pmId);
    expect(list.cards[0].isDefault).toBe(true);
    await expect(methods.remove(other.res.user.id, pmId)).rejects.toThrow(/not found/i);
    list = await methods.remove(res.user.id, pmId);
    expect(list.cards).toHaveLength(0);
  }, T);

  it('quotes tax from the billing address and keeps the PaymentIntent equal to the total', async () => {
    const { res } = await verifiedUser('tax');
    await expect(checkout.quote(res.user.id, TRIAL_ITEM.id)).rejects.toMatchObject({ response: { code: 'billing_address_required' } });
    await customerSvc.putAddress(res.user.id, 'billing', US_ADDRESS);
    const q = await checkout.quote(res.user.id, TRIAL_ITEM.id);
    expect(q.subtotalMinor).toBe(TRIAL_ITEM.amountMinor);
    expect(q.totalMinor).toBe(q.subtotalMinor + q.taxMinor);
    const order = await checkout.create(res.user.id, { itemId: TRIAL_ITEM.id, idempotencyKey: randomUUID() });
    const pi = await stripe().paymentIntents.retrieve((await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.orderId } })).stripePaymentIntentId!);
    expect(pi.amount).toBe(order.totalMinor);
    // Address change → open order re-priced, PaymentIntent amount follows.
    await customerSvc.putAddress(res.user.id, 'billing', { name: 'Test Buyer', line1: '1 Main St', city: 'Portland', state: 'OR', postalCode: '97204', country: 'US' });
    const after = await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    const pi2 = await stripe().paymentIntents.retrieve(after.stripePaymentIntentId!);
    expect(pi2.amount).toBe(after.totalMinor);
  }, T);

  it('one-time checkout: save unchecked → no setup_future_usage; double submit → same order; success → paid by webhook', async () => {
    const { res } = await verifiedUser('pay');
    await customerSvc.putAddress(res.user.id, 'billing', US_ADDRESS);
    const key = randomUUID();
    const first = await checkout.create(res.user.id, { itemId: TRIAL_ITEM.id, idempotencyKey: key, savePaymentMethod: false });
    const again = await checkout.create(res.user.id, { itemId: TRIAL_ITEM.id, idempotencyKey: key, savePaymentMethod: false });
    expect(again.orderId).toBe(first.orderId);
    expect(again.clientSecret).toBe(first.clientSecret);
    const order = await prisma.billingOrder.findUniqueOrThrow({ where: { id: first.orderId } });
    let pi = await stripe().paymentIntents.retrieve(order.stripePaymentIntentId!);
    expect(pi.setup_future_usage).toBeNull();
    pi = await stripe().paymentIntents.confirm(pi.id, { payment_method: 'pm_card_visa', return_url: 'https://example.com/return' });
    expect(pi.status).toBe('succeeded');
    // Client-side success alone grants nothing.
    expect((await checkout.getOrder(res.user.id, first.orderId)).status).toBe('pending');
    const e = signed(eventFor('payment_intent.succeeded', pi));
    await webhooks.handle(e.raw, e.header);
    expect((await checkout.getOrder(res.user.id, first.orderId)).status).toBe('paid');
    const cards = await methods.list(res.user.id);
    expect(cards.cards).toHaveLength(0); // not saved
  }, T);

  it('one-time checkout: save checked → setup_future_usage=off_session and the card is attached', async () => {
    const { res } = await verifiedUser('save');
    await customerSvc.putAddress(res.user.id, 'billing', US_ADDRESS);
    const created = await checkout.create(res.user.id, { itemId: TRIAL_ITEM.id, idempotencyKey: randomUUID(), savePaymentMethod: true });
    const order = await prisma.billingOrder.findUniqueOrThrow({ where: { id: created.orderId } });
    let pi = await stripe().paymentIntents.retrieve(order.stripePaymentIntentId!);
    expect(pi.setup_future_usage).toBe('off_session');
    pi = await stripe().paymentIntents.confirm(pi.id, { payment_method: 'pm_card_visa', return_url: 'https://example.com/return' });
    expect(pi.status).toBe('succeeded');
    expect((await methods.list(res.user.id)).cards).toHaveLength(1);
  }, T);

  it('a declined card fails with a sanitised card error; 3-D Secure requires action', async () => {
    const { res } = await verifiedUser('decline');
    await customerSvc.putAddress(res.user.id, 'billing', US_ADDRESS);
    const a = await checkout.create(res.user.id, { itemId: TRIAL_ITEM.id, idempotencyKey: randomUUID() });
    const aPi = (await prisma.billingOrder.findUniqueOrThrow({ where: { id: a.orderId } })).stripePaymentIntentId!;
    await expect(stripe().paymentIntents.confirm(aPi, { payment_method: 'pm_card_chargeDeclined', return_url: 'https://example.com/r' })).rejects.toMatchObject({ type: 'StripeCardError' });
    const failed = await stripe().paymentIntents.retrieve(aPi);
    const e = signed(eventFor('payment_intent.payment_failed', failed));
    await webhooks.handle(e.raw, e.header);
    expect((await checkout.getOrder(res.user.id, a.orderId)).status).toBe('failed');

    const other = await verifiedUser('3ds');
    await customerSvc.putAddress(other.res.user.id, 'billing', US_ADDRESS);
    const b = await checkout.create(other.res.user.id, { itemId: TRIAL_ITEM.id, idempotencyKey: randomUUID() });
    const bPi = (await prisma.billingOrder.findUniqueOrThrow({ where: { id: b.orderId } })).stripePaymentIntentId!;
    const pi3ds = await stripe().paymentIntents.confirm(bPi, { payment_method: 'pm_card_threeDSecure2Required', return_url: 'https://example.com/r' });
    expect(pi3ds.status).toBe('requires_action');
    expect((await checkout.getOrder(other.res.user.id, b.orderId)).status).toBe('pending');
  }, T);

  it('subscription: first invoice paid by webhook activates the plan until the period end; refund ends it', async () => {
    const { res } = await verifiedUser('sub');
    await customerSvc.putAddress(res.user.id, 'billing', US_ADDRESS);
    const created = await checkout.create(res.user.id, { itemId: 'learning_monthly', idempotencyKey: randomUUID() });
    expect(created.clientSecret).toBeTruthy();
    const order = await prisma.billingOrder.findUniqueOrThrow({ where: { id: created.orderId } });
    expect(order.stripeSubscriptionId).toMatch(/^sub_/);
    const inv = await stripe().invoices.retrieve(order.stripeInvoiceId!, { expand: ['payments'] });
    const piId = inv.payments!.data[0].payment.payment_intent as string;
    await stripe().paymentIntents.confirm(piId, { payment_method: 'pm_card_visa', return_url: 'https://example.com/r' });
    const paidInvoice = await waitFor(async () => {
      const i = await stripe().invoices.retrieve(order.stripeInvoiceId!, { expand: ['payments'] });
      return i.status === 'paid' ? i : null;
    }, 30_000);
    const e = signed(eventFor('invoice.paid', paidInvoice));
    await webhooks.handle(e.raw, e.header);
    expect((await checkout.getOrder(res.user.id, created.orderId)).status).toBe('paid');
    const ent = await prisma.subscription.findFirstOrThrow({ where: { userId: res.user.id, billingReference: order.stripeSubscriptionId! } });
    expect(ent.status).toBe('ACTIVE');
    expect(ent.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 25 * 86400_000);
    expect((await entitlements.check(res.user.id, 'learning_pro')).allowed).toBe(true);
    // Buying the same plan again is refused.
    await expect(checkout.create(res.user.id, { itemId: 'learning_monthly', idempotencyKey: randomUUID() })).rejects.toThrow(/already have/);

    await stripe().refunds.create({ payment_intent: piId });
    const charge = await waitFor(async () => {
      const p = await stripe().paymentIntents.retrieve(piId, { expand: ['latest_charge'] });
      const c = p.latest_charge as Stripe.Charge;
      return c.amount_refunded === c.amount ? c : null;
    }, 30_000);
    const r = signed(eventFor('charge.refunded', charge));
    await webhooks.handle(r.raw, r.header);
    expect((await checkout.getOrder(res.user.id, created.orderId)).status).toBe('refunded');
    expect((await entitlements.check(res.user.id, 'learning_pro')).allowed).toBe(false);
  }, T);
});
