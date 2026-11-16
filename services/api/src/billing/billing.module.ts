import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { VerifiedEmailGuard } from '../auth/verified-email.guard';
import { StripeGateway } from './stripe.gateway';
import { StripeCustomerService } from './stripe-customer.service';
import { StripePriceService } from './stripe-price.service';
import { CustomerService } from './customer.service';
import { PaymentMethodsService } from './payment-methods.service';
import { CheckoutService } from './checkout.service';
import { BillingFulfilmentService } from './billing-fulfilment.service';
import { StripeWebhookService } from './stripe-webhook.service';
import { CheckoutController, CustomerController, PaymentsController, StripeWebhookController } from './billing.controllers';

/**
 * Stripe billing: customer profile, saved cards, checkout, tax and webhooks.
 * Replaces the Razorpay payments module (2026-11-16). PrismaModule, MailModule
 * and EntitlementsModule are global; NotificationModule is imported.
 *
 * `StripeCustomerService` is exported for AuthModule (customer provisioning
 * at signup) and `StripeGateway` for PricingModule (is billing enabled).
 */
@Module({
  imports: [NotificationModule],
  controllers: [CustomerController, PaymentsController, CheckoutController, StripeWebhookController],
  providers: [
    StripeGateway,
    StripeCustomerService,
    StripePriceService,
    CustomerService,
    PaymentMethodsService,
    CheckoutService,
    BillingFulfilmentService,
    StripeWebhookService,
    VerifiedEmailGuard,
  ],
  exports: [StripeGateway, StripeCustomerService, StripePriceService],
})
export class BillingModule {}
