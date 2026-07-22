-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'SL', 'SL_M');

-- CreateEnum
CREATE TYPE "OrderValidity" AS ENUM ('DAY', 'IOC');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('MIS', 'CNC', 'NRML');

-- AlterEnum
-- New enum values must be committed before a later migration can use them
-- (Postgres forbids using a value added by ALTER TYPE ... ADD VALUE within
-- the same transaction it was added in) — split into its own migration.
ALTER TYPE "OrderStatus" ADD VALUE 'PENDING';
ALTER TYPE "OrderStatus" ADD VALUE 'OPEN';
ALTER TYPE "OrderStatus" ADD VALUE 'TRIGGER_PENDING';
ALTER TYPE "OrderStatus" ADD VALUE 'PARTIALLY_FILLED';
ALTER TYPE "OrderStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "OrderStatus" ADD VALUE 'EXPIRED';
