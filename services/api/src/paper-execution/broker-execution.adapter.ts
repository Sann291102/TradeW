import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DhanAuthService } from '../broker/dhan-auth.service';
import { MarketPriceService } from '../sim/market-price.service';
import {
  LiveExecutionNotAuthorizedError,
  type AdapterResult,
  type AdapterSubmission,
  type ExecutionAdapter,
} from './execution-adapter';
import { LIVE_EXECUTING_STATES, type ExecutionProfileState } from './execution-state';

/**
 * The LIVE engine — real orders, at a real broker, with a real person's money.
 *
 * ## THE LAST GATE, AND IT DOES NOT TRUST ITS CALLER
 *
 * `ExecutionAdapterResolver` will not hand this object to anything whose state
 * is not LIVE_ARMED/LIVE_RUNNING, and `PaperExecutionService` never imports it.
 * This class re-reads the profile's state from the database anyway, inside
 * `submit`, microseconds before the network call.
 *
 * That is not paranoia about the resolver. It is the §15 requirement stated at
 * the only place it can actually be met: an administrator who hits Disarm while
 * a live pass is in flight must stop THAT pass. The resolver decided seconds
 * ago; this decides now.
 *
 * ## THE CREDENTIAL BOUNDARY (§12)
 *
 * The access token is fetched here, used in one request header, and goes out of
 * scope. It is never:
 *   · returned from this method (see `AdapterResult` — there is no field),
 *   · written to any table (the intent stores `brokerOrderId`, a public handle),
 *   · logged (every log line below names the profile and the contract only),
 *   · put in an agent prompt or an LLM context (nothing here touches ai-core),
 *   · sent to a frontend (no route reaches this class).
 *
 * It is resolved with `accessTokenForUser`, which is strictly per-user and has
 * NO environment fallback — so a missing credential fails the order rather than
 * quietly placing it with the feed-default operator's token.
 *
 * ## Why a missing token is a refusal, not an exception to smooth over
 *
 * §21 requires "missing/invalid token → execution fails safely". Failing safely
 * here means: no order, an explicit reason on the intent, and no retry loop
 * that would hammer the broker with an unauthenticated request.
 */
@Injectable()
export class BrokerExecutionAdapter implements ExecutionAdapter {
  readonly engine = 'LIVE' as const;
  private readonly logger = new Logger(BrokerExecutionAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly broker: DhanAuthService,
    private readonly marketPrice: MarketPriceService,
  ) {}

  private get baseUrl(): string {
    return (process.env.DHAN_API_URL ?? 'https://api.dhan.co').replace(/\/$/, '');
  }

  private get timeoutMs(): number {
    return Number(process.env.DHAN_ORDER_TIMEOUT_MS ?? 15_000);
  }

