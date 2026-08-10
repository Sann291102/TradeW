import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from './prisma/prisma.service';

/**
 * Liveness, readiness and dependency reporting.
 *
 * WHY THESE ARE THREE DIFFERENT THINGS
 *
 * Until the 2026-08-10 readiness audit this service exposed one endpoint,
 * `/health`, which returned `{ ok: true }` unconditionally — it proved the
 * event loop was turning and nothing else. Both compose healthchecks and the
 * deploy flow keyed off it, which produced two specific failure modes:
 *
 *  · A container whose database was unreachable reported healthy, so a rolling
 *    deploy would shift traffic onto it and every DB-backed route would 500.
 *    `PrismaService` deliberately boots through a database outage (a DB blip
 *    must not crash-loop the API), which is right — but it means "the process
 *    started" and "this instance can serve requests" genuinely are different
 *    questions, and only one endpoint was answering them.
 *  · Conversely, a slow database would fail a *liveness* probe and get the
 *    container killed, turning a recoverable dependency problem into a restart
 *    loop that guarantees an outage.
 *
 * So: `/live` answers "is this process wedged?" and touches nothing. `/ready`
 * answers "should a load balancer send this instance traffic?" and checks the
 * one dependency without which almost nothing works. `/health` is retained
 * verbatim as the liveness alias because infra/docker's healthchecks, the OCI
 * runbook and deploy tooling already call it; changing its contract to a
 * dependency check would have made every existing probe wrong in the other
 * direction.
 *
 * Deliberately public and deliberately terse. A probe runs without credentials,
 * so the payload names no versions, hostnames or connection strings — an
 * unauthenticated caller learns that the service exists, which they already
 * knew, and nothing about how it is wired.
 */

/** A hung query must not hang the probe — the probe's whole job is to answer. */
const DB_PROBE_TIMEOUT_MS = 2_000;

@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness probe. Public — deployment tooling calls this without credentials. */
  @Get('health')
  @ApiOperation({ summary: 'Liveness. Answers as long as the process is running.' })
  health() {
    return this.liveness();
  }

  /** Explicit liveness alias, for orchestrators that expect the conventional name. */
  @Get('live')
  @ApiOperation({ summary: 'Liveness alias. Identical to /health.' })
  live() {
    return this.liveness();
  }

  /**
   * Readiness probe. 200 when this instance can actually serve DB-backed
   * routes, 503 when it cannot — which is the signal a load balancer needs to
   * stop routing to it without the orchestrator also killing it.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness. 503 while the database is unreachable.' })
  async ready(@Res({ passthrough: true }) res: { status(code: number): unknown }) {
    const database = await this.probeDatabase();
    if (!database.ok) res.status(503);
    return {
      ok: database.ok,
      service: 'tradew-backend',
      checks: { database },
      timestamp: new Date().toISOString(),
    };
  }

  private liveness() {
    return {
      ok: true,
      service: 'tradew-backend',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * The cheapest statement that proves a usable connection end to end: it goes
   * through the same pool every request uses, so a pool exhausted by leaked
   * connections fails here rather than passing a probe that never asked for one.
   */
  private async probeDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, DB_PROBE_TIMEOUT_MS);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      // The message is the operator's only clue and is not attacker-useful
      // beyond "the database is unhappy", which the 503 already said.
      return { ok: false, latencyMs: Date.now() - started, error: errorName(err) };
    }
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      // A pending probe timer must not hold the process open during shutdown.
      t.unref?.();
    }),
  ]);
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.message === 'timeout' ? 'timeout' : 'unavailable';
  return 'unavailable';
}
