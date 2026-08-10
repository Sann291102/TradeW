import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  /** Liveness probe. Public — deployment tooling calls this without credentials. */
  @Get()
  health() {
    return { ok: true, service: 'tradew-backend', timestamp: new Date().toISOString() };
  }
}
