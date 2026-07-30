import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AdminTokenGuard } from '../auth/admin-token.guard';
import { EntitlementsService } from './entitlements.service';

/**
 * `AdminTokenGuard` was declared inline here. It moved to
 * `../auth/admin-token.guard` so the broker module gates its operator routes
 * with the SAME check instead of a second admin concept, and it gained a
 * constant-time comparison plus denial logging in the move.
 *
 * Re-exported so existing `from './entitlements.controller'` imports keep
 * resolving — this is a refactor, not an API change.
 */
export { AdminTokenGuard };

@Controller('entitlements')
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  // ------------------------------------------------------------ user-facing

  @UseGuards(AuthGuard)
  @Get('me')
  async myCapabilities(@Req() req: { user: { sub: string } }) {
    return { capabilities: await this.entitlements.capabilitiesOf(req.user.sub) };
  }

  @UseGuards(AuthGuard)
  @Get('me/check/:capability')
  async myCheck(@Req() req: { user: { sub: string } }, @Param('capability') capability: string) {
    return this.entitlements.check(req.user.sub, capability);
  }

  @Get('plans')
  async plans() {
    return this.entitlements.listPlans();
  }

  // -------------------------------------------------------------- admin/ops
  // Billing providers will later drive subscription state through the same
  // service methods these endpoints call — never by writing tables directly.

  @UseGuards(AdminTokenGuard)
  @Post('admin/subscriptions')
  async activate(
    @Body()
    body: {
      userId: string;
      planCode: string;
      trial?: boolean;
      expiresAt?: string | null;
    },
  ) {
    return this.entitlements.activate(body.userId, body.planCode, {
      trial: body.trial,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
  }

  @UseGuards(AdminTokenGuard)
  @Post('admin/subscriptions/:id/cancel')
  async cancel(@Param('id') id: string, @Body() body: { atPeriodEnd?: boolean }) {
    return this.entitlements.cancel(id, body?.atPeriodEnd ?? true);
  }

  @UseGuards(AdminTokenGuard)
  @Post('admin/overrides')
  async override(
    @Body()
    body: {
      userId: string;
      capability: string;
      granted: boolean;
      reason: string;
      grantedBy?: string;
      expiresAt?: string | null;
    },
  ) {
    return this.entitlements.createOverride({
      userId: body.userId,
      capability: body.capability,
      granted: body.granted,
      reason: body.reason,
      grantedBy: body.grantedBy ?? 'admin-api',
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
  }

  @UseGuards(AdminTokenGuard)
  @Get('admin/users/:userId/capabilities')
  async userCapabilities(@Param('userId') userId: string) {
    return { capabilities: await this.entitlements.capabilitiesOf(userId) };
  }
}
