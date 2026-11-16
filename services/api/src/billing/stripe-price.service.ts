import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Stripe = require('stripe');
import { StripeGateway } from './stripe.gateway';
import { BILLING_PRODUCTS, RECURRING_ITEMS, type BillingItem, type BillingProduct, type BillingProductKey } from './billing.catalog';
import { describeStripeError } from './stripe-errors';

export interface SyncReport {
  products: Array<{ key: BillingProductKey; id: string; action: 'found' | 'adopted' | 'created' }>;
  prices: Array<{ itemId: string; id: string; lookupKey: string; action: 'found' | 'adopted' | 'created' | 'replaced' }>;
}

/**
 * Keeps Stripe's Products and Prices in step with `billing.catalog.ts`.
 *
 * The catalog in code is the source of truth. Each recurring item has a
 * `lookupKey`; at checkout the Price is resolved by that key and its amount,
 * currency and interval are compared with the catalog. A mismatch refuses the
 * charge rather than billing a number the UI never showed.
 *
 * `syncCatalog()` (run by `npm run billing:sync -w @tradew/api`, and on
 * demand in TEST mode only) makes Stripe match:
 *   · Products: pinned by STRIPE_PRODUCT_* env, else found by metadata or by
 *     exact name (adopting Dashboard-created products such as "Learning" and
 *     "Sentinel Pro"), else created with the catalog's tax code.
 *   · Prices: found by lookup key; else an existing active Price on the
 *     product with the same amount and interval is adopted (given the lookup
 *     key); else one is created. A changed amount creates a new Price and moves
 *     the lookup key to it (`transfer_lookup_key`); the old Price stays valid
 *     for existing subscribers.
 * In LIVE mode nothing is created implicitly: run the sync script on purpose.
 */
@Injectable()
export class StripePriceService {
  private readonly logger = new Logger(StripePriceService.name);
  private readonly cache = new Map<string, Stripe.Price>();

  constructor(private readonly gateway: StripeGateway) {}

  /** Amount, currency and interval agree with the catalog (tax behaviour checked separately). */
  private sameTerms(price: Stripe.Price, item: BillingItem): boolean {
    return (
      price.active &&
      price.unit_amount === item.amountMinor &&
      price.currency === item.currency &&
      price.recurring?.interval === 'month' &&
      price.recurring.interval_count === item.intervalCount
    );
  }

  /**
   * Usable for billing: same terms AND tax added on top (`exclusive`). An
   * `inclusive` Price would bury tax inside the amount while every screen says
   * "+ tax". `unspecified` is fixable in place (sync sets it to exclusive).
   */
  private matches(price: Stripe.Price, item: BillingItem): boolean {
    return this.sameTerms(price, item) && price.tax_behavior === 'exclusive' && this.localPricesMatch(price, item);
  }

  /**
   * Every local-currency amount in the catalog (e.g. Learning ₹499) is present
   * on the Price as a `currency_options` entry with the same amount. Needs the
   * Price retrieved with `currency_options` expanded.
   */
  private localPricesMatch(price: Stripe.Price, item: BillingItem): boolean {
    return (item.localPrices ?? []).every((lp) => price.currency_options?.[lp.currency]?.unit_amount === lp.amountMinor);
  }

  private currencyOptionsFor(item: BillingItem): Stripe.PriceCreateParams['currency_options'] | undefined {
    if (!item.localPrices?.length) return undefined;
    return Object.fromEntries(item.localPrices.map((lp) => [lp.currency, { unit_amount: lp.amountMinor, tax_behavior: 'exclusive' as const }]));
  }

  /** Add or correct the local-currency amounts on an adopted Price. */
  private async ensureLocalPrices(price: Stripe.Price, item: BillingItem) {
    const options = this.currencyOptionsFor(item);
    if (!options || this.localPricesMatch(price, item)) return;
    await this.gateway.stripe.prices
      .update(price.id, { currency_options: options })
      .catch((e) => this.logger.error(`could not set currency_options on ${price.id}: ${describeStripeError(e)}`));
  }

  /** The Stripe Price to bill `item` with. Fails closed on any mismatch. */
  async resolve(item: BillingItem): Promise<Stripe.Price> {
    if (item.kind !== 'recurring' || !item.lookupKey) throw new Error(`${item.id} is not a recurring item`);
    const cached = this.cache.get(item.id);
    if (cached) return cached;

    const stripe = this.gateway.stripe;
    const found = await stripe.prices.list({ lookup_keys: [item.lookupKey], active: true, limit: 1, expand: ['data.currency_options'] });
    let price = found.data[0];
    if (!price && this.gateway.mode === 'test') {
      await this.syncCatalog();
      price = (await stripe.prices.list({ lookup_keys: [item.lookupKey], active: true, limit: 1, expand: ['data.currency_options'] })).data[0];
    }
    if (!price) {
      throw new ServiceUnavailableException(`Billing is not set up for ${item.label} yet. Nothing was charged.`);
    }
    if (!this.matches(price, item)) {
      this.logger.error(
        `PRICE MISMATCH for ${item.id}: Stripe ${price.id} is ${price.unit_amount} ${price.currency} every ${price.recurring?.interval_count} ${price.recurring?.interval} (tax ${price.tax_behavior}, options ${Object.keys(price.currency_options ?? {}).join('/')}); catalog says ${item.amountMinor} ${item.currency} every ${item.intervalCount} month${item.localPrices?.length ? ` + ${item.localPrices.map((l) => `${l.amountMinor} ${l.currency}`).join(', ')}` : ''}. Run billing:sync.`,
      );
      throw new ServiceUnavailableException(`The price for ${item.label} is being updated. Nothing was charged; please try again later.`);
    }
    this.cache.set(item.id, price);
    return price;
  }

