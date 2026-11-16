import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiProperty, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { VerifiedEmailGuard } from '../auth/verified-email.guard';
import { AUTH_LIMIT } from '../common/throttling';
import { SECURITY } from '../swagger/swagger.setup';
import { BILLING_ITEMS } from './billing.catalog';
import { CheckoutService } from './checkout.service';
import { CustomerService } from './customer.service';
import { PaymentMethodsService } from './payment-methods.service';
import { StripeWebhookService } from './stripe-webhook.service';

type AuthedRequest = { user: { sub: string } };
const ITEM_IDS = BILLING_ITEMS.map((i) => i.id);

// ---------------------------------------------------------------- DTOs

class AddressDto {
  @ApiProperty({ example: 'Asha Rao' }) @IsString() @MaxLength(120) name!: string;
  @ApiProperty({ required: false, example: '+14155550100' }) @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiProperty({ example: '1 Market St' }) @IsString() @MaxLength(200) line1!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200) line2?: string;
  @ApiProperty({ example: 'San Francisco' }) @IsString() @MaxLength(100) city!: string;
  @ApiProperty({ required: false, example: 'CA' }) @IsOptional() @IsString() @MaxLength(100) state?: string;
  @ApiProperty({ example: '94105' }) @IsString() @MaxLength(12) postalCode!: string;
  @ApiProperty({ example: 'US', description: 'ISO 3166-1 alpha-2' }) @IsString() @Length(2, 2) country!: string;
}

class ProfileDto {
  @ApiProperty({ example: 'Asha' }) @IsString() @MaxLength(60) firstName!: string;
  @ApiProperty({ example: 'Rao' }) @IsString() @MaxLength(60) lastName!: string;
}

class ItemDto {
  @ApiProperty({ enum: ITEM_IDS }) @IsString() @IsIn(ITEM_IDS) itemId!: string;
}

class CreateCheckoutDto extends ItemDto {
  @ApiProperty({ required: false, description: 'One-time items: save the card for later (explicit consent).' })
  @IsOptional()
  @IsBoolean()
  savePaymentMethod?: boolean;

  @ApiProperty({ required: false, description: 'Pay with one of your saved cards.' })
  @IsOptional()
  @IsString()
  @Matches(/^pm_[A-Za-z0-9]+$/)
  paymentMethodId?: string;

  @ApiProperty({ description: 'A UUID the client generates once per checkout attempt. Re-sending it returns the same order.' })
  @IsUUID()
  idempotencyKey!: string;
}

class OrderIdDto {
  @ApiProperty() @IsUUID() orderId!: string;
}

// ---------------------------------------------------------------- /customer

/** Billing profile and addresses. Verified email required. */
@ApiTags('Customer')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard, VerifiedEmailGuard)
@Controller('customer')
export class CustomerController {
  constructor(private readonly customer: CustomerService) {}

  @Get('profile')
  profile(@Req() req: AuthedRequest) {
    return this.customer.profile(req.user.sub);
  }

  @Throttle(AUTH_LIMIT)
  @Put('profile')
  updateProfile(@Req() req: AuthedRequest, @Body() dto: ProfileDto) {
    return this.customer.updateProfile(req.user.sub, dto);
  }

  @Get('billing-address')
  billing(@Req() req: AuthedRequest) {
    return this.customer.getAddress(req.user.sub, 'billing');
  }

  @Throttle(AUTH_LIMIT)
  @Put('billing-address')
  putBilling(@Req() req: AuthedRequest, @Body() dto: AddressDto) {
    return this.customer.putAddress(req.user.sub, 'billing', dto);
  }

  @Get('shipping-address')
  shipping(@Req() req: AuthedRequest) {
    return this.customer.getAddress(req.user.sub, 'shipping');
  }

  @Throttle(AUTH_LIMIT)
  @Put('shipping-address')
  putShipping(@Req() req: AuthedRequest, @Body() dto: AddressDto) {
    return this.customer.putAddress(req.user.sub, 'shipping', dto);
  }

  @Throttle(AUTH_LIMIT)
  @Delete('shipping-address')
  deleteShipping(@Req() req: AuthedRequest) {
    return this.customer.deleteShipping(req.user.sub);
  }
}

