import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { KnowledgeCenterService } from './brain/knowledge-center.service';
import { ComplianceService } from './compliance/compliance.service';
import { ObserveRequest } from './domain';
import { ExplainService } from './explain/explain.service';
import { SentinelOrchestratorService } from './orchestrator/sentinel-orchestrator.service';

/**
 * Internal-only ingress: every request must carry the shared service token.
 * Only services/api holds it — apps never call Sentinel directly
 * (ARCHITECTURE.md §1 single-public-ingress rule).
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.SERVICE_TOKEN;
    if (!expected) throw new UnauthorizedException('SERVICE_TOKEN not configured');
    const req = context.switchToHttp().getRequest();
    if (req.headers['x-service-token'] !== expected) throw new UnauthorizedException('Invalid service token');
    return true;
  }
}

@Controller()
export class AppController {
  constructor(
    private readonly orchestrator: SentinelOrchestratorService,
    private readonly compliance: ComplianceService,
    private readonly explainSvc: ExplainService,
    private readonly knowledgeCenter: KnowledgeCenterService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'sentinel' };
  }

  /** The single observation entrypoint. Sentinel comments in parallel with the order flow — it is never a gate in it. */
  @UseGuards(ServiceTokenGuard)
  @Post('observe')
  observe(@Body() body: ObserveRequest) {
    return this.orchestrator.observe(body);
  }

  /** Compliance-audit trail backing the Observation Feed / Agent Activity Timeline. */
  @UseGuards(ServiceTokenGuard)
  @Get('observations')
  observations(@Query('userId') userId: string, @Query('limit') limit?: string) {
    return this.compliance.feed(userId, limit ? Number(limit) : 50);
  }

  /** Real Neural Brain explanation for a module/observation — never buy/sell language. */
  @UseGuards(ServiceTokenGuard)
  @Post('explain')
  explain(@Body() body: { question: string; context?: string }) {
    return this.explainSvc.explain(body.question, body?.context);
  }

  /** Knowledge Center — query surface over everything the Brain has learned. */
  @UseGuards(ServiceTokenGuard)
  @Post('brain/search')
  brainSearch(@Body() body: { query: string; userId?: string | null; namespace?: string; limit?: number }) {
    return this.knowledgeCenter.search(body.query, { userId: body.userId, namespace: body.namespace, limit: body.limit });
  }

  @UseGuards(ServiceTokenGuard)
  @Get('brain/stats')
  brainStats() {
    return this.knowledgeCenter.stats();
  }
}
