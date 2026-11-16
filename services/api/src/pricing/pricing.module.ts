import { Module } from '@nestjs/common';
import { PricingController } from './pricing.controller';
import { BillingModule } from '../billing/billing.module';

/**
 * Imports BillingModule only to reach `StripeGateway`, the single owner of
 * "is billing configured on this server", so `/pricing` and
 * `/payments/catalog` can never disagree about it.
 */
@Module({ imports: [BillingModule], controllers: [PricingController] })
export class PricingModule {}
