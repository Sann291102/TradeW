import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { STARTING_BALANCE } from './order.service';

export interface WalletResetResult {
  balance: number;
  cancelledOrders: number;
  closedPositions: number;
  clearedHoldings: number;
}

const RESTING_STATUSES = ['PENDING', 'OPEN', 'TRIGGER_PENDING', 'PARTIALLY_FILLED'] as const;

/**
 * "Start over": puts a paper account back to ₹10,00,000 with nothing open.
 *
 * ## What is reset, and what is deliberately kept
 *
 * Reset: cash, margin and realized P&L on the wallet; every open position
 * (quantity to 0, margin released); every resting order (cancelled); settled
 * holdings (to 0). Without clearing those, restoring the cash alone would leave
 * positions whose margin the wallet no longer holds — an account that cannot
 * add up.
 *
 * Kept: every Order, Trade and closed Position row. They are the account's
 * history and other records reference them (CLAUDE.md Rule 1: nothing the
 * platform has recorded is destroyed), so a reset closes the book rather than
 * tearing pages out of it.
 *
 * ## One refusal
 *
 * If a Sentinel agent is holding a position on this account, the reset is
 * refused. Zeroing the OMS position underneath the agent would leave its
 * managed position and trade journal pointing at nothing, and the agent would
 * never record the outcome its calibration learns from. The caller is told to
 * let the agent close first (or exit it) — a clear, recoverable answer.
 */
@Injectable()
export class WalletResetService {
  private readonly logger = new Logger(WalletResetService.name);

  constructor(private readonly prisma: PrismaService) {}

  async reset(userId: string): Promise<WalletResetResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      // Inside the transaction, so an agent that opens a position between the
      // check and the reset cannot slip through.
      const agentHolding = await tx.executionPosition.count({
        where: { userId, state: { in: ['OPEN', 'EXITING'] } },
      });
      if (agentHolding > 0) {
        throw new ConflictException(
          'A Sentinel agent is holding a position on this account. Let it close (or exit it) before resetting your balance.',
        );
      }
      const resetAt = new Date();
      const cancelled = await tx.order.updateMany({
        where: { userId, status: { in: [...RESTING_STATUSES] } },
        // marginBlocked is zeroed too: the wallet is being rebuilt from scratch,
        // so a stale block on a cancelled order must not be released a second time.
        data: { status: 'CANCELLED', marginBlocked: 0 },
      });
      const positions = await tx.position.updateMany({
        where: { userId, quantity: { not: 0 } },
        data: { quantity: 0, marginUsed: 0, settlesAt: null, closeReason: 'FLATTENED' },
      });
      const holdings = await tx.holding.updateMany({
        where: { userId, quantity: { gt: 0 } },
        data: { quantity: 0 },
      });
      await tx.paperWallet.upsert({
        where: { userId },
        create: { userId, startingBalance: STARTING_BALANCE, cashBalance: STARTING_BALANCE, resetAt },
        update: { startingBalance: STARTING_BALANCE, cashBalance: STARTING_BALANCE, marginUsed: 0, realizedPnl: 0, resetAt },
      });
      return { cancelled: cancelled.count, positions: positions.count, holdings: holdings.count };
    });

    // The only audit trail a reset leaves: money was rewritten, so it is logged.
    this.logger.warn(
      `wallet reset for user ${userId}: balance → ${STARTING_BALANCE}, ${result.cancelled} order(s) cancelled, ` +
        `${result.positions} position(s) closed, ${result.holdings} holding(s) cleared.`,
    );
    return {
      balance: STARTING_BALANCE,
      cancelledOrders: result.cancelled,
      closedPositions: result.positions,
      clearedHoldings: result.holdings,
    };
  }
}