  async submit(submission: AdapterSubmission): Promise<AdapterResult> {
    // ---- 1. RE-VERIFY AUTHORIZATION, from the database, right now ---------
    const profile = await this.prisma.executionProfile.findUnique({
      where: { id: submission.profileId },
      select: { id: true, name: true, state: true, accountUserId: true, autoTradeEnabled: true, accountScope: true },
    });
    if (!profile) {
      throw new LiveExecutionNotAuthorizedError(`No execution profile ${submission.profileId}.`);
    }
    if (!LIVE_EXECUTING_STATES.includes(profile.state as ExecutionProfileState)) {
      // The single most important refusal in this feature.
      throw new LiveExecutionNotAuthorizedError(
        `Refused: ${profile.name} is ${profile.state}, which does not authorize live execution. ` +
          'Only LIVE_ARMED or LIVE_RUNNING may reach the broker.',
      );
    }
    // The order must belong to the account the profile is bound to. A mismatch
    // means the submission was assembled somewhere other than the executor.
    if (profile.accountUserId !== submission.userId) {
      throw new LiveExecutionNotAuthorizedError(
        'Refused: the submission names a different account from the one this profile is bound to.',
      );
    }
    // A USER-scoped live profile additionally requires the account holder's own
    // AutoTrade switch. An administrator arming live does not consent on the
    // user's behalf; §3 keeps those two principals apart, and live is where
    // that distinction matters most.
    if (profile.accountScope === 'USER_PAPER' && !profile.autoTradeEnabled) {
      throw new LiveExecutionNotAuthorizedError(
        'Refused: the account holder has not enabled AutoTrade. Live execution requires their own activation.',
      );
    }

    // ---- 2. The credential, at the boundary and nowhere else --------------
    const credential = await this.broker.accessTokenForUser(submission.userId);
    if (!credential) {
      throw new LiveExecutionNotAuthorizedError(
        'Refused: no usable broker credential for this account. Reconnect the broker and try again.',
      );
    }

    // ---- 3. The contract, as the broker identifies it ----------------------
    const instrument = await this.marketPrice.resolveInstrument(submission.symbol);
    if (!instrument.securityId || !instrument.exchangeSegment) {
      throw new LiveExecutionNotAuthorizedError(
        `Refused: ${submission.symbol} has no broker security id; it cannot be routed live.`,
      );
    }

    const body = {
      dhanClientId: credential.brokerClientId,
      // The intent id doubles as the venue-side idempotency handle. The intent
      // is already unique per decision (see execution-identity.ts), so a retry
      // that reaches the broker twice presents the same correlation id rather
      // than opening a second position.
      correlationId: submission.intentId.replace(/-/g, '').slice(0, 25),
      transactionType: submission.side,
      exchangeSegment: instrument.exchangeSegment,
      productType: submission.productType,
      orderType: submission.type,
      validity: 'DAY',
      securityId: instrument.securityId,
      quantity: submission.quantity,
      disclosedQuantity: 0,
      price: 0,
      triggerPrice: 0,
      afterMarketOrder: false,
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v2/orders`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // THE ONLY PLACE THE TOKEN IS USED. It is not stored in a field, not
          // interpolated into a log line, and not returned.
          'access-token': credential.accessToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      const reason =
        name === 'TimeoutError' || name === 'AbortError'
          ? `The broker did not respond within ${this.timeoutMs}ms.`
          : `The broker was unreachable: ${(err as Error).message}`;
      // Deliberately NOT retried here. A submission that may or may not have
      // reached the venue is the one case where a retry can double a real
      // position; the intent is left FAILED for a human to reconcile.
      this.logger.error(`${profile.name}: live submission to ${submission.symbol} failed — ${reason}`);
      return this.refusal(reason);
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      // The broker's own message, which may name the account or the contract
      // but never carries the token — it is a request header, not a body field.
      const reason = `Broker rejected the order (${res.status}): ${text.slice(0, 300)}`;
      this.logger.warn(`${profile.name}: ${reason}`);
      return this.refusal(reason);
    }

    let parsed: { orderId?: string; orderStatus?: string } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return this.refusal(`The broker returned a response this adapter could not parse: ${text.slice(0, 200)}`);
    }

    if (!parsed.orderId) {
      return this.refusal(`The broker accepted the request but returned no order id: ${text.slice(0, 200)}`);
    }

    this.logger.log(
      `${profile.name}: LIVE ${submission.side} ${submission.quantity} ${submission.symbol} → broker order ${parsed.orderId}`,
    );

    return {
      engine: 'LIVE',
      // No paper `Order` row. A live fill must never touch a PaperWallet — see
      // AdapterResult.orderId.
      orderId: null,
      brokerOrderId: parsed.orderId,
      status: parsed.orderStatus ?? 'PENDING',
      // Fills arrive asynchronously from the broker's own order feed. Reporting
      // a quantity here would be inventing one.
      filledQuantity: 0,
      avgFillPrice: null,
      charges: null,
      rejectReason: null,
    };
  }

  private refusal(reason: string): AdapterResult {
    return {
      engine: 'LIVE',
      orderId: null,
      brokerOrderId: null,
      status: 'REJECTED',
      filledQuantity: 0,
      avgFillPrice: null,
      charges: null,
      rejectReason: reason,
    };
  }
}
