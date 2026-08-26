import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiProperty, ApiPropertyOptional, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminService } from './admin.service';
import { CognitionService } from '../cognition/cognition.service';
import { ExecutionAccountService } from '../paper-execution/execution-account.service';
import { ExecutionProfileService } from '../paper-execution/execution-profile.service';
import { ExecutionQueryService } from '../paper-execution/execution-query.service';
import { ExecutionSchedulerService } from '../paper-execution/execution-scheduler.service';
import { ExecutionTraceService } from '../paper-execution/execution-trace.service';
import { PaperExecutionService } from '../paper-execution/paper-execution.service';
import { SystemExecutionControlService } from '../paper-execution/system-execution-control.service';
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

class SetProfileEnabledDto {
  @ApiProperty({ description: 'True lets this execution profile trade on the next pass, false stops it.' })
  @IsBoolean()
  enabled!: boolean;
}

class SetSystemExecutionModeDto {
  @ApiProperty({
    enum: ['ON', 'OFF', 'EMERGENCY_STOP'],
    description:
      'ON = new entries permitted. OFF = paused (no new entries; open positions still close on their schedule). ' +
      'EMERGENCY_STOP = no new entries AND every open agent position is squared off on the next reconcile tick. ' +
      'A runtime kill switch — takes effect on the loop’s next pass, no redeploy.',
  })
  @IsIn(['ON', 'OFF', 'EMERGENCY_STOP'])
  mode!: 'ON' | 'OFF' | 'EMERGENCY_STOP';

  @ApiPropertyOptional({ description: 'Free-text note recorded with the change and shown on the console (e.g. why the halt).' })
  @IsOptional()
  @IsString()
  reason?: string;
}

class SetAgentPaperTradingDto {
  @ApiProperty({
    description:
      'True permits an execution profile to place PAPER orders in this user’s own paper account; false revokes it. ' +
      'Never a credential — the account is referenced by internal id throughout.',
  })
  @IsBoolean()
  enabled!: boolean;
}

/**
 * Create or rebind an execution profile.
 *
 * There is deliberately NO `environment` field: the server writes PAPER and the
 * enum has no other member, so an environment supplied by a caller would be a
 * value that cannot be honoured. And there is no credential field of any kind —
 * the account is identified by `accountUserId`, an internal id.
 */
class UpsertExecutionProfileDto {
  @ApiProperty({ description: 'Unique profile name, e.g. sentinel-alpha-nifty-vivek.' })
  @IsString()
  name!: string;

  @ApiProperty({ description: 'Sentinel agent identity, e.g. sentinel-alpha.' })
  @IsString()
  agent!: string;

  @ApiProperty({ description: 'Underlying to trade, e.g. NIFTY. Must be in the permitted market list.' })
  @IsString()
  symbol!: string;

  @ApiProperty({ description: 'The TradeW user whose PAPER account this profile trades. Internal id, never an email/password.' })
  @IsString()
  accountUserId!: string;

  @ApiProperty({
    enum: ['SYSTEM_PAPER', 'USER_PAPER'],
    description:
      'SYSTEM_PAPER = a dedicated non-loginable machine account. USER_PAPER = a real TradeW user’s own paper account, ' +
      'which additionally requires that user’s recorded consent.',
  })
  @IsIn(['SYSTEM_PAPER', 'USER_PAPER'])
  accountScope!: 'SYSTEM_PAPER' | 'USER_PAPER';

  @ApiPropertyOptional({ description: 'Registry strategy id to pin. Omit to let Sentinel choose (auto mode).' })
  @IsOptional()
  @IsString()
  strategyId?: string;

  @ApiPropertyOptional({ description: 'Human-readable strategy name, for the console.' })
  @IsOptional()
  @IsString()
  strategyName?: string;

