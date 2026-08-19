import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Liveness plus the two numbers an operator actually asks for.
 *
 * Reports ingestion health as counts of failing jobs and recent fetch faults
 * rather than a green tick: a dispatcher that is running perfectly while every
 * job it claims fails is not healthy, and a health check that cannot say so is
 * decoration. Same lesson as the Sentinel citation-corpus finding in the
 * production-readiness audit, where every check was green and the feature was a
 * silent no-op.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health() {
    const since = new Date(Date.now() - 60 * 60_000);
    const [failingJobs, recentFailedFetches, jobs] = await Promise.all([
      this.prisma.ingestionJob.count({ where: { state: 'failed' } }),
      this.prisma.sourceRecord.count({ where: { status: 'failed', retrievedAt: { gte: since } } }),
      this.prisma.ingestionJob.count(),
    ]);

    return {
      status: 'ok',
      service: 'company-data',
      ingestionEnabled: process.env.COMPANY_DATA_INGESTION_ENABLED === 'true',
      jobs,
      failingJobs,
      failedFetchesLastHour: recentFailedFetches,
    };
  }
}
