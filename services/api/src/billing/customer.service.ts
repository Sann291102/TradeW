import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AddressKind, CustomerAddress } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../mail/email.service';
import { StripeCustomerService } from './stripe-customer.service';
import { StripeGateway } from './stripe.gateway';
import { AddressValidationError, normalizeAddress, summarizeAddress, type AddressInput } from './address-validation';
import { billingAudit } from './billing-audit';

export interface AddressView {
  kind: AddressKind;
  name: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
  updatedAt: string;
  stripeSync: { status: 'synced' | 'pending' | 'not_configured'; syncedAt: string | null; message: string | null };
}

/** Hook the checkout service registers so address changes re-price open orders. */
export type AddressChangedListener = (userId: string) => Promise<void>;

/**
 * Billing profile: names and the billing/shipping addresses.
 *
 * Every write is validate → save in our database → sync to the Stripe
 * Customer. If Stripe is unreachable the address is still saved (it is the
 * customer's data and they typed it), the row is marked as not yet synced,
 * the response says so, and the retry sweep finishes the job. Nothing about a
 * mismatch is silent.
 */
@Injectable()
export class CustomerService {
  private listeners: AddressChangedListener[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: StripeCustomerService,
    private readonly gateway: StripeGateway,
    private readonly email: EmailService,
  ) {}

  onBillingAddressChanged(listener: AddressChangedListener) {
    this.listeners.push(listener);
  }

  private view(a: CustomerAddress): AddressView {
    const status = !this.gateway.enabled ? 'not_configured' : a.stripeSyncError ? 'pending' : a.stripeSyncedAt ? 'synced' : 'pending';
    return {
      kind: a.kind,
      name: a.name,
      phone: a.phone,
      line1: a.line1,
      line2: a.line2,
      city: a.city,
      state: a.state,
      postalCode: a.postalCode,
      country: a.country,
      updatedAt: a.updatedAt.toISOString(),
      stripeSync: { status, syncedAt: a.stripeSyncedAt?.toISOString() ?? null, message: a.stripeSyncError },
    };
  }

  async profile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        emailVerifiedAt: true,
        stripeCustomerId: true,
        stripeCustomerError: true,
        addresses: true,
      },
    });
    if (!user) throw new NotFoundException('Account not found.');
    const billing = user.addresses.find((a) => a.kind === 'billing');
    const shipping = user.addresses.find((a) => a.kind === 'shipping');
    return {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      emailVerified: Boolean(user.emailVerifiedAt),
      billingEnabled: this.gateway.enabled,
      // Whether a Stripe Customer exists, never its id: the browser has no use
      // for it and every Stripe call goes through this server anyway.
      paymentProfile: user.stripeCustomerId ? 'ready' : user.stripeCustomerError ? 'retrying' : 'not_created',
      billingAddress: billing ? this.view(billing) : null,
      shippingAddress: shipping ? this.view(shipping) : null,
    };
  }

  async updateProfile(userId: string, data: { firstName?: string; lastName?: string }) {
    const firstName = data.firstName?.trim();
    const lastName = data.lastName?.trim();
    if (!firstName || !lastName) throw new BadRequestException('First and last name are required.');
    const before = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, firstName: true, lastName: true } });
    if (!before) throw new NotFoundException('Account not found.');
    await this.prisma.user.update({ where: { id: userId }, data: { firstName, lastName } });
    const changed = [firstName !== before.firstName ? 'first name' : '', lastName !== before.lastName ? 'last name' : ''].filter(Boolean);
    if (changed.length) {
      this.email.dispatch('account_info_updated', before.email, { Email: before.email, When: nowLabel(), ChangedFields: changed.join(', ') }, { userId });
      if (this.gateway.enabled) await this.customers.syncCustomer(userId).catch(() => false);
    }
    return this.profile(userId);
  }

  async getAddress(userId: string, kind: AddressKind): Promise<AddressView | null> {
    const row = await this.prisma.customerAddress.findUnique({ where: { userId_kind: { userId, kind } } });
    return row ? this.view(row) : null;
  }

  async putAddress(userId: string, kind: AddressKind, input: AddressInput): Promise<AddressView> {
    let address;
    try {
      address = normalizeAddress(input);
    } catch (err) {
      if (err instanceof AddressValidationError) {
        throw new BadRequestException({ statusCode: 400, code: 'address_invalid', message: err.message, fields: err.fields });
      }
      throw err;
    }

    await this.prisma.customerAddress.upsert({
      where: { userId_kind: { userId, kind } },
      create: { userId, kind, ...address, stripeSyncError: this.gateway.enabled ? 'Saving to the payment provider…' : null },
      update: { ...address, stripeSyncedAt: null, stripeSyncError: this.gateway.enabled ? 'Saving to the payment provider…' : null },
    });
    await billingAudit(this.prisma, `address.${kind}.updated`, userId, { country: address.country });

    // Sync to Stripe now; on failure the row keeps a visible pending message
    // and the sweep retries.
    if (this.gateway.enabled) await this.customers.syncCustomer(userId).catch(() => false);

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    this.email.dispatch(
      'billing_address_updated',
      user?.email,
      {
        AddressKind: kind,
        AddressKindTitle: kind === 'billing' ? 'Billing' : 'Shipping',
        When: nowLabel(),
        AddressSummary: summarizeAddress(address),
      },
      { userId },
    );

    if (kind === 'billing') {
      for (const listener of this.listeners) await listener(userId).catch(() => undefined);
    }
    const row = await this.prisma.customerAddress.findUniqueOrThrow({ where: { userId_kind: { userId, kind } } });
    return this.view(row);
  }

  async deleteShipping(userId: string): Promise<{ ok: true }> {
    await this.prisma.customerAddress.deleteMany({ where: { userId, kind: 'shipping' } });
    if (this.gateway.enabled) await this.customers.syncCustomer(userId).catch(() => false);
    return { ok: true };
  }
}

export function nowLabel(): string {
  return new Date().toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';
}
