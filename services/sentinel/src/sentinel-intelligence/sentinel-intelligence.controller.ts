import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ServiceTokenGuard } from '../app.controller';
import { SentinelIntelligenceService } from './sentinel-intelligence.service';
import { WorkspaceService } from './visual/workspace.service';
import type { ReasonRequest } from './types';

/**
 * SentinelIntelligence's HTTP surface, mounted under `/intelligence`.
 *
 * A separate controller from `AppController` on purpose: the existing routes
 * (`/observe`, `/strategies`, `/timeline`, …) are the orchestrator's contract
 * and `services/api` depends on their exact shapes. Adding routes here means
 * nothing about the existing surface changes.
 *
 * Every route is behind `ServiceTokenGuard`, reusing the existing guard rather
 * than declaring a second auth path — `apps/*` never call Sentinel directly
 * (ARCHITECTURE.md §1, one public ingress).
 */
@Controller('intelligence')
@UseGuards(ServiceTokenGuard)
export class SentinelIntelligenceController {
  constructor(
    private readonly engine: SentinelIntelligenceService,
    private readonly workspace: WorkspaceService,
  ) {}

  /**
   * Corpus, graph, agent roster and the active gates.
   *
   * The first call to this on a cold service reports an empty corpus — indexing
   * is triggered by the first `/reason` call, not at boot, because parsing 30 MB
   * of PDFs during startup would delay the health check past most orchestrators'
   * patience. Call `POST /intelligence/reindex` to build it explicitly.
   */
  @Get('status')
  status() {
    return this.engine.status();
  }

  /**
   * The reasoning entrypoint.
   *
   * Always returns a full run. `synthesis.surfaced === false` with
   * `synthesis.silenceReason` set is the *designed* outcome when the gates do
   * not clear — callers must render nothing in that case rather than treating
   * it as an error.
   */
  @Post('reason')
  async reason(@Body() body: ReasonRequest) {
    if (!body?.userId) throw new BadRequestException('userId is required');
    if (!body.query && !body.symbol) {
      throw new BadRequestException('either a free-text `query` or a `symbol` is required');
    }
    return this.engine.reason(body);
  }

  /** The three-panel visual strategy workspace payload. */
  @Post('workspace')
  async workspaceView(@Body() body: ReasonRequest) {
    if (!body?.userId) throw new BadRequestException('userId is required');
    if (!body.query && !body.symbol) {
      throw new BadRequestException('either a free-text `query` or a `symbol` is required');
    }
    return this.workspace.build(body);
  }

  /**
   * Teach the engine a TradingView strategy: rules, indicator logic and
   * drawing specifications.
   *
   * Returns `422` semantics as a structured issue list rather than a bare
   * error, because the caller is an author iterating on a spec and needs to
   * know which field is wrong, not merely that something was.
   */
  @Post('rules')
  async learnRule(@Body() body: unknown) {
    const result = await this.workspace.learnRule(body);
    if (!result.spec) {
      throw new BadRequestException({
        message: 'The strategy specification did not validate.',
        issues: result.issues,
      });
    }
    return {
      learned: true,
      replaced: result.replaced,
      chunksIndexed: result.chunksIndexed,
      spec: result.spec,
    };
  }

  @Get('rules')
  listRules() {
    return this.workspace.listRules();
  }

  @Delete('rules/:id')
  async retireRule(@Param('id') id: string) {
    const retired = await this.workspace.retireRule(id);
    if (!retired) throw new NotFoundException(`No learned strategy with id "${id}"`);
    return { retired: true, id };
  }

  /**
   * Re-index the corpus.
   *
   * Incremental by default — unchanged documents are detected by content
   * checksum and skipped, so this is cheap to call on a schedule. `force=true`
   * re-parses everything, which for the full book corpus is minutes, not
   * seconds.
   */
  @Post('reindex')
  reindex(@Query('force') force?: string) {
    return this.engine.reindex(force === 'true');
  }
}
