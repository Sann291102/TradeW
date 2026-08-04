import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import {
  setTelemetrySink,
  type AgentActivityEvent,
  type AgentRunEndEvent,
  type AgentRunStartEvent,
  type AiCallEvent,
  type TelemetrySink,
} from '@tradew/ai-core';
import { PrismaService } from '../prisma/prisma.service';

/** Per-buffer cap. ~5k rows of small objects is a few MB — bounded enough to be
 *  safe, large enough to ride out a minute-long database blip. */
const MAX_BUFFER = 5_000;

/** One HTTP request, as recorded by `ApiCallInterceptor`. */
export interface ApiCallRecord {
  requestId: string;
  method: string;
  path: string;
  routeParams?: Record<string, unknown>;
  statusCode: number;
  durationMs: number;
  userId?: string;
  ip?: string;
  userAgent?: string;
  error?: string;
}

/**
 * TelemetryService — the sink. Buffers telemetry in memory and flushes it to
 * Postgres in batches, and re-broadcasts agent events in-process so the admin
 * portal's live stream does not have to poll the database.
 *
 * Three properties this has to hold, in priority order:
 *
 *  1. **It can never slow down or fail a user request.** Records are pushed
 *     onto an array and the caller returns immediately. Writes happen on a
 *     timer, off the request path. A `createMany` that throws is logged once
 *     and the batch is dropped.
 *  2. **It can never grow without bound.** Buffers are capped. Under a write
 *     outage or a traffic spike the OLDEST records are discarded, not the
 *     newest — during an incident the recent past is what an operator needs,
 *     and an unbounded buffer would turn a database problem into an
 *     out-of-memory problem in the trading API.
 *  3. **Live views must be live.** `bus` emits every agent event synchronously
 *     as it arrives, so the SSE endpoint streams at event latency rather than
 *     at flush latency. The database write is for history; the bus is for now.
 *
 * Buffering is what makes (1) affordable: a single Sentinel observation
 * produces one API row, several AI rows and a dozen activity rows, and writing
 * each one inline would add more round-trips to the request than the actual
 * work does.
 */
