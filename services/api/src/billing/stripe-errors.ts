import {
  BadRequestException,
  HttpException,
  Logger,
  ServiceUnavailableException,
  BadGatewayException,
} from '@nestjs/common';
import Stripe = require('stripe');

const logger = new Logger('StripeErrors');

/** A short, log-safe description of a Stripe error (type, code, request id). Never card data. */
export function describeStripeError(err: unknown): string {
  if (err instanceof Stripe.errors.StripeError) {
    return [err.type, err.code, err.decline_code, err.requestId, err.message].filter(Boolean).join(' | ').slice(0, 400);
  }
  return err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400);
}

/**
 * Turn a Stripe SDK error into a response that is safe to show a customer.
 *
 * Card errors carry a message Stripe writes for end users ("Your card was
 * declined."), so it is passed through with its decline code. Everything else
 * (invalid requests, auth problems, rate limits, outages) is logged in full
 * here and answered with a generic sentence: those messages can name internal
 * ids or configuration that a customer has no use for.
 */
export function toClientError(err: unknown, context: string): HttpException {
  if (err instanceof HttpException) return err;
  logger.error(`${context}: ${describeStripeError(err)}`);

  if (err instanceof Stripe.errors.StripeCardError) {
    return new BadRequestException({
      statusCode: 400,
      code: 'card_error',
      declineCode: err.decline_code ?? undefined,
      message: err.message || 'Your card was declined.',
    });
  }
  if (err instanceof Stripe.errors.StripeInvalidRequestError) {
    if (err.code === 'customer_tax_location_invalid') {
      return new BadRequestException({
        statusCode: 400,
        code: 'tax_location_invalid',
        message: 'We could not work out sales tax for your billing address. Check the address and try again.',
      });
    }
    if (/head office address|tax settings|Stripe Tax/i.test(err.message ?? '')) {
      // Account configuration, not the customer's fault: Stripe Tax needs the
      // business's head office address (Dashboard → Settings → Tax) before it
      // will calculate anything. Nothing can be charged until it is set.
      return new ServiceUnavailableException({
        statusCode: 503,
        code: 'tax_not_configured',
        message: 'Checkout is temporarily unavailable while sales tax is being set up. Nothing was charged.',
      });
    }
    if (err.code === 'resource_missing') {
      return new BadRequestException({ statusCode: 400, code: 'not_found', message: 'That payment item no longer exists.' });
    }
    return new BadRequestException({ statusCode: 400, code: 'payment_request_invalid', message: 'This payment could not be set up. Please try again.' });
  }
  if (
    err instanceof Stripe.errors.StripeRateLimitError ||
    err instanceof Stripe.errors.StripeConnectionError ||
    err instanceof Stripe.errors.StripeAPIError
  ) {
    return new ServiceUnavailableException({
      statusCode: 503,
      code: 'payment_provider_unavailable',
      message: 'The payment provider is not responding. Nothing was charged. Please try again in a moment.',
    });
  }
  return new BadGatewayException({ statusCode: 502, code: 'payment_error', message: 'The payment could not be processed. Nothing was charged.' });
}
