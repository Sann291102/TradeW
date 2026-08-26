import { Injectable } from '@nestjs/common';
import { OrderService } from '../sim/order.service';
import type { AdapterResult, AdapterSubmission, ExecutionAdapter } from './execution-adapter';

/**
 * The PAPER engine — the canonical paper OMS, reached the way a human's order
 * ticket reaches it.
 *
 * ## Why this is a thin wrapper and not an engine
 *
 * §6 requires that an agent's paper trade become "a normal trading record in
 * the canonical trading system", not a Sentinel-shaped shadow of one. That is
 * satisfied by calling `OrderService.placeOrder` and nothing else: the same
 * lot-size validation, the same simulated margin, the same discipline limits,
 * the same matching engine, the same `Trade`/`Position`/`PaperWallet` writes,
 * the same rows `/sim/orders` and `/sim/positions` already serve to the user's
 * own app. There is no synchronisation step and no mirror table, because there
 * is only one set of records.
 *
 * A second "paper engine" living inside this feature is precisely what would
 * make the trades appear in Sentinel telemetry and nowhere else — the failure
 * §6 opens by naming.
 *
 * ## It cannot reach a broker
 *
 * This class imports `OrderService` and nothing that speaks to a venue. There
 * is no code path, conditional or otherwise, from here to a network call.
 */
@Injectable()
export class PaperExecutionAdapter implements ExecutionAdapter {
  readonly engine = 'PAPER' as const;

  constructor(private readonly orders: OrderService) {}

  async submit(submission: AdapterSubmission): Promise<AdapterResult> {
    const order = await this.orders.placeOrder(submission.userId, {
      symbol: submission.symbol,
      side: submission.side,
      type: submission.type,
      quantity: submission.quantity,
      productType: submission.productType,
    });

    return {
      engine: 'PAPER',
      orderId: order.id,
      // Always null. `paper-live-boundary.spec.ts` asserts it, because a paper
      // intent carrying a broker order id would mean the boundary had been
      // crossed.
      brokerOrderId: null,
      status: order.status,
      filledQuantity: order.filledQuantity,
      avgFillPrice: order.avgFillPrice != null ? Number(order.avgFillPrice) : null,
      charges: order.charges != null ? Number(order.charges) : null,
      rejectReason: order.rejectReason ?? null,
    };
  }
}
