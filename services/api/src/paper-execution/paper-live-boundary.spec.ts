import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionAdapterResolver } from './execution-adapter.resolver';
import { LiveExecutionNotAuthorizedError } from './execution-adapter';
import { BrokerExecutionAdapter } from './broker-execution.adapter';
import { PaperExecutionAdapter } from './paper-execution.adapter';
import { ALL_EXECUTION_STATES, type ExecutionProfileState } from './execution-state';

/**
 * THE BOUNDARY. §12, §21's "Live safety" block, and the rule the whole feature
 * is built around:
 *
 *   A paper-enabled Sentinel must NEVER accidentally place a real broker order.
 *
 * These tests do not use a database. They construct the real resolver and the
 * real adapters over stubs, then assert the two things that matter: which
 * object comes back for which state, and whether anything reached the network.
 *
 * `fetch` is stubbed globally and asserted to be untouched in every paper case,
 * because "the broker adapter was not returned" and "no broker request was
 * made" are different claims and only the second one is the actual safety
 * property.
 */

function paperAdapter() {
  const placeOrder = vi.fn().mockResolvedValue({
    id: 'order-1',
    status: 'FILLED',
    filledQuantity: 75,
    avgFillPrice: 120.5,
    charges: 2.71,
    rejectReason: null,
  });
  return { adapter: new PaperExecutionAdapter({ placeOrder } as never), placeOrder };
}

function brokerAdapter(profileRow: Record<string, unknown> | null) {
  const accessTokenForUser = vi.fn().mockResolvedValue({ accessToken: 'SECRET-TOKEN', brokerClientId: '1100' });
  const prisma = {
    executionProfile: { findUnique: vi.fn().mockResolvedValue(profileRow) },
  };
  const marketPrice = {
    resolveInstrument: vi.fn().mockResolvedValue({ securityId: '43492', exchangeSegment: 'NSE_FNO', lotSize: 75 }),
  };
  return {
    adapter: new BrokerExecutionAdapter(prisma as never, { accessTokenForUser } as never, marketPrice as never),
    accessTokenForUser,
  };
}

const submission = {
  userId: 'u1',
  symbol: 'NIFTY:20260827:24900:CE',
  side: 'BUY' as const,
  type: 'MARKET' as never,
  quantity: 75,
  productType: 'NRML' as never,
  intentId: 'intent-1',
  profileId: 'p1',
};

