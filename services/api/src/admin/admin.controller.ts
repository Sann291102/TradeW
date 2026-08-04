import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { IsBoolean, IsEmail } from 'class-validator';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { TelemetryService } from '../telemetry/telemetry.service';

class SetAdminDto {
  @IsEmail()
  email!: string;

  @IsBoolean()
  isAdmin!: boolean;
}

/**
 * The admin portal's API.
 *
 * `@UseGuards(AdminGuard)` sits on the CLASS, not on individual handlers. That
 * is deliberate: a route added later is protected by default, and forgetting a
 * decorator cannot silently expose the platform's entire activity log. There is
 * no unguarded route on this controller and there must never be one.
 *
 * Everything here is namespaced under `/admin`, served by the same API process
 * as everything else. The single-ingress rule in ARCHITECTURE.md §1 applies to
 * the admin surface too — a second listener would be a second thing to secure,
 * and this surface is the one that least deserves a bespoke auth path.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly telemetry: TelemetryService,
  ) {}

  // -------------------------------------------------------------- overview

  @Get('overview')
  overview(@Query('hours') hours?: string) {
    return this.admin.overview(Number(hours) || 24);
  }

  @Get('health')
  health() {
    return this.admin.health();
  }

  // ------------------------------------------------------------- api calls

  @Get('api-calls')
  apiCalls(
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('path') path?: string,
    @Query('userId') userId?: string,
    @Query('hours') hours?: string,
  ) {
    return this.admin.apiCalls({ limit: Number(limit), status, path, userId, hours: Number(hours) });
  }

  @Get('api-calls/timeseries')
  apiTimeseries(@Query('hours') hours?: string) {
    return this.admin.apiTimeseries(Number(hours) || 24);
  }

  @Get('api-calls/routes')
  routeStats(@Query('hours') hours?: string, @Query('limit') limit?: string) {
    return this.admin.routeStats(Number(hours) || 24, Number(limit) || 25);
  }

  // -------------------------------------------------------------------- AI

  @Get('ai/calls')
  aiCalls(
    @Query('limit') limit?: string,
    @Query('system') system?: string,
    @Query('agent') agent?: string,
    @Query('status') status?: string,
    @Query('hours') hours?: string,
  ) {
    return this.admin.aiCalls({ limit: Number(limit), system, agent, status, hours: Number(hours) });
  }

  @Get('ai/by-agent')
  aiByAgent(@Query('hours') hours?: string) {
    return this.admin.aiByAgent(Number(hours) || 24);
  }

  @Get('ai/timeseries')
  aiTimeseries(@Query('hours') hours?: string) {
    return this.admin.aiTimeseries(Number(hours) || 24);
  }

  // ---------------------------------------------------------------- agents

  /** Current state of every known agent — the orbit's initial paint. */
  @Get('agents/states')
  agentStates(@Query('system') system?: string) {
    return this.admin.agentStates(system || 'sentinel');
  }

  @Get('agents/runs')
  runs(
    @Query('limit') limit?: string,
    @Query('system') system?: string,
    @Query('status') status?: string,
    @Query('hours') hours?: string,
  ) {
    return this.admin.runs({ limit: Number(limit), system, status, hours: Number(hours) });
  }

  @Get('agents/runs/:runId')
  runActivity(@Param('runId') runId: string) {
    return this.admin.runActivity(runId);
  }

  /**
   * Live agent activity, as Server-Sent Events.
   *
   * SSE rather than WebSocket: the stream is one-directional (the portal never
   * talks back), it survives proxies that mangle upgrades, and it reconnects on
   * its own. A WebSocket would add a protocol and a dependency to do less.
   *
   * Written against the raw response rather than Nest's `@Sse()` decorator so
   * the listener can be detached on `close`. `@Sse()` returns an Observable
   * whose teardown is easy to get subtly wrong, and a leaked listener here
   * accumulates on every dashboard reload for the life of the process.
   */
  @Get('stream')
  stream(@Req() req: StreamRequest, @Res() res: StreamResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx buffers proxied responses by default, which turns a live stream
      // into a stream that arrives all at once, minutes late.
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* client vanished mid-write; the close handler will clean up */
      }
    };

    send('hello', { at: Date.now() });

    const onActivity = (e: unknown) => send('activity', e);
    const onRun = (e: unknown) => send('run', e);
    const onAi = (e: unknown) => send('ai', e);
    this.telemetry.bus.on('activity', onActivity);
    this.telemetry.bus.on('run', onRun);
    this.telemetry.bus.on('ai', onAi);

    // Idle connections get closed by intermediaries at around 60s. A comment
    // frame every 25s keeps the pipe warm without producing a client event.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      this.telemetry.bus.off('activity', onActivity);
      this.telemetry.bus.off('run', onRun);
      this.telemetry.bus.off('ai', onAi);
      res.end();
    });
  }

  // ---------------------------------------------------------------- orders

  @Get('orders')
  orders(
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('hours') hours?: string,
  ) {
    return this.admin.orders({ limit: Number(limit), status, userId, hours: Number(hours) });
  }

  @Get('orders/stats')
  orderStats(@Query('hours') hours?: string) {
    return this.admin.orderStats(Number(hours) || 24);
  }

  @Get('trades')
  trades(@Query('limit') limit?: string, @Query('hours') hours?: string) {
    return this.admin.trades(Number(limit) || 100, Number(hours) || 24);
  }

  // ----------------------------------------------------------------- users

  @Get('users')
  users(@Query('limit') limit?: string, @Query('q') q?: string) {
    return this.admin.users({ limit: Number(limit), q });
  }

  @Get('audit')
  audit(
    @Query('limit') limit?: string,
    @Query('eventType') eventType?: string,
    @Query('userId') userId?: string,
    @Query('hours') hours?: string,
  ) {
    return this.admin.auditEvents({ limit: Number(limit), eventType, userId, hours: Number(hours) });
  }

  /** POST, not PATCH on a user resource: this is a privilege change, and it
   *  reads better in the audit log as its own named action. */
  @Post('users/set-admin')
  setAdmin(@Body() body: SetAdminDto, @Req() req: { user?: { sub?: string } }) {
    return this.admin.setAdmin(body.email, body.isAdmin, req.user?.sub ?? 'unknown');
  }
}

/** Only the members used above, so @types/express isn't pulled in for one route. */
interface StreamRequest {
  on(event: 'close', handler: () => void): void;
}

interface StreamResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): boolean;
  end(): void;
}