// ---------------------------------------------------------------- /payments

/**
 * Catalog (public) and saved cards (verified users only). The catalog exposes
 * prices, the mode and the publishable key; never per-user state.
 */
@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly methods: PaymentMethodsService,
  ) {}

  @Get('catalog')
  catalog() {
    return this.checkout.catalog();
  }

  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Get('trial')
  trial(@Req() req: AuthedRequest) {
    return this.checkout.trialStatus(req.user.sub);
  }

  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard, VerifiedEmailGuard)
  @Get('methods')
  list(@Req() req: AuthedRequest) {
    return this.methods.list(req.user.sub);
  }

  /** Begin adding a card: returns a SetupIntent client secret for the Payment Element. */
  @Throttle(AUTH_LIMIT)
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard, VerifiedEmailGuard)
  @Post('setup-intent')
  setupIntent(@Req() req: AuthedRequest) {
    return this.methods.createSetupIntent(req.user.sub);
  }

  @Throttle(AUTH_LIMIT)
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard, VerifiedEmailGuard)
  @Delete('methods/:id')
  remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.methods.remove(req.user.sub, id);
  }

  @Throttle(AUTH_LIMIT)
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard, VerifiedEmailGuard)
  @Put('methods/:id/default')
  setDefault(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.methods.setDefault(req.user.sub, id);
  }
}

// ---------------------------------------------------------------- /checkout

@ApiTags('Checkout')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard, VerifiedEmailGuard)
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  /** Price, tax and total for one item, calculated from the billing address. */
  @Throttle(AUTH_LIMIT)
  @Post('quote')
  quote(@Req() req: AuthedRequest, @Body() dto: ItemDto) {
    return this.checkout.quote(req.user.sub, dto.itemId);
  }

  /** Create the order and its PaymentIntent (or subscription). Returns a client secret. */
  @Throttle(AUTH_LIMIT)
  @Post('create')
  create(@Req() req: AuthedRequest, @Body() dto: CreateCheckoutDto) {
    return this.checkout.create(req.user.sub, dto);
  }

  /** Refresh and return an order's status after Stripe.js confirms. Never marks it paid. */
  @Post('confirm')
  @HttpCode(200)
  confirm(@Req() req: AuthedRequest, @Body() dto: OrderIdDto) {
    return this.checkout.confirm(req.user.sub, dto.orderId);
  }

  @Get('orders')
  orders(@Req() req: AuthedRequest) {
    return this.checkout.listOrders(req.user.sub);
  }

  @Get('orders/:orderId')
  order(@Req() req: AuthedRequest, @Param('orderId') orderId: string) {
    return this.checkout.getOrder(req.user.sub, orderId);
  }

  @Get('subscriptions')
  subscriptions(@Req() req: AuthedRequest) {
    return this.checkout.listSubscriptions(req.user.sub);
  }

  @Throttle(AUTH_LIMIT)
  @Post('subscriptions/:id/cancel')
  @HttpCode(200)
  cancel(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.checkout.setCancelAtPeriodEnd(req.user.sub, id, true);
  }

  @Throttle(AUTH_LIMIT)
  @Post('subscriptions/:id/resume')
  @HttpCode(200)
  resume(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.checkout.setCancelAtPeriodEnd(req.user.sub, id, false);
  }
}

// ---------------------------------------------------------------- /stripe/webhook

/**
 * Stripe → TradeW events. Unguarded by JWT and exempt from the per-IP
 * throttle (Stripe delivers from a small set of IPs in bursts); authenticated
 * solely by the signature over the raw body.
 */
@Controller('stripe')
export class StripeWebhookController {
  constructor(private readonly webhooks: StripeWebhookService) {}

  @ApiExcludeEndpoint()
  @SkipThrottle()
  @Post('webhook')
  @HttpCode(200)
  webhook(@Req() req: { rawBody?: Buffer; headers: Record<string, string | undefined> }) {
    return this.webhooks.handle(req.rawBody, req.headers['stripe-signature']);
  }
}