describe('the PAPER/LIVE execution boundary', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    delete process.env.LIVE_EXECUTION_ENABLED;
  });

  describe('the resolver', () => {
    function resolver() {
      return new ExecutionAdapterResolver(paperAdapter().adapter, brokerAdapter(null).adapter);
    }

    it('returns the PAPER adapter for every paper-executing state', () => {
      for (const state of ['PAPER_ARMED', 'PAPER_RUNNING', 'PAPER_QUALIFIED'] as ExecutionProfileState[]) {
        expect(resolver().resolve(state).engine).toBe('PAPER');
      }
    });

    it('NEVER returns the broker adapter for a paper state, even a qualified one', () => {
      // §21: "paper-qualified but not live armed → broker is NEVER called."
      for (const state of ['PAPER_ARMED', 'PAPER_RUNNING', 'PAPER_QUALIFIED'] as ExecutionProfileState[]) {
        expect(resolver().resolve(state)).not.toBeInstanceOf(BrokerExecutionAdapter);
      }
    });

    it('throws for every non-executing state rather than falling back to paper', () => {
      // A `default: return paperAdapter` would silently execute a disarmed
      // profile. The safe failure is a refusal.
      for (const state of ALL_EXECUTION_STATES) {
        if (['PAPER_ARMED', 'PAPER_RUNNING', 'PAPER_QUALIFIED', 'LIVE_ARMED', 'LIVE_RUNNING'].includes(state)) continue;
        expect(() => resolver().resolve(state)).toThrow(LiveExecutionNotAuthorizedError);
      }
    });

    it('refuses a live state when the deployment has not enabled live', () => {
      // The deployment gate is not the authorization — the state is — but a
      // staging box restored from a production dump, complete with a LIVE_ARMED
      // profile, must not be able to trade.
      expect(() => resolver().resolve('LIVE_ARMED')).toThrow(/LIVE_EXECUTION_ENABLED/);
    });

    it('returns the broker adapter for a live state only when the deployment allows it', () => {
      process.env.LIVE_EXECUTION_ENABLED = 'true';
      expect(resolver().resolve('LIVE_ARMED')).toBeInstanceOf(BrokerExecutionAdapter);
      expect(resolver().resolve('LIVE_RUNNING').engine).toBe('LIVE');
    });
  });

  describe('the paper adapter', () => {
    it('places through the canonical OrderService and touches no network', () => {
      // §6: an agent's paper trade is a normal record in the canonical system,
      // not a Sentinel-shaped shadow of one.
      const { adapter, placeOrder } = paperAdapter();
      return adapter.submit(submission).then((result) => {
        expect(placeOrder).toHaveBeenCalledWith('u1', expect.objectContaining({ symbol: submission.symbol }));
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(result.engine).toBe('PAPER');
        expect(result.orderId).toBe('order-1');
        // The invariant a paper intent is asserted against downstream.
        expect(result.brokerOrderId).toBeNull();
      });
    });
  });

  describe('the broker adapter re-checks, and does not trust its caller', () => {
    it('refuses a profile whose state is not live — before reading any credential', () => {
      // The resolver would never hand this adapter a paper profile. It refuses
      // anyway, because §15 requires a disarm landing mid-pass to stop THAT
      // pass, and the resolver decided seconds ago.
      const { adapter, accessTokenForUser } = brokerAdapter({
        id: 'p1',
        name: 'test',
        state: 'PAPER_QUALIFIED',
        accountUserId: 'u1',
        autoTradeEnabled: true,
        accountScope: 'USER_PAPER',
      });
      return expect(adapter.submit(submission)).rejects.toThrow(/does not authorize live execution/i).then(() => {
        // The credential was never even fetched, let alone used.
        expect(accessTokenForUser).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    });

    it('refuses when the submission names a different account from the profile', () => {
      const { adapter } = brokerAdapter({
        id: 'p1',
        name: 'test',
        state: 'LIVE_ARMED',
        accountUserId: 'someone-else',
        autoTradeEnabled: true,
        accountScope: 'USER_PAPER',
      });
      return expect(adapter.submit(submission)).rejects.toThrow(/different account/i);
    });

    it('refuses a live USER profile whose holder has AutoTrade switched off', () => {
      // An administrator arming live does not consent on the user's behalf.
      const { adapter } = brokerAdapter({
        id: 'p1',
        name: 'test',
        state: 'LIVE_RUNNING',
        accountUserId: 'u1',
        autoTradeEnabled: false,
        accountScope: 'USER_PAPER',
      });
      return expect(adapter.submit(submission)).rejects.toThrow(/account holder has not enabled AutoTrade/i);
    });

    it('fails safely when there is no usable broker credential', () => {
      // §21: "missing/invalid token → execution fails safely." No order, an
      // explicit reason, and nothing sent.
      const prisma = {
        executionProfile: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'p1',
            name: 'test',
            state: 'LIVE_ARMED',
            accountUserId: 'u1',
            autoTradeEnabled: true,
            accountScope: 'SYSTEM_PAPER',
          }),
        },
      };
      const adapter = new BrokerExecutionAdapter(
        prisma as never,
        { accessTokenForUser: vi.fn().mockResolvedValue(null) } as never,
        { resolveInstrument: vi.fn() } as never,
      );
      return expect(adapter.submit(submission)).rejects.toThrow(/no usable broker credential/i).then(() => {
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    });

    it('sends the token as a header and never returns or reports it', async () => {
      // §12: the credential is used at the boundary and goes no further.
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ orderId: 'BROKER-9', orderStatus: 'TRANSIT' }),
      });
      const { adapter } = brokerAdapter({
        id: 'p1',
        name: 'test',
        state: 'LIVE_ARMED',
        accountUserId: 'u1',
        autoTradeEnabled: true,
        accountScope: 'USER_PAPER',
      });

      const result = await adapter.submit(submission);

      const [, init] = fetchSpy.mock.calls[0];
      expect((init.headers as Record<string, string>)['access-token']).toBe('SECRET-TOKEN');
      // The token appears nowhere in the request BODY, and nowhere in the
      // result the caller persists.
      expect(init.body).not.toContain('SECRET-TOKEN');
      expect(JSON.stringify(result)).not.toContain('SECRET-TOKEN');
      expect(result.brokerOrderId).toBe('BROKER-9');
      // No paper Order row for a live fill — a broker fill must never touch a
      // PaperWallet.
      expect(result.orderId).toBeNull();
    });

    it('does not retry a submission that may have reached the venue', async () => {
      // The one case where a retry can double a REAL position.
      fetchSpy.mockRejectedValue(Object.assign(new Error('socket hang up'), { name: 'TypeError' }));
      const { adapter } = brokerAdapter({
        id: 'p1',
        name: 'test',
        state: 'LIVE_ARMED',
        accountUserId: 'u1',
        autoTradeEnabled: true,
        accountScope: 'SYSTEM_PAPER',
      });
      const result = await adapter.submit(submission);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('REJECTED');
      expect(result.brokerOrderId).toBeNull();
    });
  });
});
