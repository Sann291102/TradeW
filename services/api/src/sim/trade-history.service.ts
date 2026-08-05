import { Injectable } from '@nestjs/common';
import { OrderSide, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
/** A CSV export isn't paginated, but "unbounded" isn't a real option either —
 *  caps the query, doesn't cap what a user's real trade history can hold. */
const CSV_ROW_LIMIT = 10_000;

export interface TradeHistoryFilters {
  from?: Date;
  to?: Date;
  /** Exact symbol match — the dedicated "Symbol filter" the spec asks for,
   *  distinct from the free-text `search`. */
  symbol?: string;
  /** Free-text match over symbol or display name. */
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface TradeHistoryRow {
  id: string;
  instrumentId: string;
  symbol: string;
  displayName: string;
  /** The closing trade's own side — SELL closed a long, BUY closed a short. */
  side: OrderSide;
  productType: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  netPnl: number;
  charges: number;
  executedAt: string;
}

type ClosingTrade = Prisma.TradeGetPayload<{ include: { instrument: true; order: { select: { productType: true } } } }>;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Algebraically recovers a closing trade's entry price — no FIFO lot
 * simulation needed. Inverts `applyFill`'s own formula (order.service.ts):
 *
 *   realizedPnlDelta = closingQty * (fillPrice - entryPrice) * sign(existingQty)
 *
 * A closing trade's side is always opposite the position it closed: a SELL
 * closes a long (sign +1) => entryPrice = fillPrice - pnl/qty; a BUY closes a
 * short (sign -1) => entryPrice = fillPrice + pnl/qty. `qty` here must be the
 * CLOSING quantity (`Trade.closedQuantity`), not the full fill quantity — see
 * that column's schema comment for why they can differ on a flip fill.
 *
 * Exported for trade-history.spec.ts only — pure, no database.
 */
export function deriveEntryPrice(side: OrderSide, fillPrice: number, closedQuantity: number, realizedPnl: number): number {
  const signed = realizedPnl / closedQuantity;
  return side === 'SELL' ? fillPrice - signed : fillPrice + signed;
}

/**
 * Trade History as paired entry/exit round-trips. `Trade.realizedPnl` is
 * already correct per closing trade (set by `applyFill`) — the only missing
 * piece for an Entry/Exit row is the entry price at that close, and it's
 * recoverable algebraically (`deriveEntryPrice`) from fields already on the
 * row. Selecting `realizedPnl IS NOT NULL` is exactly "closing trades" by
 * existing design (PositionService's own `todaysRealizedPnl` relies on the
 * same convention) — one row per closing trade is one round-trip.
 */
@Injectable()
export class TradeHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(userId: string, filters: TradeHistoryFilters): Prisma.TradeWhereInput {
    const where: Prisma.TradeWhereInput = { userId, realizedPnl: { not: null } };
    if (filters.from || filters.to) {
      where.executedAt = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      };
    }
    if (filters.symbol) {
      where.instrument = { symbol: filters.symbol.toUpperCase() };
    } else if (filters.search) {
      where.instrument = {
        OR: [
          { symbol: { contains: filters.search, mode: 'insensitive' } },
          { displayName: { contains: filters.search, mode: 'insensitive' } },
        ],
      };
    }
    return where;
  }

  private toRow(t: ClosingTrade): TradeHistoryRow {
    const fillPrice = Number(t.fillPrice);
    const realizedPnl = Number(t.realizedPnl);
    // Falls back to the full fill quantity for pre-migration rows that
    // predate closedQuantity — exact for every non-flip trade (the vast
    // majority), and the best available number for old flip trades that
    // can't be re-derived without the lot data this column now captures.
    const closedQuantity = t.closedQuantity ?? t.quantity;
    const entryPrice = deriveEntryPrice(t.side, fillPrice, closedQuantity, realizedPnl);

    return {
      id: t.id,
      instrumentId: t.instrumentId,
      symbol: t.instrument.symbol,
      displayName: t.instrument.displayName,
      side: t.side,
      productType: t.order.productType,
      quantity: closedQuantity,
      entryPrice: round2(entryPrice),
      exitPrice: round2(fillPrice),
      netPnl: round2(realizedPnl),
      charges: round2(Number(t.charges)),
      executedAt: t.executedAt.toISOString(),
    };
  }

  async list(userId: string, filters: TradeHistoryFilters): Promise<{ rows: TradeHistoryRow[]; total: number }> {
    const where = this.buildWhere(userId, filters);
    const page = filters.page && filters.page > 0 ? Math.floor(filters.page) : 1;
    const pageSize = filters.pageSize && filters.pageSize > 0 ? Math.min(Math.floor(filters.pageSize), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

    const [trades, total] = await Promise.all([
      this.prisma.trade.findMany({
        where,
        include: { instrument: true, order: { select: { productType: true } } },
        orderBy: { executedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.trade.count({ where }),
    ]);

    return { rows: trades.map((t) => this.toRow(t)), total };
  }

  async exportCsv(userId: string, filters: Omit<TradeHistoryFilters, 'page' | 'pageSize'>): Promise<string> {
    const where = this.buildWhere(userId, filters);
    const trades = await this.prisma.trade.findMany({
      where,
      include: { instrument: true, order: { select: { productType: true } } },
      orderBy: { executedAt: 'desc' },
      take: CSV_ROW_LIMIT,
    });
    return toCsv(trades.map((t) => this.toRow(t)));
  }
}

/** Minimal RFC 4180 quoting — only fields that need it get wrapped, so the
 *  common case stays readable in a text editor. No CSV library needed for
 *  eight flat, already-sanitized numeric/string columns. */
function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: TradeHistoryRow[]): string {
  const header = ['Date & Time', 'Symbol', 'Side', 'Product', 'Quantity', 'Entry Price', 'Exit Price', 'Net P&L', 'Charges'];
  const lines = rows.map((r) =>
    [r.executedAt, r.symbol, r.side, r.productType, r.quantity, r.entryPrice, r.exitPrice, r.netPnl, r.charges].map(csvCell).join(','),
  );
  return [header.join(','), ...lines].join('\r\n');
}