  /** Product id for a catalog product, adopting or creating as described above. */
  async ensureProduct(product: BillingProduct, report?: SyncReport): Promise<Stripe.Product> {
    const stripe = this.gateway.stripe;
    const pinned = process.env[product.productIdEnv]?.trim();
    if (pinned) {
      const p = await stripe.products.retrieve(pinned);
      report?.products.push({ key: product.key, id: p.id, action: 'found' });
      return p;
    }
    const active = await stripe.products.list({ active: true, limit: 100 });
    const byMeta = active.data.find((p) => p.metadata?.tradew_product === product.key);
    if (byMeta) {
      report?.products.push({ key: product.key, id: byMeta.id, action: 'found' });
      return byMeta;
    }
    const byName = active.data.find((p) => p.name.trim().toLowerCase() === product.name.toLowerCase());
    if (byName) {
      const adopted = await stripe.products.update(byName.id, {
        metadata: { ...byName.metadata, tradew_product: product.key },
        ...(byName.tax_code ? {} : { tax_code: product.taxCode }),
      });
      report?.products.push({ key: product.key, id: adopted.id, action: 'adopted' });
      return adopted;
    }
    const created = await stripe.products.create(
      { name: product.name, tax_code: product.taxCode, metadata: { tradew_product: product.key } },
      { idempotencyKey: `tradew-product-${product.key}-${this.gateway.mode}` },
    );
    report?.products.push({ key: product.key, id: created.id, action: 'created' });
    return created;
  }

  /** Make Stripe match the catalog. Safe to run repeatedly. */
  async syncCatalog(): Promise<SyncReport> {
    const stripe = this.gateway.stripe;
    const report: SyncReport = { products: [], prices: [] };
    const products = new Map<BillingProductKey, Stripe.Product>();
    for (const key of Object.keys(BILLING_PRODUCTS) as BillingProductKey[]) {
      products.set(key, await this.ensureProduct(BILLING_PRODUCTS[key], report));
    }

    for (const item of RECURRING_ITEMS) {
      const product = products.get(item.product)!;
      const byKey = (await stripe.prices.list({ lookup_keys: [item.lookupKey!], active: true, limit: 1, expand: ['data.currency_options'] })).data[0];
      if (byKey && this.sameTerms(byKey, item) && byKey.tax_behavior !== 'inclusive') {
        await this.ensureTaxBehavior(byKey);
        await this.ensureLocalPrices(byKey, item);
        report.prices.push({ itemId: item.id, id: byKey.id, lookupKey: item.lookupKey!, action: 'found' });
        continue;
      }
      const onProduct = await stripe.prices.list({ product: product.id, active: true, type: 'recurring', limit: 100, expand: ['data.currency_options'] });
      // An `inclusive` Price cannot be switched; a new exclusive one is created instead.
      const reusable = onProduct.data.find((p) => this.sameTerms(p, item) && p.tax_behavior !== 'inclusive' && !p.lookup_key);
      if (reusable && !byKey) {
        await stripe.prices.update(reusable.id, {
          lookup_key: item.lookupKey!,
          ...(reusable.tax_behavior === 'unspecified' || !reusable.tax_behavior ? { tax_behavior: 'exclusive' as const } : {}),
          metadata: { ...reusable.metadata, tradew_item: item.id },
        });
        await this.ensureLocalPrices(reusable, item);
        report.prices.push({ itemId: item.id, id: reusable.id, lookupKey: item.lookupKey!, action: 'adopted' });
        continue;
      }
      const created = await stripe.prices.create(
        {
          product: product.id,
          currency: item.currency,
          unit_amount: item.amountMinor,
          recurring: { interval: 'month', interval_count: item.intervalCount! },
          tax_behavior: 'exclusive',
          ...(this.currencyOptionsFor(item) ? { currency_options: this.currencyOptionsFor(item) } : {}),
          lookup_key: item.lookupKey!,
          transfer_lookup_key: Boolean(byKey),
          nickname: item.label,
          metadata: { tradew_item: item.id },
        },
        { idempotencyKey: `tradew-price-${item.lookupKey}-${item.amountMinor}${(item.localPrices ?? []).map((l) => `-${l.currency}${l.amountMinor}`).join('')}-${this.gateway.mode}` },
      );
      report.prices.push({ itemId: item.id, id: created.id, lookupKey: item.lookupKey!, action: byKey ? 'replaced' : 'created' });
    }
    this.cache.clear();
    this.logger.log(`catalog sync: ${JSON.stringify(report)}`);
    return report;
  }

  /** Stripe Tax needs every Price to say whether tax is added on top. */
  private async ensureTaxBehavior(price: Stripe.Price) {
    if (price.tax_behavior && price.tax_behavior !== 'unspecified') return;
    await this.gateway.stripe.prices
      .update(price.id, { tax_behavior: 'exclusive' })
      .catch((e) => this.logger.warn(`could not set tax_behavior on ${price.id}: ${describeStripeError(e)}`));
  }

  /** Product tax code for a one-time item (no Price object is used for those). */
  taxCodeFor(item: BillingItem): string {
    return BILLING_PRODUCTS[item.product].taxCode;
  }
}
