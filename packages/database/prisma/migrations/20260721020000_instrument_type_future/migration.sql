-- Adds FUTURE to InstrumentType. The Dhan scrip master classifies FUTIDX/FUTSTK
-- contracts; without this value the importer would have to mislabel them as
-- EQUITY or drop them. Additive enum value — no existing row changes.

-- AlterEnum
ALTER TYPE "InstrumentType" ADD VALUE 'FUTURE';

