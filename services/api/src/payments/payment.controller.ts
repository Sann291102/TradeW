import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { AUTH_LIMIT } from '../common/throttling';
import { SECURITY } from '../swagger/swagger.setup';
import { PaymentService } from './payment.service';

class CheckoutDto {
  @ApiProperty({ description: 'Catalog item id, e.g. sentinel_3m.' })
  @IsString()
  itemId!: string;
}

class VerifyDto {
  @ApiProperty()
  @IsString()
  itemId!: string;

  @ApiProperty()
  @IsString()
  razorpayOrderId!: string;

  @ApiProperty()
  @IsString()
  razorpayPaymentId!: string;

  @ApiProperty()
  @IsString()
  razorpaySignature!: string;
}

type AuthedRequest = { user: { sub: string } };

/**
 * Payments. `/catalog` is public (it exposes only prices and the publishable
 * key); everything that touches an account is behind `AuthGuard`; the webhook
 * is public but authenticated by its Razorpay signature, verified over the raw
 * body (`main.ts` boots with `rawBody: true`).
 */
@ApiTags('Payments')
@Controller('payments')
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  /** Purchasable items + whether billing is actually enabled on this server. */
  @Get('catalog')
  catalog() {
    return this.payments.catalog();
  }

  /** Start a checkout — creates a Razorpay order for the widget to collect against. */
  @Throttle(AUTH_LIMIT)
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Post('checkout')
  checkout(@Req() req: AuthedRequest, @Body() dto: CheckoutDto) {
    return this.payments.createCheckout(req.user.sub, dto.itemId);
  }

  /** Verify the widget callback and activate the plan. Trusts the signature, not the browser. */
  @Throttle(AUTH_LIMIT)
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Post('verify')
  verify(@Req() req: AuthedRequest, @Body() dto: VerifyDto) {
    return this.payments.verifyCheckout(req.user.sub, {
      itemId: dto.itemId,
      razorpayOrderId: dto.razorpayOrderId,
      razorpayPaymentId: dto.razorpayPaymentId,
      razorpaySignature: dto.razorpaySignature,
    });
  }

  /**
   * Razorpay webhook — the authoritative fulfilment path. Excluded from Swagger
   * (there is nothing a human should "Try it out" here) and unguarded by JWT:
   * its authenticity is the HMAC signature over the raw body, nothing else.
   */
  @ApiExcludeEndpoint()
  @Post('webhook')
  webhook(@Req() req: { rawBody?: Buffer; headers: Record<string, string | undefined> }) {
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    return this.payments.handleWebhook(raw, req.headers['x-razorpay-signature']);
  }
}
