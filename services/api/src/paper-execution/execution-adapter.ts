import type { OrderType, ProductType } from '@prisma/client';

/**
 * The execution-environment boundary.
 *
 * ## The one rule this file exists to make structural
 *
 * §12: "The code must make it structurally difficult for PAPER mode to reach
 * the live broker adapter." Structurally, not conventionally — a comment saying
 * "don't call this in paper" is a convention, and conventions are what a
 * refactor removes.
 *
 * The mechanism is that `PaperExecutionService` does not import either adapter.
 * It holds an `ExecutionAdapter`, handed to it by `ExecutionAdapterResolver`,
 * which is the ONLY object in the codebase that can produce a
 * `BrokerExecutionAdapter` and does so only for a state `environmentFor`
 * reports as LIVE. To place a real broker order from the paper path, a future
 * change would have to import the broker adapter into a file that has never
 * imported it, past a resolver that exists solely to refuse — and then survive
 * the adapter's OWN re-read of the profile state, which refuses again.
 *
 * Three independent refusals, because one is what people remove.
 *
 * ## What an adapter is responsible for, and what it is not
 *
 * An adapter SUBMITS. It does not decide whether to trade (policy did), does
 * not choose the contract (Sentinel did), does not compute P&L (the OMS and the
 * lifecycle service do) and does not record provenance (the intent does). It
 * takes a fully-decided order and returns what the venue said.
 */

export type ExecutionEngine = 'PAPER' | 'LIVE';

export interface AdapterSubmission {
  /** The account the order belongs to. */
  userId: string;
  /** Canonical contract symbol — `UNDERLYING:YYYYMMDD:STRIKE:CE|PE`. */
  symbol: string;
  side: 'BUY' | 'SELL';
  type: OrderType;
  quantity: number;
  productType: ProductType;
  /** The intent this submission realises. Used for idempotency at the venue. */
  intentId: string;
  /** The profile, so an adapter can re-verify its own authorization. */
  profileId: string;
}

export interface AdapterResult {
  engine: ExecutionEngine;
  /**
   * The canonical `Order.id` for a paper submission. Null for a live one: a
   * live order lives in the broker's book, not in the paper OMS's, and minting
   * a paper Order row for it would put broker fills into a paper wallet.
   */
  orderId: string | null;
  /** The broker's own order handle. Null for paper. NOT a credential. */
  brokerOrderId: string | null;
  /** Venue status, normalised to the OMS vocabulary where possible. */
  status: string;
  filledQuantity: number;
  avgFillPrice: number | null;
  charges: number | null;
  rejectReason: string | null;
}

export interface ExecutionAdapter {
  readonly engine: ExecutionEngine;
  submit(submission: AdapterSubmission): Promise<AdapterResult>;
}

/**
 * Thrown when something asks for a live adapter that it may not have.
 *
 * A distinct type rather than a generic error so the executor can record it as
 * `live-not-authorized` — a refusal, on the record — instead of as an anonymous
 * exception in a log line.
 */
export class LiveExecutionNotAuthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveExecutionNotAuthorizedError';
  }
}
