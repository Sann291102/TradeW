-- Trade History needs to recover a closing trade's entry price
-- algebraically (realizedPnl / closing-quantity, inverting applyFill's own
-- formula — see order.service.ts) rather than simulating FIFO lots. That's
-- exact for an ordinary partial or full close, where Trade.quantity already
-- equals the quantity that closed. It's silently wrong for a close-and-flip
-- fill (e.g. closing a 10-long with a 15-SELL): realizedPnl is computed over
-- only the closing 10, but Trade.quantity stores the whole 15-unit fill,
-- opening leg included.
--
-- closedQuantity is that missing piece: the exact quantity realizedPnl was
-- computed over, populated by OrderService.executeFill (mirroring
-- applyFill's own closingQty) whenever realizedPnl is set, and always equal
-- to quantity for a HoldingsService.sell trade (a holdings sale can never
-- flip through zero). Additive, nullable — safe on a populated table,
-- historical rows before this migration simply have no value here.

-- AlterTable
ALTER TABLE "Trade" ADD COLUMN     "closedQuantity" INTEGER;
