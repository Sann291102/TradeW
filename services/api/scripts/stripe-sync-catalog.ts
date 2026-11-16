/**
 * Make Stripe's Products and Prices match `src/billing/billing.catalog.ts`.
 *
 *   npm run billing:sync -w @tradew/api
 *
 * Reads the root .env. Safe to run repeatedly: existing products are adopted
 * (by STRIPE_PRODUCT_* id, metadata, or exact name), matching prices get their
 * lookup key, a changed amount creates a new Price and moves the lookup key to
 * it, and nothing is deleted. Run it once per mode (test, then live) before
 * the first checkout in that mode.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(__dirname, '../../../.env') });

async function main() {
  const { StripeGateway } = await import('../src/billing/stripe.gateway');
  const { StripePriceService } = await import('../src/billing/stripe-price.service');
  const gateway = new StripeGateway();
  if (!gateway.enabled) {
    console.error(`Stripe is not configured: ${gateway.config.problems.join('; ')}`);
    process.exit(1);
  }
  console.log(`Syncing the TradeW catalog to Stripe (${gateway.mode.toUpperCase()} mode)…`);
  const report = await new StripePriceService(gateway).syncCatalog();
  for (const p of report.products) console.log(`product ${p.key}: ${p.id} (${p.action})`);
  for (const p of report.prices) console.log(`price   ${p.itemId}: ${p.id} lookup_key=${p.lookupKey} (${p.action})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
