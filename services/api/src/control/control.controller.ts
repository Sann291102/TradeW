import { applyDecorators, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ControlGuard } from './control.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { AdminService } from '../admin/admin.service';

/**
 * The signed-request envelope, as documentation.
 *
 * Every header here is mandatory and checked by `ControlGuard`. They are listed
 * so the contract is legible to whoever implements the control-plane client —
 * not so this surface can be exercised from Swagger UI, which it cannot be:
 * `X-Control-Signature` covers a canonical string over the method, path, body
 * hash, timestamp and nonce, and only the Admin Control Plane holds the private
 * key. **Try it out** here returns 401 by design.
 */
const ApiControlEnvelope = () =>
  applyDecorators(
    ApiSecurity(SECURITY.controlSignature),
    ApiHeader({ name: 'X-Control-Protocol', required: true, description: 'Must be `TRADEW-CONTROL-v1`.' }),
    ApiHeader({ name: 'X-Control-Key-Id', required: true, description: 'Selects one of the configured Ed25519 public keys.' }),
    ApiHeader({ name: 'X-Control-Timestamp', required: true, description: 'Unix ms. Rejected beyond 30s of clock skew.' }),
    ApiHeader({ name: 'X-Control-Nonce', required: true, description: 'Single-use, at least 16 characters. A repeat is refused as a replay.' }),
    ApiHeader({ name: 'X-Control-Actor', required: true, description: 'The control-plane operator identity the action is attributed to.' }),
    ApiHeader({ name: 'X-Control-Capability', required: true, description: 'The capability being exercised. Checked against an allowlist independent of the admin plane’s own RBAC.' }),
    ApiHeader({ name: 'X-Correlation-Id', required: false, description: 'Echoed back so an action can be traced across both repositories.' }),
    ApiResponse({ status: 401, description: 'Rejected: bad protocol, unknown key, stale timestamp, replayed nonce, or failed signature.' }),
  );

/**
 * The TradeW Control API — the ONLY surface the Admin Control Plane may use.
 *
 * Deliberately narrow. This is not a proxy for the customer API and must never
 * become one: every route here is a specific, named capability that some admin
 * screen genuinely needs, not a generic query interface. "Give the control
 * plane a way to run arbitrary reads" is functionally equivalent to giving it
 * database access, which is the thing the architecture forbids.
 *
 * Every route reuses the existing `AdminService`, so this adds a boundary
 * rather than a second implementation of the same queries.
 *
 * Mutating routes are stubbed with explicit 501s rather than faked. An admin
 * console that appears to stop an agent and silently does nothing is worse than
 * one that says it cannot yet.
 */
@ApiTags('Control Plane')
@ApiControlEnvelope()
@Controller('control')
@UseGuards(ControlGuard)
export class ControlController {
  constructor(private readonly admin: AdminService) {}

  /**
   * The first screen's data. Real health, from the same source the existing
   * operator console reads.
   */
  @Get('system/health')
  async systemHealth(@Req() req: ControlRequest) {
    const health = await this.admin.health();
    return {
      ...health,
      controlPlane: {
        servedAt: new Date().toISOString(),
        correlationId: req.control?.correlationId ?? null,
      },
    };
  }

  @Get('system/overview')
  overview() {
    return this.admin.overview(24);
  }

  @Get('agents')
  agents() {
    return this.admin.agentStates('sentinel', 30);
  }

  @Get('agents/runs')
  runs() {
    return this.admin.runs({ limit: 50, hours: 24 });
  }

  @Get('sentinel/status')
  async sentinelStatus() {
    // Sentinel's own health lives behind SENTINEL_URL. Reported as degraded
    // rather than thrown so one unhealthy dependency does not blank the whole
    // command centre.
    const base = process.env.SENTINEL_URL;
    if (!base) return { reachable: false, reason: 'SENTINEL_URL not configured' };
    try {
      const res = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(3000) });
      return { reachable: res.ok, status: res.status, body: res.ok ? await res.json() : null };
    } catch (err) {
      return { reachable: false, reason: String(err) };
    }
  }

  @Get('trading/status')
  async tradingStatus() {
    const stats = await this.admin.orderStats(24);
    return {
      // There is no live execution path in TradeW today and no PAPER/LIVE
      // discriminator on Order. Reporting the environment as PAPER is therefore
      // a statement of fact about the system, not a default to be overridden.
      environment: 'PAPER',
      liveExecutionAvailable: false,
      stats,
    };
  }

  @Get('trading/orders')
  orders() {
    return this.admin.orders({ limit: 100, hours: 24 });
  }

  // ── Mutating control. Not yet implemented; explicitly refused. ───────────

  /** Stop one agent. Refused with 501 — no agent runtime is instantiated yet. */
  @ApiResponse({ status: 501, description: 'No agent runtime is instantiated in TradeW Core yet.' })
  @Post('agents/:id/stop')
  stopAgent() {
    return notImplemented('agent stop', 'No agent runtime is instantiated in TradeW Core yet');
  }

  /** Halt trading. Refused with 501 — the order path has no kill switch yet. */
  @ApiResponse({ status: 501, description: 'No kill switch exists in the order path yet.' })
  @Post('system/pause')
  pauseTrading() {
    return notImplemented('trading pause', 'No kill switch exists in the order path yet');
  }

  /** Arm live execution. Refused with 501 — there is no live execution path. */
  @ApiResponse({ status: 501, description: 'No live execution path exists in TradeW Core.' })
  @Post('trading/live/authorize')
  authorizeLive() {
    return notImplemented('live authorization', 'No live execution path exists in TradeW Core');
  }
}

/** Only the block `ControlGuard` attaches is read here, so the request is typed
 *  structurally rather than pulling `@types/express` in for one route — the same
 *  reason the security-header middleware in main.ts types its response that way. */
interface ControlRequest {
  control?: { correlationId?: string | null };
}

function notImplemented(action: string, why: string): never {
  const err: Error & { status?: number; response?: unknown } = new Error(`Not implemented: ${action}`);
  err.status = 501;
  err.response = { statusCode: 501, error: 'NotImplemented', action, reason: why };
  throw err;
}