@Injectable()
export class TelemetryService implements TelemetrySink, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelemetryService.name);

  /** Live fan-out for the admin SSE endpoint. Events: 'activity' | 'run' | 'ai'. */
  readonly bus = new EventEmitter();

  private apiCalls: ApiCallRecord[] = [];
  private aiCalls: AiCallEvent[] = [];
  private activity: AgentActivityEvent[] = [];
  private runStarts: AgentRunStartEvent[] = [];
  private runEnds: AgentRunEndEvent[] = [];

  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  /** Flush cadence. Two seconds keeps the admin tables feeling immediate
   *  without turning every page of traffic into its own transaction. */
  private static readonly FLUSH_MS = 2_000;

  constructor(private readonly prisma: PrismaService) {
    // The SSE endpoint attaches one listener per connected admin; the default
    // ceiling of 10 would start printing spurious leak warnings with a handful
    // of open tabs.
    this.bus.setMaxListeners(50);
  }

  onModuleInit(): void {
    // Installing the sink here — not in main.ts — means anything that resolves
    // ai-core through Nest is instrumented before the first request is served.
    setTelemetrySink(this);
    this.timer = setInterval(() => void this.flush(), TelemetryService.FLUSH_MS);
    // Do not hold the process open for a telemetry timer during shutdown.
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    setTelemetrySink(null);
    // Best-effort final flush so a clean restart doesn't lose the last window.
    await this.flush();
  }

  // ---------------------------------------------------------------- ingest

  recordApiCall(record: ApiCallRecord): void {
    push(this.apiCalls, record);
  }

  aiCall(event: AiCallEvent): void {
    push(this.aiCalls, event);
    this.bus.emit('ai', event);
  }

  agentActivity(event: AgentActivityEvent): void {
    push(this.activity, event);
    this.bus.emit('activity', event);
  }

  runStart(event: AgentRunStartEvent): void {
    push(this.runStarts, event);
    this.bus.emit('run', { phase: 'start', ...event });
  }

  runEnd(event: AgentRunEndEvent): void {
    push(this.runEnds, event);
    this.bus.emit('run', { phase: 'end', ...event });
  }

  // ----------------------------------------------------------------- flush

  /**
   * Drain every buffer into Postgres.
   *
   * Buffers are swapped out BEFORE any await, so records arriving mid-flush
   * land in the fresh array and are picked up next tick rather than being
   * silently dropped or double-written. `flushing` guards against a slow write
   * overlapping the next timer tick.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    const apiCalls = this.apiCalls;
    const aiCalls = this.aiCalls;
    const activity = this.activity;
    const runStarts = this.runStarts;
    const runEnds = this.runEnds;
    if (!apiCalls.length && !aiCalls.length && !activity.length && !runStarts.length && !runEnds.length) return;

    this.apiCalls = [];
    this.aiCalls = [];
    this.activity = [];
    this.runStarts = [];
    this.runEnds = [];
    this.flushing = true;

    try {
      // `skipDuplicates` on every insert: these tables are append-only with
      // generated ids, so a duplicate can only come from a retry, and dropping
      // it is strictly better than failing the batch.
      if (apiCalls.length) {
        await this.prisma.apiCallLog.createMany({
          data: apiCalls.map((c) => ({
            requestId: c.requestId,
            method: c.method,
            path: c.path,
            routeParams: (c.routeParams ?? undefined) as never,
            statusCode: c.statusCode,
            durationMs: c.durationMs,
            userId: c.userId ?? null,
            ip: c.ip ?? null,
            userAgent: c.userAgent?.slice(0, 512) ?? null,
            error: c.error?.slice(0, 500) ?? null,
          })),
          skipDuplicates: true,
        });
      }

      if (aiCalls.length) {
        await this.prisma.aiCallLog.createMany({
          data: aiCalls.map((c) => ({
            requestId: c.requestId ?? null,
            system: c.system,
            agent: c.agent,
            provider: c.provider,
            model: c.model,
            tier: c.tier ?? null,
            promptTokens: c.promptTokens,
            completionTokens: c.completionTokens,
            costUsd: c.costUsd,
            latencyMs: c.latencyMs,
            status: c.status,
            error: c.error?.slice(0, 500) ?? null,
            userId: c.userId ?? null,
          })),
          skipDuplicates: true,
        });
      }

      if (activity.length) {
        await this.prisma.agentActivity.createMany({
          data: activity.map((a) => ({
            runId: a.runId,
            requestId: a.requestId ?? null,
            system: a.system,
            agent: a.agent,
            state: a.state,
            peer: a.peer ?? null,
            detail: a.detail?.slice(0, 300) ?? null,
            durationMs: a.durationMs ?? null,
            createdAt: new Date(a.at),
          })),
          skipDuplicates: true,
        });
      }

      if (runStarts.length) {
        await this.prisma.agentRun.createMany({
          data: runStarts.map((r) => ({
            runId: r.runId,
            requestId: r.requestId ?? null,
            system: r.system,
            trigger: r.trigger,
            symbol: r.symbol ?? null,
            userId: r.userId ?? null,
            agentsRan: [],
            status: 'running',
            startedAt: new Date(r.at),
          })),
          skipDuplicates: true,
        });
      }

      // Ends are updates, so they cannot be batched into one statement. They
      // are also far rarer than activity rows (one per run, not one per
      // transition), so the loop is bounded by run count, not traffic.
      //
      // A missing start row means the run began before this process did — a
      // restart mid-run. `catch` and move on: losing the tail of one run is not
      // worth failing the batch that follows it.
      for (const end of runEnds) {
        await this.prisma.agentRun
          .update({
            where: { runId: end.runId },
            data: {
              status: end.status,
              agentsRan: end.agentsRan,
              surfaced: end.surfaced,
              confidence: end.confidence ?? null,
              error: end.error?.slice(0, 500) ?? null,
              durationMs: end.durationMs,
              finishedAt: new Date(end.at),
            },
          })
          .catch(() => undefined);
      }
    } catch (err) {
      // One line, not one per record — a database outage must not also produce
      // a log flood. The batch is gone; that is the accepted trade.
      this.logger.warn(
        `telemetry flush dropped ${apiCalls.length + aiCalls.length + activity.length} records: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.flushing = false;
    }
  }
}

/** Append with a cap, discarding oldest-first. See property (2) above. */
function push<T>(buffer: T[], record: T): void {
  buffer.push(record);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
}
