import { defineConfig, devices } from '@playwright/test';

/**
 * Email auth + Stripe billing journeys against a RUNNING isolated stack.
 * Nothing here starts servers or fakes an API:
 *
 *   web  E2E_BASE_URL (default http://localhost:3200), proxying /api to
 *   api  on :4200, whose DATABASE_URL is an isolated Postgres (never shared dev data).
 *
 * Stripe journeys run only when the API reports billing enabled in TEST mode
 * (`GET /api/payments/catalog`); otherwise they are skipped and reported as
 * blocked by environment. Only Stripe's published test cards are typed.
 *
 * PLAYWRIGHT_CHROMIUM_PATH may point at an already-installed Chromium when the
 * bundled revision is not downloaded.
 */
export default defineConfig({
  testDir: './specs',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3200',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  },
});
