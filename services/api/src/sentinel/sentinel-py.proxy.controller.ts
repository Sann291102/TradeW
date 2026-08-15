import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CapabilityGuard, RequiresCapability } from '../entitlements/capability.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { SentinelPyService } from './sentinel-py.service';

type AuthedRequest = { user: { sub: string } };

/**
 * User-facing routes for the Python Sentinel (services/sentinel-py):
 * a user's own strategies, the watches they put on instruments, and the
 * position they declare when they take one.
 *
 * Guarded like the rest of Sentinel — `AuthGuard` for identity,
 * `CapabilityGuard`/`sentinel` so entitlement is decided in the same place
 * for both Sentinel services rather than diverging per implementation.
 *
 * Every handler passes `req.user.sub` and nothing else as the user identity;
 * see the note in `SentinelPyService` for why that is load-bearing.
 */
@ApiTags('sentinel-py')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard, CapabilityGuard)
@RequiresCapability('sentinel')
@Controller('sentinel-py')
export class SentinelPyProxyController {
  constructor(private readonly sentinelPy: SentinelPyService) {}

  /**
   * Preview: free text in, structured rules out, nothing saved. The
   * confirmation step in the plan — the user sees what was understood and
   * accepts or edits it before `POST /strategies` persists anything.
   */
  @Post('strategies/parse')
  parse(@Body() body: { text?: string }) {
    return this.sentinelPy.parseStrategy(String(body?.text ?? ''));
  }

  @Post('strategies')
  createStrategy(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.sentinelPy.createStrategy(req.user.sub, body);
  }

  @Get('strategies')
  listStrategies(@Req() req: AuthedRequest) {
    return this.sentinelPy.listStrategies(req.user.sub);
  }

  @Get('strategies/:id')
  getStrategy(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.sentinelPy.getStrategy(req.user.sub, id);
  }

  @Patch('strategies/:id')
  updateStrategy(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.sentinelPy.updateStrategy(req.user.sub, id, body);
  }

  @Get('strategies/:id/performance')
  strategyPerformance(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.sentinelPy.strategyPerformance(req.user.sub, id);
  }

  /** Soft delete — archives rather than destroys. */
  @Delete('strategies/:id')
  archiveStrategy(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.sentinelPy.archiveStrategy(req.user.sub, id);
  }

  /** Apply a strategy to an instrument: symbol plus, for an option, the
   * strike/type/expiry the user picked. */
  @Post('watch')
  createWatch(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.sentinelPy.createWatch(req.user.sub, body);
  }

  @Get('watch')
  listWatches(@Req() req: AuthedRequest) {
    return this.sentinelPy.listWatches(req.user.sub);
  }

  @Get('watch/:id/timeline')
  timeline(@Req() req: AuthedRequest, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.sentinelPy.timeline(req.user.sub, id, limit ? Number(limit) : 100);
  }

  /** "I have taken this position" — the user's own entry, invalidation level
   * and direction. Sentinel proposes none of them. */
  @Post('watch/:id/position')
  openPosition(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.sentinelPy.openPosition(req.user.sub, id, body);
  }

  @Delete('watch/:id/position')
  closePosition(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.sentinelPy.closePosition(req.user.sub, id);
  }
}
