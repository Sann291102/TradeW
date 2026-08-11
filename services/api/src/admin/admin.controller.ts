import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiProperty, ApiPropertyOptional, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString } from 'class-validator';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { CognitionService } from '../cognition/cognition.service';
import { SECURITY } from '../swagger/swagger.setup';
import { TelemetryService } from '../telemetry/telemetry.service';

/**
 * Request bodies.
 *
 * All of them are declared ABOVE the controller, and that placement is load
 * bearing rather than stylistic. `emitDecoratorMetadata` resolves a handler's
 * parameter types at the moment the controller class is *defined*, so a DTO
 * declared further down the file is still in its temporal dead zone and the
 * module throws `ReferenceError: Cannot access 'X' before initialization` at
 * import time. TypeScript does not flag it and no unit test catches it — the
 * whole API simply fails to boot. Add new DTOs here, never below.
 */
class SetAdminDto {
  @ApiProperty({ format: 'email', description: 'The user whose privilege is changing.' })
  @IsEmail()
  email!: string;

  @ApiProperty({ description: 'True grants admin, false revokes it.' })
  @IsBoolean()
  isAdmin!: boolean;
}

class SetPerceptorEnabledDto {
  @ApiProperty({ description: 'True runs this sensor on the next pass, false skips it.' })
  @IsBoolean()
  enabled!: boolean;
}

class ResolveProposalDto {
  @ApiProperty({
    enum: ['accepted', 'dismissed', 'done'],
    description:
      'How it was resolved. `dismissed` teaches the network the finding was wrong and is the only negative signal it ever receives.',
  })
  @IsIn(['accepted', 'dismissed', 'done'])
  status!: 'accepted' | 'dismissed' | 'done';

  @ApiPropertyOptional({ description: 'Free-text note recorded against the proposal.' })
  @IsOptional()
  @IsString()
  resolution?: string;
}

class RunPassDto {
  @ApiPropertyOptional({
    enum: ['market', 'application', 'assistant', 'learning', 'platform'],
    description: 'Restrict the pass to one domain. Omit to sense everything.',
  })
  @IsOptional()
  @IsIn(['market', 'application', 'assistant', 'learning', 'platform'])
  domain?: 'market' | 'application' | 'assistant' | 'learning' | 'platform';
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
@ApiTags('Admin')
/**
 * Both credentials, both required — a single security requirement naming two
 * schemes rather than two separate requirements, which OpenAPI would read as
 * "either one will do". `AdminGuard` demands both, so the document has to say
 * both, or the reference would advertise a way in that does not exist.
 */
@ApiSecurity({ [SECURITY.bearer]: [], [SECURITY.adminToken]: [] })
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly telemetry: TelemetryService,
    private readonly cognition: CognitionService,
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
  // Excluded from the reference rather than listed-and-broken: "Try it out" on
  // an endless text/event-stream response leaves Swagger UI spinning forever
  // with no way to cancel. It is described in the page's own introduction
  // instead, together with the query-parameter credentials EventSource needs.
  @ApiExcludeEndpoint()
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

  // ------------------------------------------------------------- cognition

  /**
   * Layer stack, sensor roster and weight statistics. The page's first paint.
   *
   * Served off `CognitionService` rather than `AdminService` because this is the
   * network's *live* state, not a Prisma read — and because `AdminService` is
   * also provided standalone inside `ControlModule`, which does not import
   * `CognitionModule`. A dependency added there takes the control plane down at
   * boot. Live state goes on the controller; queries go in the service.
   */
  @Get('cognition/overview')
  cognitionOverview() {
    return this.cognition.snapshot();
  }

  /** Sensor definitions joined to live health. Same reasoning as above. */
  @Get('cognition/perceptors')
  cognitionPerceptors() {
    return this.cognition.perceptors();
  }

  @Get('cognition/episodes')
  cognitionEpisodes(
    @Query('limit') limit?: string,
    @Query('domain') domain?: string,
    @Query('status') status?: string,
    @Query('hours') hours?: string,
    @Query('unscoredOnly') unscoredOnly?: string,
  ) {
    return this.admin.cognitionEpisodes({
      limit: Number(limit),
      domain,
      status,
      hours: Number(hours),
      unscoredOnly: unscoredOnly === 'true',
    });
  }

  @Get('cognition/episodes/:episodeId')
  cognitionEpisode(@Param('episodeId') episodeId: string) {
    return this.admin.cognitionEpisode(episodeId);
  }

  @Get('cognition/percepts')
  cognitionPercepts(
    @Query('limit') limit?: string,
    @Query('domain') domain?: string,
    @Query('perceptorId') perceptorId?: string,
    @Query('hours') hours?: string,
  ) {
    return this.admin.cognitionPercepts({ limit: Number(limit), domain, perceptorId, hours: Number(hours) });
  }

  @Get('cognition/synapses')
  cognitionSynapses(
    @Query('limit') limit?: string,
    @Query('layer') layer?: string,
    @Query('provenOnly') provenOnly?: string,
  ) {
    return this.admin.cognitionSynapses({ limit: Number(limit), layer, provenOnly: provenOnly === 'true' });
  }

  @Get('cognition/proposals')
  cognitionProposals(
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('domain') domain?: string,
    @Query('hours') hours?: string,
  ) {
    return this.admin.cognitionProposals({ limit: Number(limit), status, domain, hours: Number(hours) });
  }

  /**
   * Turn a sensor on or off.
   *
   * One of only three writes this controller offers, and the reason it exists
   * is operational: a perceptor that has started flooding must be stoppable
   * without a deploy, during the incident it is making worse. The decision is
   * persisted, so it survives the restart that follows.
   */
  @Post('cognition/perceptors/:id/enabled')
  setPerceptorEnabled(@Param('id') id: string, @Body() body: SetPerceptorEnabledDto) {
    return this.cognition.setPerceptorEnabled(id, body.enabled).then(() => ({ ok: true }));
  }

  /**
   * Resolve a proposal, which is also how the network gets told it was wrong.
   *
   * This is the platform's only source of a negative training label. Every other
   * signal available to the network is "something happened"; a dismissal is a
   * human saying "and it did not matter", attached to a specific chain of
   * activations while the eligibility traces are still live. Without this
   * endpoint the weights only ever move in one direction.
   */
  @Post('cognition/proposals/:id/resolve')
  resolveProposal(
    @Param('id') id: string,
    @Body() body: ResolveProposalDto,
    @Req() req: { user?: { sub?: string } },
  ) {
    return this.cognition
      .resolveProposal(id, body.status, req.user?.sub ?? 'unknown', body.resolution)
      .then(() => ({ ok: true }));
  }

  /**
   * Run a pass now, rather than waiting for the tick.
   *
   * Deliberately not a way to inject percepts — it senses the same sources the
   * scheduled pass does. An operator endpoint that could fabricate observations
   * would put arbitrary content into the network's permanent memory through the
   * one door that skips every producer's own validation.
   */
  @Post('cognition/run')
  runPass(@Body() body: RunPassDto) {
    return this.cognition.runPass({ trigger: 'manual', domain: body.domain });
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
