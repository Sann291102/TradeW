import { describe, expect, it } from 'vitest';
import { productUserId } from './api-call.interceptor';

/**
 * Who a telemetry row is attributed to.
 *
 * This pins a real outage-shaped bug found on 2026-08-24 while wiring the
 * system graph's route-activity channel. `ApiCallLog.userId` and
 * `AiCallLog.userId` are foreign keys to `User`; `AdminAccessGuard` sets
 * `req.user.sub` to `operator:<OperatorAccount.id>` for a console request, and
 * the interceptor wrote that value straight into the column.
 *
 * The failure mode is the reason this has a test rather than a comment. The
 * insert is a `createMany`, so the constraint violation did not lose one row —
 * it threw for the WHOLE buffered batch, discarding every unrelated request
 * logged in the same two-second window. An open admin console silently punched
 * holes in the API's own telemetry, and the only evidence was one warning line.
 * Anything downstream that reads those tables (the API telemetry page, the AI
 * cost attribution, and now the graph's route activity) was quietly wrong.
 */
describe('productUserId — telemetry attribution', () => {
  it('attributes a product user by their User.id', () => {
    expect(productUserId({ sub: 'c1a2b3d4-user' })).toBe('c1a2b3d4-user');
  });

  it('honours the legacy userId field when sub is absent', () => {
    expect(productUserId({ userId: 'c1a2b3d4-user' })).toBe('c1a2b3d4-user');
  });

  /** The regression. An operator principal must never reach a User foreign key. */
  it('refuses to attribute an operator principal', () => {
    expect(productUserId({ sub: 'operator:9f8e7d6c-operator' })).toBeUndefined();
  });

  it('leaves an unauthenticated request unattributed', () => {
    expect(productUserId(undefined)).toBeUndefined();
    expect(productUserId({})).toBeUndefined();
    expect(productUserId({ sub: '' })).toBeUndefined();
  });
});
