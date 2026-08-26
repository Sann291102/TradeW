import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { AutoTradeService } from './autotrade.service';

interface AuthedRequest {
  user?: { sub?: string };
}

class SetAutoTradeDto {
  @ApiProperty({
    description:
      'True asks Sentinel to trade this account automatically; false stops it. ' +
      'Enabling is refused unless the server’s own eligibility decision passes — ' +
      'an administrator must have armed the profile first.',
  })
  @IsBoolean()
  enabled!: boolean;
}

/**
 * Sentinel AutoTrade — the account holder's own surface.
 *
 * ## Why this is not on `SentinelController`
 *
 * That controller is `@RequiresCapability('sentinel')` at the class level, so
 * every route on it 403s for a user without the entitlement. That is right for
 * observations and wrong for `GET /autotrade/status`: a client needs to be able
 * to ask "may I use this?" and receive an ANSWER, including "no, and here is
 * which condition failed". A 403 with no body is not an answer a UI can render,
 * and it would force the frontend to infer eligibility from an error code —
 * exactly the frontend-side entitlement reasoning §3 forbids.
 *
 * So the read is authenticated-only and returns the decision as data. The
 * WRITE is where the entitlement is enforced, inside `setEnabled`, using the
 * same decision function — see AutoTradeService.
 *
 * ## Nothing here can arm anything
 *
 * There is no route on this controller that writes `ExecutionProfile.state`.
 * Arming is administrative, lives on `AdminController` behind
 * `AdminAccessGuard`, and a user calling every endpoint here in every order
 * cannot reach it.
 */
@ApiTags('Sentinel AutoTrade')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard)
@Controller('autotrade')
export class AutoTradeController {
  constructor(private readonly autoTrade: AutoTradeService) {}

  /**
   * Whether AutoTrade is available to this account, and what it has been doing.
   *
   * Returns `visible: false` for an account that should not be shown the
   * capability at all — no Sentinel entitlement, or no administrator-armed
   * profile. The client renders nothing in that case; it does not need to know
   * why, and the `checks` array says why anyway for a support conversation.
   */
  @ApiResponse({
    status: 200,
    description:
      'The eligibility decision, the profile’s live state, today’s activity and the paper-qualification standing. ' +
      'Never contains a credential of any kind.',
  })
  @Get('status')
  status(@Req() req: AuthedRequest) {
    return this.autoTrade.status(req.user!.sub!);
  }

  /**
   * Turn AutoTrade on or off.
   *
   * 403 with `failedCheckId` and the full `checks` array when enabling is not
   * permitted — including the case §14 names specifically: a Premium user whose
   * profile no administrator has armed.
   */
  @ApiResponse({ status: 403, description: 'Not eligible. The body names the check that failed.' })
  @Post('enabled')
  setEnabled(@Req() req: AuthedRequest, @Body() body: SetAutoTradeDto) {
    return this.autoTrade.setEnabled(req.user!.sub!, body.enabled);
  }

  /**
   * The paper record and its qualification standing, on its own.
   *
   * The same numbers `status` embeds. Split out because the panel polls the
   * status frequently and a client showing the qualification detail view does
   * not need to re-read everything.
   */
  @Get('performance')
  async performance(@Req() req: AuthedRequest) {
    const status = await this.autoTrade.status(req.user!.sub!);
    return {
      eligible: status.eligible,
      environment: status.environment,
      state: status.state,
      today: status.today,
      performance: status.performance,
      qualification: status.qualification,
    };
  }
}
