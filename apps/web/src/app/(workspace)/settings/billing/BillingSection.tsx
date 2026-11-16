'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, CandleLoader, buttonClasses } from '@tradew/ui';
import { ApiError, api } from '@/lib/api';
import { useSessionStore } from '@/lib/store/sessionStore';
import { SettingsGroup, SettingsSection } from '@/components/settings/SettingsSection';
import { SignInRequired } from '@/components/settings/controls';
import { AddressForm, addressSummary } from '@/components/billing/AddressForm';
import { AddCardForm } from '@/components/billing/AddCardForm';
import { ConfirmDialog } from '@/components/billing/ConfirmDialog';
import { useCatalog } from '@/lib/query/useBilling';
import {
  cancelSubscription,
  cardLabel,
  deleteShippingAddress,
  fetchBillingProfile,
  listCards,
  listOrders,
  listSubscriptions,
  money,
  removeCard,
  resumeSubscription,
  saveAddress,
  setDefaultCard,
  updateBillingProfile,
  type AddressView,
  type BillingProfile,
  type Card,
  type Order,
  type SubscriptionView,
} from '@/lib/payments';

const STATUS_TONE: Record<string, 'positive' | 'negative' | 'warning' | 'neutral' | 'brand'> = {
  paid: 'positive',
  failed: 'negative',
  canceled: 'neutral',
  pending: 'warning',
  processing: 'warning',
  refunded: 'neutral',
  partially_refunded: 'neutral',
};

/**
 * Settings → Billing. The customer's billing profile, addresses, saved cards,
 * subscriptions and order history, all read from services/api (which reads
 * Stripe). Requires a verified email; an unverified account sees why and a
 * resend button instead of an error.
 */
