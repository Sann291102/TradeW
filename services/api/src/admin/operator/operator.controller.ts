import { Body, Controller, Get, HttpCode, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiProperty, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AdminTokenGuard } from '../../auth/admin-token.guard';
import { SECURITY } from '../../swagger/swagger.setup';
import { OperatorService } from './operator.service';

/**
 * Request bodies, declared ABOVE the controller.
 *
 * Not stylistic: `emitDecoratorMetadata` resolves a handler's parameter types
 * when the controller class is *defined*, so a DTO declared below is still in
 * its temporal dead zone and the module throws `ReferenceError: Cannot access
 * 'X' before initialization` at import time. `tsc` does not flag it and no unit
 * test catches it — the API simply fails to boot. See
 * `knowledge/Gotchas/2026-08-12 - Nest DTOs must be declared above the
 * controller.md`.
 */
class OperatorLoginDto {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12)
  password!: string;
}

/**
 * Operator sign-in for the standalone console.
 *
 * Gated by `AdminTokenGuard` rather than `AdminAccessGuard`, and that is not an
 * oversight: this is the endpoint that MINTS the second factor, so it cannot
 * require the second factor. It still requires the first — reaching this route
 * at all means already holding `ADMIN_API_TOKEN`, so the login form is not
 * exposed to the internet in the way a product login is.
 *
 * The response carries the assertion in a JSON body because its only consumer
 * is `apps/admin`'s Route Handler, running server-side, which stores it in an
 * httpOnly cookie the browser cannot read. It is never rendered into a page and
 * never handed to client-side JavaScript.
 */
@ApiTags('Admin')
@ApiSecurity({ [SECURITY.adminToken]: [] })
@Controller('admin/operator')
@UseGuards(AdminTokenGuard)
export class OperatorController {
  constructor(private readonly operators: OperatorService) {}

  /**
   * Is the operator path configured at all? Lets the console render "operator
   * login is disabled on this deployment" instead of an unexplained 401 loop.
   * Deliberately says nothing about whether any account exists.
   */
  @Get('status')
  status(): { enabled: boolean } {
    return { enabled: this.operators.enabled() };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: OperatorLoginDto, @Req() req: { ip?: string }) {
    const outcome = await this.operators.login(body.email, body.password, req.ip ?? null);

    // Every denial collapses to one message. The service distinguishes unknown
    // account from wrong password from locked out from disabled, and all four
    // are written to the security log — but telling the *client* which one it
    // was is free account enumeration and free lockout confirmation for anyone
    // who has the operator token and is working through a list of emails.
    if (!outcome.ok) throw new UnauthorizedException('Invalid operator credentials');

    return {
      assertion: outcome.result.assertion,
      expiresAtMs: outcome.result.expiresAtMs,
      operator: outcome.result.operator,
    };
  }

  /**
   * Who does this assertion belong to, and is it still good? The console calls
   * it to render the signed-in operator, and it doubles as the revocation probe
   * — a disabled account fails here on the next page load rather than at
   * assertion expiry.
   */
  @Post('verify')
  @HttpCode(200)
  async verify(@Body() body: { assertion?: string }) {
    const assertion = typeof body?.assertion === 'string' ? body.assertion : '';
    const verdict = await this.operators.verifyAssertion(assertion);
    if (!verdict.ok) throw new UnauthorizedException('Invalid operator assertion');
    return { operator: verdict.operator };
  }
}
