import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiBody, ApiProperty, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { AdminTokenGuard } from '../auth/admin-token.guard';
import { EXPENSIVE_LIMIT } from '../common/throttling';
import { SECURITY } from '../swagger/swagger.setup';
import { EntitlementsService } from './entitlements.service';

/**
 * DOCUMENTATION MODELS ONLY — deliberately not the handler parameter types.
 *
 * The operator handlers below type their `@Body()` as an inline object, which
 * makes the emitted design type `Object`, which `ValidationPipe` skips. Swapping
 * those signatures to these classes would change runtime behaviour in two ways
 * at once: bodies that are accepted today would start returning 400, and — since
 * `whitelist: true` is set globally — any property without a `class-validator`
 * decorator would be silently stripped before the handler saw it.
 *
 * So these carry `@ApiProperty` and nothing else, and are attached with
 * `@ApiBody({ type })`. The reference gets a named, complete model; the wire
 * behaviour is byte-for-byte what it was.
 */
class ActivateSubscriptionBody {
  @ApiProperty({ description: 'User receiving the plan.' })
  userId!: string;

  @ApiProperty({ description: 'Plan code as listed by GET /entitlements/plans.', example: 'pro' })
  planCode!: string;

  @ApiProperty({ required: false, description: 'Mark the subscription as a trial.' })
  trial?: boolean;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'ISO 8601. Null or omitted means it does not expire on its own.',
    example: '2026-12-31T00:00:00.000Z',
  })
  expiresAt?: string | null;
}

class RedeemCodeBody {
  @ApiProperty({
    description: 'The access code. Case-insensitive; a leading # is ignored.',
    example: 'HashtagTradeWSetup100',
  })
  code!: string;
}

class CancelSubscriptionBody {
  @ApiProperty({
    required: false,
    default: true,
    description: 'Cancel at period end (default) rather than immediately.',
  })
  atPeriodEnd?: boolean;
}

class CreateOverrideBody {
  @ApiProperty()
  userId!: string;

  @ApiProperty({ description: 'Capability key, e.g. `sentinel`.', example: 'sentinel' })
  capability!: string;

  @ApiProperty({ description: 'True grants the capability, false denies it regardless of plan.' })
  granted!: boolean;

  @ApiProperty({ description: 'Why this override exists. Recorded with the grant.' })
  reason!: string;

  @ApiProperty({ required: false, default: 'admin-api', description: 'Attribution for the audit trail.' })
  grantedBy?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'ISO 8601. Null or omitted means the override does not expire.',
  })
  expiresAt?: string | null;
}

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

@ApiTags('Entitlements')
@Controller('entitlements')
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  // ------------------------------------------------------------ user-facing

  /** Every capability the caller currently holds, plan and overrides combined. */
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Get('me')
  async myCapabilities(@Req() req: { user: { sub: string } }) {
    return { capabilities: await this.entitlements.capabilitiesOf(req.user.sub) };
  }

  /** Decide one capability for the caller, including quota state. */
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Get('me/check/:capability')
  async myCheck(@Req() req: { user: { sub: string } }, @Param('capability') capability: string) {
    return this.entitlements.check(req.user.sub, capability);
  }

  /** The published plan catalogue. Public — the pricing page reads this. */
  @Get('plans')
  async plans() {
    return this.entitlements.listPlans();
  }

  /**
   * Redeem an access code for the plan it names.
   *
   * Authenticated, because a redemption has to attach to an account — this is
   * what makes the unlock real and portable, rather than a flag in one
   * browser's localStorage, which is what it used to be.
   *
   * Throttled: a redemption endpoint is a code-guessing oracle. EXPENSIVE_LIMIT
   * is what the assistant route uses and is the tightest bucket available
   * without inventing a new one.
   *
   * An unknown code returns 400 from the service, deliberately distinct from
   * the 404 raised when a valid code names a plan missing from the database —
   * the first is the user's problem, the second is ours, and collapsing them
   * would send operators hunting for a typo that does not exist.
   */
  @ApiBearerAuth(SECURITY.bearer)
  @ApiBody({ type: RedeemCodeBody })
  @UseGuards(AuthGuard)
  @Throttle(EXPENSIVE_LIMIT)
  @Post('redeem')
  async redeem(@Req() req: { user: { sub: string } }, @Body() body: { code?: string }) {
    return this.entitlements.redeem(req.user.sub, body?.code ?? '');
  }

  // -------------------------------------------------------------- admin/ops
  // Billing providers will later drive subscription state through the same
  // service methods these endpoints call — never by writing tables directly.

  /** Put a user on a plan. Operator-only. */
  @ApiSecurity(SECURITY.adminToken)
  @ApiBody({ type: ActivateSubscriptionBody })
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

  /** Cancel a subscription by id. Operator-only. */
  @ApiSecurity(SECURITY.adminToken)
  @ApiBody({ type: CancelSubscriptionBody, required: false })
  @UseGuards(AdminTokenGuard)
  @Post('admin/subscriptions/:id/cancel')
  async cancel(@Param('id') id: string, @Body() body: { atPeriodEnd?: boolean }) {
    return this.entitlements.cancel(id, body?.atPeriodEnd ?? true);
  }

  /** Grant or deny one capability for one user, independent of their plan. Operator-only. */
  @ApiSecurity(SECURITY.adminToken)
  @ApiBody({ type: CreateOverrideBody })
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

  /** Any user's effective capabilities. Operator-only — the cross-user view. */
  @ApiSecurity(SECURITY.adminToken)
  @UseGuards(AdminTokenGuard)
  @Get('admin/users/:userId/capabilities')
  async userCapabilities(@Param('userId') userId: string) {
    return { capabilities: await this.entitlements.capabilitiesOf(userId) };
  }
}