  @ApiPropertyOptional({ description: 'Order size in lots; multiplied by the contract’s own lot size at submission.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  lots?: number;

  @ApiPropertyOptional({ description: 'Confidence floor, 70-100. May only be stricter than Sentinel’s own 70.' })
  @IsOptional()
  @IsInt()
  @Min(70)
  @Max(100)
  minConfidence?: number;

  @ApiPropertyOptional({ description: 'Concurrent open positions this profile may hold.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxOpenPositions?: number;

  @ApiPropertyOptional({ description: 'Executions this profile may make per IST day.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxOrdersPerDay?: number;

  @ApiPropertyOptional({ description: 'Stop trading for the day once realized P&L falls below minus this. Stored positive.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxLossPerDay?: number;

  @ApiPropertyOptional({ description: 'IST minute-of-day to flatten at, e.g. 910 for 15:10.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  squareOffMinute?: number;
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
 * "either one will do". Every path through `AdminAccessGuard` demands the
 * operator token plus one identity factor, so the document has to say both, or
 * the reference would advertise a way in that does not exist.
 *
 * The guard is `AdminAccessGuard`, not `AdminGuard`. It routes on the presence
 * of an `x-operator-assertion` header: absent → `apps/web`'s product-admin path
 * (JWT + `User.isAdmin`), delegated to `AdminGuard` unchanged; present →
 * `apps/admin`'s operator path (operator assertion + `OperatorAccount`). Both
 * still require `ADMIN_API_TOKEN`. See admin-access.guard.ts.
 */
@ApiSecurity({ [SECURITY.bearer]: [], [SECURITY.adminToken]: [] })
@Controller('admin')
@UseGuards(AdminAccessGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly telemetry: TelemetryService,
    private readonly cognition: CognitionService,
    private readonly executionQuery: ExecutionQueryService,
    private readonly executionScheduler: ExecutionSchedulerService,
    private readonly executionTrace: ExecutionTraceService,
    private readonly paperExecution: PaperExecutionService,
    private readonly executionAccounts: ExecutionAccountService,
    private readonly executionProfiles: ExecutionProfileService,
    private readonly systemControl: SystemExecutionControlService,
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

  /** Per-minute request/error/latency pulse for the System Pulse panel. */
  @Get('api-calls/pulse')
  apiPulse(@Query('minutes') minutes?: string) {
    return this.admin.apiPulse(Number(minutes) || 30);
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

  /** Real per-model roll-up for the Model Usage panel. */
  @Get('ai/by-model')
  aiByModel(@Query('hours') hours?: string) {
    return this.admin.aiByModel(Number(hours) || 24);
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
    /** 'sentinel' | 'user' — filters on whether an execution intent exists. */
    @Query('source') source?: string,
  ) {
    return this.admin.orders({ limit: Number(limit), status, userId, hours: Number(hours), source });
  }

  @Get('orders/stats')
  orderStats(@Query('hours') hours?: string) {
    return this.admin.orderStats(Number(hours) || 24);
  }

  @Get('trades')
  trades(@Query('limit') limit?: string, @Query('hours') hours?: string) {
    return this.admin.trades(Number(limit) || 100, Number(hours) || 24);
  }

  // ------------------------------------------------- Sentinel paper execution
  //
  // The operator surface for the execution loop. Reads are unrestricted within
  // this already twice-authenticated controller; the two WRITES below are the
  // only ways an operator can change what the loop does, and both are
  // deliberately coarse — enable/disable a profile, or run one pass by hand.
  // There is no endpoint that places an order directly, by design: the console
  // observes and configures, it never trades. See paper-execution.module.ts.

  @Get('execution/profiles')
  listExecutionProfiles() {
    return this.executionQuery.profiles();
  }

  @Get('execution/intents')
  executionIntents(
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('profileId') profileId?: string,
    @Query('hours') hours?: string,
  ) {
    return this.executionQuery.intents({
      limit: Number(limit) || 100,
      status,
      profileId,
      hours: Number(hours) || 24,
    });
  }

  @Get('execution/stats')
  executionStats(@Query('hours') hours?: string) {
    return this.executionQuery.stats(Number(hours) || 24);
  }

  /**
   * Is the loop actually ticking, or is it just armed?
   *
   * Answers from THIS PROCESS's live state, not from a table — see
   * `ExecutionSchedulerService.status`. The console shows it beside the armed
   * count, which is a database fact and cannot distinguish the two.
   *
   * Read-only: it starts and stops nothing.
   */
  @Get('execution/status')
  executionStatus() {
    return this.executionScheduler.status();
  }

  /** Today's refusals grouped by the gate that produced them. */
  @Get('execution/rejections')
  executionRejections(@Query('hours') hours?: string) {
    return this.executionQuery.rejections(Number(hours) || 24);
  }

  // ---- Global kill switch -------------------------------------------------
  //
  // The one control that stops (or resumes) ALL automatic entries at once,
  // without a redeploy and without disarming each profile by hand. Read is
  // unrestricted within this controller; the write is audited with the acting
  // operator, exactly like the consent grant below.

  /** The current global execution mode (ON / OFF / EMERGENCY_STOP). */
  @Get('execution/control')
  executionControl() {
    return this.systemControl.current();
  }

  /**
   * Set the global execution mode — the runtime kill switch.
   *
   * EMERGENCY_STOP is the "flatten everything now" state: it blocks new entries
   * and the reconcile tick squares off every open agent position immediately.
   * OFF pauses new entries but lets open positions close on their own schedule.
   * Audited with the operator on `req.user.sub`, in the same transaction as the
   * flag.
   */
  @Post('execution/control')
  setExecutionControl(@Body() body: SetSystemExecutionModeDto, @Req() req: { user?: { sub?: string } }) {
    return this.systemControl.setMode(body.mode, req.user?.sub ?? 'unknown', body.reason ?? null);
  }

  /** The full backward+forward provenance of one intent. */
  @Get('execution/trace/:intentId')
  executionTraceByIntent(@Param('intentId') intentId: string) {
    return this.executionTrace.byIntentId(intentId);
  }

  /** Same trace, entered from an order id — what the Orders table links to. */
  @Get('execution/trace-by-order/:orderId')
  executionTraceByOrder(@Param('orderId') orderId: string) {
    return this.executionTrace.byOrderId(orderId);
  }

  /**
   * Turn one profile on or off.
   *
   * The env flag `PAPER_EXECUTION_ENABLED` still gates the scheduler, so this
   * alone cannot start the loop — enabling is deliberately two acts in two
   * places (see ExecutionSchedulerService).
   */
  @Post('execution/profiles/:id/enabled')
  setExecutionProfileEnabled(@Param('id') id: string, @Body() body: SetProfileEnabledDto) {
    return this.admin.setExecutionProfileEnabled(id, body.enabled);
  }

  /**
   * Run one profile's pass immediately, instead of waiting for the timer.
   *
   * This is the same `runProfile` the scheduler calls — not a test double and
   * not a shortcut past any check. An operator triggering it gets exactly the
   * behaviour the loop would have had on its next tick, including every policy
   * gate and the idempotency key, so a hand-run during an active decision
   * window correctly reports `duplicate` rather than opening a second position.
   */
  @Post('execution/profiles/:id/run')
  runExecutionProfile(@Param('id') id: string) {
    return this.paperExecution.runProfile(id);
  }

  // ---- Account binding ----------------------------------------------------
  //
  // The workflow §14 describes: pick a real TradeW account, grant it agent
  // paper trading, bind a profile to it, arm, run. No endpoint here accepts or
  // returns a credential — accounts are addressed by internal id throughout,
  // and `eligibleAccounts` does not even SELECT `passwordHash`/`googleId`.

  /** TradeW accounts a USER_PAPER profile may be bound to. No credentials. */
  @Get('execution/accounts')
  listExecutionAccounts(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.executionAccounts.eligibleAccounts({ q, limit: Number(limit) || 50 });
  }

  /**
   * Grant or revoke a user's consent to agent paper trading.
   *
   * The switch that lets an autonomous agent trade in a real person's account,
   * so it is audited with the acting operator (`AdminAccessGuard` puts them on
   * `req.user.sub`) in the same transaction as the flag.
   */
  @Post('execution/accounts/:userId/agent-trading')
  setAgentPaperTrading(
    @Param('userId') userId: string,
    @Body() body: SetAgentPaperTradingDto,
    @Req() req: { user?: { sub?: string } },
  ) {
    return this.executionAccounts.setAgentPaperTrading(userId, body.enabled, req.user?.sub ?? 'unknown');
  }

  /** Create a profile, or rebind an existing one to a different account/policy. */
  @Post('execution/profiles')
  upsertExecutionProfile(@Body() body: UpsertExecutionProfileDto, @Req() req: { user?: { sub?: string } }) {
    return this.executionProfiles.upsert(body, req.user?.sub ?? 'unknown');
  }

  /** "Would this profile be allowed to trade right now?" — no side effects. */
  @Get('execution/profiles/:id/authorization')
  executionProfileAuthorization(@Param('id') id: string) {
    return this.executionProfiles.authorization(id);
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

  /** Per-domain percept ingestion + derived rate for the Perceptor Domains panel. */
  @Get('cognition/domains')
  cognitionDomains(@Query('hours') hours?: string) {
    return this.admin.cognitionDomains(Number(hours) || 24);
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