export function BillingSection() {
  const status = useSessionStore((s) => s.status);
  const user = useSessionStore((s) => s.user);
  const catalog = useCatalog().data ?? null;
  const [profile, setProfile] = useState<BillingProfile | null>(null);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [subs, setSubs] = useState<SubscriptionView[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loadError, setLoadError] = useState<{ code: string | null; text: string } | null>(null);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<'billing' | 'shipping' | 'names' | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Card | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<SubscriptionView | null>(null);
  const [busy, setBusy] = useState(false);

  const loadCards = useCallback(async () => {
    setCardsError(null);
    try {
      setCards((await listCards()).cards);
    } catch (e) {
      setCards([]);
      setCardsError(e instanceof Error ? e.message : 'Could not load your cards.');
    }
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const p = await fetchBillingProfile();
      setProfile(p);
      const [s, o] = await Promise.all([listSubscriptions(), listOrders()]);
      setSubs(s.subscriptions);
      setOrders(o.orders);
      if (p.billingEnabled) await loadCards();
      else setCards([]);
    } catch (e) {
      setLoadError({ code: e instanceof ApiError ? e.code : null, text: e instanceof Error ? e.message : 'Could not load billing.' });
    }
  }, [loadCards]);

  useEffect(() => {
    if (status === 'authenticated') void load();
  }, [status, load]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('card') === 'added') setNotice('Card saved.');
  }, []);

  if (status !== 'authenticated') {
    return (
      <SettingsSection title="Billing" description="Billing details, saved cards and receipts.">
        <SignInRequired what="manage billing" />
      </SettingsSection>
    );
  }

  if (loadError?.code === 'EMAIL_NOT_VERIFIED') {
    return (
      <SettingsSection title="Billing" description="Billing details, saved cards and receipts.">
        <VerifyFirst email={user?.email ?? ''} />
      </SettingsSection>
    );
  }

  const busyWrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Billing"
      description="Your billing profile, saved cards, subscriptions and receipts. Card details are held by Stripe, not TradeW."
    >
      {catalog?.mode === 'test' && catalog.billingEnabled && (
        <p className="rounded-lg border border-amber/40 bg-amber-bg px-3 py-2 text-xs text-amber">
          Test mode: no real money moves. Use Stripe test cards such as 4242 4242 4242 4242.
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg border border-up/40 px-3 py-2 text-xs text-up">
          {notice}
        </p>
      )}
      {loadError && (
        <p role="alert" className="rounded-lg border border-down/40 px-3 py-2 text-xs text-down">
          {loadError.text}
        </p>
      )}
      {!profile && !loadError && (
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          <CandleLoader size="sm" decorative /> Loading billing…
        </div>
      )}

      {profile && (
        <>
          <SettingsGroup
            title="Billing profile"
            subtitle={profile.paymentProfile === 'retrying' ? 'Connecting to the payment provider — retrying automatically' : undefined}
            actions={
              editing !== 'names' && (
                <button className={buttonClasses({ size: 'sm', variant: 'ghost' })} onClick={() => setEditing('names')}>
                  Edit
                </button>
              )
            }
          >
            {editing === 'names' ? (
              <NamesForm
                profile={profile}
                onCancel={() => setEditing(null)}
                onSave={async (n) => {
                  setProfile(await updateBillingProfile(n));
                  setEditing(null);
                  setNotice('Name updated.');
                }}
              />
            ) : (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-faint">Name</dt>
                  <dd className="text-text">{[profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'Not set'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-faint">Email</dt>
                  <dd className="text-text">
                    {profile.email} <Badge tone="positive">Verified</Badge>
                  </dd>
                </div>
              </dl>
            )}
          </SettingsGroup>

          <SettingsGroup
            title="Billing address"
            subtitle="Used for receipts and to calculate sales tax."
            actions={
              editing !== 'billing' && (
                <button className={buttonClasses({ size: 'sm', variant: 'ghost' })} onClick={() => setEditing('billing')}>
                  {profile.billingAddress ? 'Edit' : 'Add'}
                </button>
              )
            }
          >
            {editing === 'billing' ? (
              <AddressForm
                kind="billing"
                initial={profile.billingAddress}
                onCancel={() => setEditing(null)}
                onSave={async (a) => {
                  const saved = await saveAddress('billing', a);
                  setProfile({ ...profile, billingAddress: saved });
                  setEditing(null);
                  setNotice(saved.stripeSync.status === 'pending' ? 'Address saved. Sending it to the payment provider…' : 'Billing address saved.');
                }}
              />
            ) : (
              <AddressBlock address={profile.billingAddress} empty="No billing address yet. Add one before checkout." />
            )}
          </SettingsGroup>

          <SettingsGroup
            title="Shipping address"
            subtitle="Optional. TradeW sells digital access only, so nothing is shipped."
            actions={
              editing !== 'shipping' && (
                <div className="flex gap-1">
                  {profile.shippingAddress && (
                    <button
                      className={buttonClasses({ size: 'sm', variant: 'ghost' })}
                      onClick={() =>
                        busyWrap(async () => {
                          await deleteShippingAddress();
                          setProfile({ ...profile, shippingAddress: null });
                        })
                      }
                    >
                      Remove
                    </button>
                  )}
                  <button className={buttonClasses({ size: 'sm', variant: 'ghost' })} onClick={() => setEditing('shipping')}>
                    {profile.shippingAddress ? 'Edit' : 'Add'}
                  </button>
                </div>
              )
            }
          >
            {editing === 'shipping' ? (
              <AddressForm
                kind="shipping"
                initial={profile.shippingAddress ?? profile.billingAddress}
                onCancel={() => setEditing(null)}
                onSave={async (a) => {
                  const saved = await saveAddress('shipping', a);
                  setProfile({ ...profile, shippingAddress: saved });
                  setEditing(null);
                }}
              />
            ) : (
              <AddressBlock address={profile.shippingAddress} empty="None on file." />
            )}
          </SettingsGroup>

          <SettingsGroup
            title="Saved cards"
            subtitle="Cards Stripe keeps on file for your subscriptions and future purchases."
            actions={
              profile.billingEnabled && !adding && (
                <button className={buttonClasses({ size: 'sm', variant: 'outline' })} onClick={() => setAdding(true)}>
                  Add card
                </button>
              )
            }
          >
            {!profile.billingEnabled ? (
              <p className="text-sm text-muted">Payments are not enabled on this server yet.</p>
            ) : (
              <div className="space-y-3">
                {cardsError && (
                  <p role="alert" className="text-sm text-down">
                    {cardsError}
                  </p>
                )}
                {cards === null ? (
                  <div className="flex items-center gap-2 text-sm text-muted" role="status">
                    <CandleLoader size="sm" decorative /> Loading cards…
                  </div>
                ) : cards.length === 0 && !adding ? (
                  <p className="text-sm text-muted">No saved cards.</p>
                ) : (
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {cards.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                        <div className="text-sm">
                          <span className="font-semibold text-text">{cardLabel(c)}</span>
                          <span className="ml-2 text-xs text-faint">
                            expires {String(c.expMonth).padStart(2, '0')}/{c.expYear}
                          </span>
                          {c.isDefault && (
                            <Badge tone="brand" className="ml-2">
                              Default
                            </Badge>
                          )}
                          {c.expired && (
                            <Badge tone="negative" className="ml-2">
                              Expired
                            </Badge>
                          )}
                        </div>
                        <div className="flex gap-1">
                          {!c.isDefault && (
                            <button
                              disabled={busy}
                              className={buttonClasses({ size: 'sm', variant: 'ghost' })}
                              onClick={() =>
                                busyWrap(async () => {
                                  try {
                                    setCards((await setDefaultCard(c.id)).cards);
                                    setNotice(`${cardLabel(c)} is now your default card.`);
                                  } catch (e) {
                                    setCardsError(e instanceof Error ? e.message : 'Could not change the default card.');
                                  }
                                })
                              }
                            >
                              Make default
                            </button>
                          )}
                          <button
                            disabled={busy}
                            aria-label={`Remove ${cardLabel(c)}`}
                            className={buttonClasses({ size: 'sm', variant: 'ghost', className: 'text-down' })}
                            onClick={() => setConfirmRemove(c)}
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {adding && catalog?.publishableKey && (
                  <div className="rounded-lg border border-border2 p-3">
                    <AddCardForm
                      publishableKey={catalog.publishableKey}
                      billing={profile.billingAddress}
                      email={profile.email}
                      onCancel={() => setAdding(false)}
                      onDone={async () => {
                        setAdding(false);
                        setNotice('Card saved.');
                        await loadCards();
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </SettingsGroup>

          <SettingsGroup title="Subscriptions" subtitle="Renewing plans and passes on this account.">
            {subs.length === 0 ? (
              <p className="text-sm text-muted">
                No plans yet.{' '}
                <Link href="/checkout" className="text-teal hover:underline">
                  See plans
                </Link>
              </p>
            ) : (
              <ul className="space-y-2">
                {subs.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2.5 text-sm">
                    <div>
                      <span className="font-semibold text-text">{s.plan}</span>
                      <Badge tone={s.status === 'ACTIVE' || s.status === 'TRIALING' ? 'positive' : s.status === 'PAST_DUE' ? 'warning' : 'neutral'} className="ml-2">
                        {s.status === 'PAST_DUE' ? 'Payment due' : s.status.toLowerCase()}
                      </Badge>
                      <div className="text-xs text-faint">
                        {s.expiresAt
                          ? `${s.renews ? 'Renews' : s.cancelAtPeriodEnd ? 'Ends' : 'Access until'} ${new Date(s.expiresAt).toLocaleDateString()}`
                          : 'No end date'}
                      </div>
                    </div>
                    {s.provider === 'stripe' && s.planCode !== '' && (s.renews || s.cancelAtPeriodEnd) && (
                      <button
                        disabled={busy}
                        className={buttonClasses({ size: 'sm', variant: s.cancelAtPeriodEnd ? 'outline' : 'ghost' })}
                        onClick={() =>
                          s.cancelAtPeriodEnd
                            ? busyWrap(async () => setSubs((await resumeSubscription(s.id)).subscriptions))
                            : setConfirmCancel(s)
                        }
                      >
                        {s.cancelAtPeriodEnd ? 'Resume' : 'Cancel renewal'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SettingsGroup>

          <SettingsGroup title="Order history" subtitle="Every charge, with tax and status.">
            {orders.length === 0 ? (
              <p className="text-sm text-muted">No orders yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-faint">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">Date</th>
                      <th className="py-1.5 pr-3 font-medium">Item</th>
                      <th className="py-1.5 pr-3 font-medium">Tax</th>
                      <th className="py-1.5 pr-3 font-medium">Total</th>
                      <th className="py-1.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {orders.map((o) => (
                      <tr key={o.id}>
                        <td className="py-2 pr-3 text-muted">{new Date(o.createdAt).toLocaleDateString()}</td>
                        <td className="py-2 pr-3">
                          <Link href={`/checkout/orders/${o.id}`} className="text-teal hover:underline">
                            {o.label}
                          </Link>
                        </td>
                        <td className="py-2 pr-3 text-muted">{money(o.taxMinor, o.currency)}</td>
                        <td className="py-2 pr-3 font-semibold text-text">{money(o.totalMinor, o.currency)}</td>
                        <td className="py-2">
                          <Badge tone={STATUS_TONE[o.status] ?? 'neutral'}>{o.status.replace('_', ' ')}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SettingsGroup>
        </>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        title="Remove this card?"
        body={
          confirmRemove ? (
            <>
              {cardLabel(confirmRemove)} will be removed from your account and can no longer be charged. You can add it again later.
            </>
          ) : null
        }
        confirmLabel="Remove card"
        busy={busy}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() =>
          busyWrap(async () => {
            const c = confirmRemove!;
            try {
              setCards((await removeCard(c.id)).cards);
              setNotice(`${cardLabel(c)} removed.`);
            } catch (e) {
              setCardsError(e instanceof Error ? e.message : 'Could not remove the card.');
            } finally {
              setConfirmRemove(null);
            }
          })
        }
      />
      <ConfirmDialog
        open={confirmCancel !== null}
        title="Cancel renewal?"
        body={
          confirmCancel ? (
            <>
              {confirmCancel.plan} will not renew. You keep access until{' '}
              {confirmCancel.expiresAt ? new Date(confirmCancel.expiresAt).toLocaleDateString() : 'the end of the period'}.
            </>
          ) : null
        }
        confirmLabel="Cancel renewal"
        busy={busy}
        onCancel={() => setConfirmCancel(null)}
        onConfirm={() =>
          busyWrap(async () => {
            try {
              setSubs((await cancelSubscription(confirmCancel!.id)).subscriptions);
              setNotice('Renewal cancelled. Access continues until the end of the period.');
            } finally {
              setConfirmCancel(null);
            }
          })
        }
      />
    </SettingsSection>
  );
}

function AddressBlock({ address, empty }: { address: AddressView | null; empty: string }) {
  if (!address) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <div className="text-sm">
      <p className="font-semibold text-text">{address.name}</p>
      <p className="text-muted">{addressSummary(address)}</p>
      {address.phone && <p className="text-muted">{address.phone}</p>}
      {address.stripeSync.status === 'pending' && (
        <p className="mt-1 text-xs text-amber" role="status">
          {address.stripeSync.message ?? 'Not yet saved to the payment provider. Retrying automatically.'}
        </p>
      )}
    </div>
  );
}

function NamesForm({
  profile,
  onSave,
  onCancel,
}: {
  profile: BillingProfile;
  onSave: (n: { firstName: string; lastName: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [firstName, setFirst] = useState(profile.firstName ?? '');
  const [lastName, setLast] = useState(profile.lastName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cls = 'mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSave({ firstName, lastName });
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not save.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-faint">
          First name
          <input required maxLength={60} value={firstName} onChange={(e) => setFirst(e.target.value)} autoComplete="given-name" className={cls} />
        </label>
        <label className="block text-xs text-faint">
          Last name
          <input required maxLength={60} value={lastName} onChange={(e) => setLast(e.target.value)} autoComplete="family-name" className={cls} />
        </label>
      </div>
      {error && (
        <p role="alert" className="text-xs text-down">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={buttonClasses({ size: 'sm' })}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className={buttonClasses({ size: 'sm', variant: 'ghost' })}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Shown instead of billing when the account's email is not verified yet. */
export function VerifyFirst({ email }: { email: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [dev, setDev] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-xl border border-amber/40 bg-amber-bg p-4" role="alert">
      <p className="text-sm font-semibold text-amber">Verify your email to use billing</p>
      <p className="mt-1 text-sm text-muted">
        We sent a link to {email || 'your email address'}. Open it to unlock checkout and saved cards.
      </p>
      <button
        disabled={busy}
        className={buttonClasses({ size: 'sm', variant: 'outline', className: 'mt-3' })}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });
            setDev(r.devVerifyUrl ?? null);
            setMsg('A new link is on its way. Earlier links no longer work.');
          } catch (e) {
            setMsg(e instanceof Error ? e.message : 'Could not send a new link.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Sending…' : 'Send a new link'}
      </button>
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}
      {dev && (
        <a href={new URL(dev).pathname + new URL(dev).search} className="mt-2 block text-xs font-semibold text-amber underline">
          No mail provider configured: open the verification link
        </a>
      )}
    </div>
  );
}
