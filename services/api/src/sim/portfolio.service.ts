import { Injectable } from '@nestjs/common';
import { OrderService } from './order.service';
import { PositionService } from './position.service';

export interface PortfolioSummary {
  startingBalance: number;
  availableBalance: number;
  marginUsed: number;
  realizedPnl: number;
  unrealizedPnl: number;
  dailyPnl: number;
  positionValue: number;
  /** Cash + blocked margin + open unrealized P&L — the account's total
   *  simulated equity right now. */
  netWorth: number;
  openPositionsCount: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The account-level rollup a portfolio screen needs — everything else
 * (OrderService, PositionService) already computes the pieces; this just
 * assembles them. No new persistence: PaperWallet already tracks cash/margin
 * incrementally (see OrderService.executeFill), so this is a read, not a
 * recomputation from full trade history.
 */
@Injectable()
export class PortfolioService {
  constructor(private readonly orders: OrderService, private readonly positions: PositionService) {}

  async summary(userId: string): Promise<PortfolioSummary> {
    const [wallet, openPositions] = await Promise.all([this.orders.ensureWallet(userId), this.positions.list(userId)]);

    const unrealizedPnl = round2(openPositions.reduce((a, p) => a + p.unrealizedPnl, 0));
    const dailyPnl = round2(openPositions.reduce((a, p) => a + p.dailyPnl, 0));
    const positionValue = round2(openPositions.reduce((a, p) => a + p.positionValue, 0));

    const availableBalance = Number(wallet.cashBalance);
    const marginUsed = Number(wallet.marginUsed);

    return {
      startingBalance: Number(wallet.startingBalance),
      availableBalance,
      marginUsed,
      realizedPnl: Number(wallet.realizedPnl),
      unrealizedPnl,
      dailyPnl,
      positionValue,
      netWorth: round2(availableBalance + marginUsed + unrealizedPnl),
      openPositionsCount: openPositions.length,
    };
  }
}
