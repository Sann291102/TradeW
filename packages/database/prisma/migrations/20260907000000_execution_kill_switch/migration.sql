-- The operator kill switch for the autonomous paper-execution loop.
--
-- A durable, single-row halt (id = 'global') read in the execution path on
-- every entry pass, so it outlives a restart and is seen by every replica —
-- unlike the deliberately process-local ExecutionLoopStatus. It stops NEW
-- entries only; the position manager keeps managing open positions, and
-- flattening is a separate explicit act. Additive: no existing row or column
-- is touched, and the loop treats an absent row as "not halted".
CREATE TABLE "ExecutionControl" (
    "id" TEXT NOT NULL,
    "entriesHalted" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "haltedBy" TEXT,
    "haltedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionControl_pkey" PRIMARY KEY ("id")
);
