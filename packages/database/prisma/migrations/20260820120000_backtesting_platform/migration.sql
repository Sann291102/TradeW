-- CreateEnum
CREATE TYPE "BacktestStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BacktestExitReason" AS ENUM ('TARGET', 'STOP', 'TIMEOUT', 'SESSION_END', 'SQUARE_OFF', 'EXPIRY', 'RUN_END');

-- CreateTable
CREATE TABLE "Backtest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT,
    "status" "BacktestStatus" NOT NULL DEFAULT 'QUEUED',
    "failureReason" TEXT,
    "strategyId" TEXT NOT NULL,
    "strategyName" TEXT NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "instrumentId" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "firstBarAt" TIMESTAMP(3),
    "lastBarAt" TIMESTAMP(3),
    "barCount" INTEGER NOT NULL DEFAULT 0,
    "initialCapital" DECIMAL(18,2) NOT NULL,
    "configuration" JSONB NOT NULL,
    "configurationHash" TEXT NOT NULL,
    "sourceProfileId" TEXT,
    "dataSource" TEXT,
    "dataVersion" TEXT,
    "dataGaps" JSONB,
    "engineVersion" TEXT NOT NULL,
    "finalCapital" DECIMAL(18,2),
    "totalPnl" DECIMAL(18,2),
    "totalReturnPct" DECIMAL(10,4),
    "cagrPct" DECIMAL(10,4),
    "totalTrades" INTEGER,
    "winningTrades" INTEGER,
    "losingTrades" INTEGER,
    "winRatePct" DECIMAL(7,4),
    "profitFactor" DECIMAL(12,4),
    "expectancy" DECIMAL(18,2),
    "maxDrawdownPct" DECIMAL(10,4),
    "maxDrawdownAmount" DECIMAL(18,2),
    "maxDrawdownDays" INTEGER,
    "sharpe" DECIMAL(12,6),
    "sortino" DECIMAL(12,6),
    "volatilityPct" DECIMAL(10,4),
    "totalFees" DECIMAL(18,2),
    "totalSlippage" DECIMAL(18,2),
    "rejectedSignals" INTEGER,
    "skippedSignals" INTEGER,
    "exposurePct" DECIMAL(7,4),
    "metrics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Backtest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestTrade" (
    "id" TEXT NOT NULL,
    "backtestId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "instrumentSymbol" TEXT NOT NULL,
    "instrumentType" "InstrumentType" NOT NULL,
    "side" "OrderSide" NOT NULL,
    "underlying" TEXT,
    "strike" DECIMAL(12,2),
    "expiry" TIMESTAMP(3),
    "optionType" TEXT,
    "entryTime" TIMESTAMP(3) NOT NULL,
    "entryPrice" DECIMAL(12,2) NOT NULL,
    "entryQuantity" INTEGER NOT NULL,
    "lots" INTEGER,
    "exitTime" TIMESTAMP(3) NOT NULL,
    "exitPrice" DECIMAL(12,2) NOT NULL,
    "exitReason" "BacktestExitReason" NOT NULL,
    "grossPnl" DECIMAL(18,2) NOT NULL,
    "fees" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "slippageCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netPnl" DECIMAL(18,2) NOT NULL,
    "holdingSeconds" INTEGER NOT NULL,
    "barsHeld" INTEGER NOT NULL,
    "cashAfter" DECIMAL(18,2) NOT NULL,
    "strategyReason" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "marketContext" JSONB,
    "stopPrice" DECIMAL(12,2),
    "targetPrice" DECIMAL(12,2),

    CONSTRAINT "BacktestTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestEquityPoint" (
    "id" TEXT NOT NULL,
    "backtestId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "cash" DECIMAL(18,2) NOT NULL,
    "portfolioValue" DECIMAL(18,2) NOT NULL,
    "realizedPnl" DECIMAL(18,2) NOT NULL,
    "unrealizedPnl" DECIMAL(18,2) NOT NULL,
    "drawdownPct" DECIMAL(10,4) NOT NULL,
    "openPositions" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BacktestEquityPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestAnalysis" (
    "id" TEXT NOT NULL,
    "backtestId" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "model" TEXT,
    "promptVersion" TEXT NOT NULL,
    "generatedBy" TEXT NOT NULL DEFAULT 'llm',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Backtest_userId_createdAt_idx" ON "Backtest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Backtest_userId_status_idx" ON "Backtest"("userId", "status");

-- CreateIndex
CREATE INDEX "Backtest_userId_strategyId_idx" ON "Backtest"("userId", "strategyId");

-- CreateIndex
CREATE INDEX "Backtest_userId_symbol_idx" ON "Backtest"("userId", "symbol");

-- CreateIndex
CREATE INDEX "Backtest_configurationHash_idx" ON "Backtest"("configurationHash");

-- CreateIndex
CREATE INDEX "BacktestTrade_backtestId_entryTime_idx" ON "BacktestTrade"("backtestId", "entryTime");

-- CreateIndex
CREATE INDEX "BacktestTrade_backtestId_netPnl_idx" ON "BacktestTrade"("backtestId", "netPnl");

-- CreateIndex
CREATE UNIQUE INDEX "BacktestTrade_backtestId_sequence_key" ON "BacktestTrade"("backtestId", "sequence");

-- CreateIndex
CREATE INDEX "BacktestEquityPoint_backtestId_at_idx" ON "BacktestEquityPoint"("backtestId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "BacktestEquityPoint_backtestId_sequence_key" ON "BacktestEquityPoint"("backtestId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "BacktestAnalysis_backtestId_key" ON "BacktestAnalysis"("backtestId");

-- AddForeignKey
ALTER TABLE "Backtest" ADD CONSTRAINT "Backtest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestTrade" ADD CONSTRAINT "BacktestTrade_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "Backtest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestEquityPoint" ADD CONSTRAINT "BacktestEquityPoint_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "Backtest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestAnalysis" ADD CONSTRAINT "BacktestAnalysis_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "Backtest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
