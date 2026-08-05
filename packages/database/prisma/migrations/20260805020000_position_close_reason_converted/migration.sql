-- Position Management's "Convert product type" action moves a position's
-- quantity into a different (instrumentId, productType) row for the same
-- instrument — closing no trade at no price, the same way T+1 settlement
-- does. Labeling that as FLATTENED (a real square-off) would be misleading
-- to anything auditing why a Position went to zero, so it gets its own
-- reason instead of being folded into an existing one.

-- AlterEnum
ALTER TYPE "PositionCloseReason" ADD VALUE 'CONVERTED';
