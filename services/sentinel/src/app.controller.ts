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
import { ComplianceService } from './compliance/compliance.service';
import { ObserveRequest } from './domain';
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
}
