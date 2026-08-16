import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { RazorpayClient } from './razorpay.client';
import { NotificationModule } from '../notification/notification.module';

/**
 * Payments. PrismaModule, MailModule and EntitlementsModule are all @Global, so
 * only NotificationModule (which exports NotificationService but is not global)
 * needs importing here. AuthGuard is used by the controller and resolves from
 * the global Jwt setup, matching every other guarded controller.
 */
@Module({
  imports: [NotificationModule],
  controllers: [PaymentController],
  providers: [PaymentService, RazorpayClient],
  // RazorpayClient is exported so PricingModule can ask it the one question
  // `GET /pricing` must not answer on its own — whether billing is configured.
  exports: [PaymentService, RazorpayClient],
})
export class PaymentModule {}
