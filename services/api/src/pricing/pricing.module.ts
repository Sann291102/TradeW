import { Module } from '@nestjs/common';
import { PricingController } from './pricing.controller';
import { PaymentModule } from '../payments/payment.module';

/**
 * Imports PaymentModule only to reach `RazorpayClient`, which is the single
 * owner of whether billing is configured — see the controller for why this
 * route may not decide that for itself. No cycle: PaymentModule imports
 * NotificationModule and knows nothing about pricing.
 */
@Module({ imports: [PaymentModule], controllers: [PricingController] })
export class PricingModule {}
