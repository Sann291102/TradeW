---
type: gotcha
date: 2026-08-18
tags: [gotcha, telemetry, sentinel, admin, ai-core]
---

# Sentinel's telemetry never reaches the database

**Symptom.** `AgentRun`, `AgentActivity` and `AiCallLog` are *completely empty* —
zero rows, all systems, not merely stale. The admin console's Agents page, run
history and AI-cost views therefore render nothing, and any feature that tries
to join back to a Sentinel run by id finds no row.

Confirmed 2026-08-18 against the live dev database:

```
AgentRun by system: (none at all)
AgentActivity rows: 0 | AiCallLog rows: 0
```

## Cause

`packages/ai-core/src/telemetry/bus.ts` keeps one process-wide sink and is
explicit that a missing sink is a *supported* state — "tests, CLIs and the
backtest runner import ai-core without a database; they emit into the void and
pay one null check for it."

`setTelemetrySink` has exactly one caller: `services/api/src/telemetry/telemetry.service.ts`.

`services/sentinel` is a **separate process**. It calls `runAgentRun`,
`trackAgent` and `emitAgentActivity` throughout the orchestrator, and every one
of those emits into a null sink. The `runId` is generated and correlates
correctly *within* the request — it simply is never persisted anywhere.

So the design is not broken; it was only ever wired for in-process emitters, and
the service that produces almost all of the telemetry runs out of process.

## Why it is easy to misdiagnose

The correlation ids are real and consistent, so a response carrying
`runId: "ee183830-…"` looks like a working telemetry chain. Nothing errors —
the null check is silent by design. The failure is only visible by counting rows.

## What it does NOT break

`ExecutionIntent.sentinelRunId` (see
[[Decisions/2026-08-18 - Sentinel paper execution loop (execution capability, not a second Sentinel)]])
stores the run id directly on the intent, deliberately as a plain reference
rather than an FK, so order → run traceability survives this. Only the
*enrichment* (agentsRan, duration, surfaced, confidence) is unavailable.
`ExecutionTraceService` reports the absence and names both possible causes
rather than asserting one.

## Fixing it (not attempted — separate scope)

Requires a telemetry ingest path from `services/sentinel` to `services/api`:
an authenticated internal endpoint plus a batching client sink in sentinel's
bootstrap, mirroring `TelemetryService`'s existing buffer/flush. That is a
platform-observability change with its own design questions (batch size, backlog
on outage, retention), not a line of wiring — which is why it was flagged rather
than folded into an unrelated feature.

**Do not** "fix" it by having sentinel write `AgentRun` rows through its own
Prisma client: `services/api` owns those tables, and a second writer would put
retention/pruning in two places.
