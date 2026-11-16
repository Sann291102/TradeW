# Billing + email-auth journeys (Playwright)

Real-browser journeys for registration, email verification, the billing
profile, saved cards and Stripe checkout. They drive the running web app and
API; nothing is stubbed.

Run against an **isolated** stack only (never the shared dev database):

1. Postgres for this stack, migrated and seeded (`npm run db:migrate`-equivalent `prisma migrate deploy`, then the seed).
2. API on :4200 and web on :3200 (web proxies `/api` to the API).
3. For the Stripe journeys: `STRIPE_MODE=test`, test keys in the root `.env`,
   and `stripe listen --forward-to http://localhost:4200/stripe/webhook` with the
   printed `whsec_…` as `STRIPE_WEBHOOK_SECRET`. Without keys those journeys
   are skipped and reported as blocked by environment.

```
npm install
npx playwright test
```

`PLAYWRIGHT_CHROMIUM_PATH` can point at an already-installed Chromium.
Only Stripe's published test cards are used (4242 4242 4242 4242, 4000 0000 0000 0002).
