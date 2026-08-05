import { Injectable } from '@nestjs/common';
import { OrderService } from './order.service';
import { PositionService } from './position.service';
import { HoldingsService } from './holdings.service';

export interface PortfolioSummary {
  startingBalance: number;
  availableBalance: number;
  marginUsed: number;
  /** Lifetime realized P&L across BOTH Positions and Holdings — one wallet
   *  ledger, credited by OrderService.executeFill and HoldingsService.sell
   *  alike (see their own comments). */
  realizedPnl: number;
  /** Positions' + Holdings' unrealized P&L combined — widened from
   *  positions-only now that Holdings exist. See positionsUnrealizedPnl /
   *  holdingsUnrealizedPnl for the split. */
  unrealizedPnl: number;
  dailyPnl: number;
  /** Open positions' current market value only — see currentValue for
   *  positions + holdings combined. */
  positionValue: number;
  /** Cash + blocked margin + positions' unrealized P&L + holdings' current
   *  market value — the account's total simulated equity right now. Holdings
   *  aren't in marginUsed (SettlementService releases it on transfer, see
   *  that service's docstring), so their current value has to be added
   *  directly or a settled position's value would vanish from this number
   *  the moment it settles. */
  netWorth: number;
  openPositionsCount: number;

  // ---- Added for the Portfolio Summary / Performance sections -----------
  positionsUnrealizedPnl: number;
  holdingsUnrealizedPnl: number;
  /** Current market value of settled holdings only. */
  holdingsValue: number;
  /** Cost basis of open positions (avgPrice x |qty|) + settled holdings
   *  (avgCost x qty) — capital actually deployed right now. */
  investedAmount: number;
  /** Mark-to-market value of everything held right now: positionValue +
   *  holdingsValue. */
  currentValue: number;
  /** realizedPnl + unrealizedPnl — lifetime P&L across the whole account. */
  overallPnl: number;
  /**
   * This paper engine has no margin/leverage facility separate from cash —
   * `computeMargin` blocks real rupee amounts straight out of cashBalance,
   * there is no line of credit beyond it. Reported as an alias of
   * availableBalance rather than inventing a multiplier that doesn't exist
   * anywhere else in the engine.
   */
  availableMargin: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The account-level rollup a portfolio screen needs — everything else
 * (OrderService, PositionService, HoldingsService) already computes the
 * pieces; this just assembles them. No new persistence: PaperWallet already
 * tracks cash/margin incrementally (see OrderService.executeFill), so this
 * is a read, not a recomputation from full trade history.
 */
@Injectable()
export class PortfolioService {
  constructor(
    private readonly orders: OrderService,
    private readonly positions: PositionService,
    private readonly holdings: HoldingsService,
  ) {}

  async summary(userId: string): Promise<PortfolioSummary> {
    const [wallet, openPositions, holdingRows] = await Promise.all([
      this.orders.ensureWallet(userId),
      this.positions.list(userId),
      this.holdings.list(userId),
    ]);

    const positionsUnrealizedPnl = round2(openPositions.reduce((a, p) => a + p.unrealizedPnl, 0));
    const holdingsUnrealizedPnl = round2(holdingRows.reduce((a, h) => a + h.overallPnl, 0));
    const unrealizedPnl = round2(positionsUnrealizedPnl + holdingsUnrealizedPnl);
    const dailyPnl = round2(openPositions.reduce((a, p) => a + p.dailyPnl, 0));
    const positionValue = round2(openPositions.reduce((a, p) => a + p.positionValue, 0));
    const holdingsValue = round2(holdingRows.reduce((a, h) => a + h.currentValue, 0));

    const positionsInvested = round2(openPositions.reduce((a, p) => a + p.avgPrice * Math.abs(p.quantity), 0));
    const holdingsInvested = round2(holdingRows.reduce((a, h) => a + h.investedValue, 0));
    const investedAmount = round2(positionsInvested + holdingsInvested);
    const currentValue = round2(positionValue + holdingsValue);

    const availableBalance = Number(wallet.cashBalance);
    const marginUsed = Number(wallet.marginUsed);
    const realizedPnl = Number(wallet.realizedPnl);

    return {
      startingBalance: Number(wallet.startingBalance),
      availableBalance,
      marginUsed,
      realizedPnl,
      unrealizedPnl,
      dailyPnl,
      positionValue,
      netWorth: round2(availableBalance + marginUsed + positionsUnrealizedPnl + holdingsValue),
      openPositionsCount: openPositions.length,
      positionsUnrealizedPnl,
      holdingsUnrealizedPnl,
      holdingsValue,
      investedAmount,
      currentValue,
      overallPnl: round2(realizedPnl + unrealizedPnl),
      availableMargin: availableBalance,
    };
  }
}
