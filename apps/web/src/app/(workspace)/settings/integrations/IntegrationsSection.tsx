'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, CandleLoader, buttonClasses, cn } from '@tradew/ui';
import { api } from '@/lib/api';
import { useSessionStore } from '@/lib/store/sessionStore';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SignInRequired } from '@/components/settings/controls';

/**
 * Settings → Integrations.
 *
 * ── ONLY REAL INTEGRATIONS APPEAR HERE ─────────────────────────────────────
 *
 * The one integration a USER can connect, disconnect and see the state of is
 * Dhan, through `services/api/src/broker` — `GET /broker/dhan/connect` starts
 * the consent flow, `GET /broker/dhan/status` reports the stored credential
 * (never the token itself), and `DELETE /broker/dhan/credential` revokes it.
 * All three are scoped to the caller's own subject; there is no route that
 * touches another user's credential.
 *
 * The other providers TradeW talks to — NSE, the newswires, Binance, Twelve
 * Data, the model providers — are OPERATOR-level: configured by environment
 * variables on the server, shared by every account, with no per-user
 * credential and nothing for a user to connect or disconnect. They are listed
 * as such rather than rendered as connectable cards, because a "Connect"
 * button that could not connect anything is exactly the kind of control this
 * area must not have.
 */

interface DhanStatus {
  connected: boolean;
  brokerClientId?: string | null;
  brokerClientName?: string | null;
  expiresAt?: string | null;
  expired?: boolean;
  source?: string | null;
  isFeedDefault?: boolean;
}

type State = 'connected' | 'attention' | 'disconnected';

const TONE: Record<State, { tone: 'positive' | 'warning' | 'neutral'; label: string }> = {
  connected: { tone: 'positive', label: 'CONNECTED' },
  attention: { tone: 'warning', label: 'NEEDS ATTENTION' },
  disconnected: { tone: 'neutral', label: 'NOT CONNECTED' },
};

/** Providers TradeW uses server-side. Listed for transparency; none of them is
 *  a per-user connection, so none of them has a control. */
const PLATFORM_PROVIDERS = [
  { name: 'NSE', purpose: 'Index constituents, market status, breadth, FII/DII flows, the corporate event calendar.' },
  { name: 'Dhan market feed', purpose: 'Live ticks and intraday candles for Indian equities, indices and options.' },
  { name: 'Binance', purpose: 'Crypto prices on the Crypto workspace.' },
  { name: 'Twelve Data', purpose: 'Foreign-exchange rates on the Forex workspace.' },
  { name: 'Newswires', purpose: 'Market news on the News Feed, with symbol association.' },
  { name: 'Model providers', purpose: 'The language and reasoning models behind AI Sentinel and the assistant.' },
  { name: 'Razorpay', purpose: 'Subscription checkout and payment verification.' },
];

export function IntegrationsSection() {
  const signedIn = useSessionStore((s) => s.status === 'authenticated');
  const [status, setStatus] = useState<DhanStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStatus((await api('/broker/dhan/status')) as DhanStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read your broker connection.');
    }
  }, []);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  /**
   * Start the real consent flow.
   *
   * `GET /broker/dhan/connect` returns the provider's login URL and sets the
   * single-use state cookie. The browser is then handed to Dhan; the
   * credential is only stored when the provider redirects back to the API's
   * callback and the exchange succeeds. Nothing on this page marks the account
   * connected on its own — the status is re-read from the server afterwards.
   */
  async function connect() {
    setBusy(true);
    setNotice(null);
    try {
      const res = (await api('/broker/dhan/connect')) as { loginUrl?: string };
      if (!res.loginUrl) throw new Error('The broker did not return a login URL.');
      window.location.href = res.loginUrl;
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not start the broker connection.');
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setNotice(null);
    try {
      const res = (await api('/broker/dhan/credential', { method: 'DELETE' })) as { disconnected: boolean };
      setNotice(res.disconnected ? 'Broker credential removed from your account.' : 'There was no credential to remove.');
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) {
    return (
      <SettingsSection title="Integrations" description="Services connected to your TradeW account.">
        <SignInRequired what="manage your connections" />
      </SettingsSection>
    );
  }

  const state: State = !status?.connected ? 'disconnected' : status.expired ? 'attention' : 'connected';
  const badge = TONE[state];

  return (
    <SettingsSection title="Integrations" description="Services connected to your TradeW account.">
      <Card title="Broker">
        {error ? (
          <p className="text-xs font-semibold text-down">{error}</p>
        ) : status === null ? (
          <div className="flex justify-center py-4">
            <CandleLoader size="sm" label="Reading your broker connection" />
          </div>
        ) : (
          <div className="rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-text">Dhan</span>
              <Badge tone={badge.tone} className="px-1.5 py-0 text-[9px]">
                {badge.label}
              </Badge>
              {status.isFeedDefault && (
                <Badge tone="brand" className="px-1.5 py-0 text-[9px]">
                  FEED DEFAULT
                </Badge>
              )}
            </div>

            <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
              Links your Dhan account so TradeW can read live market data and your broker account
              details. TradeW does not place orders with your broker — order placement is paper
              trading, matched by TradeW&apos;s own engine.
            </p>

            {status.connected && (
              <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                <div className="flex gap-2">
                  <dt className="text-faint">Client</dt>
                  <dd className="font-semibold text-text">
                    {status.brokerClientName || status.brokerClientId || '—'}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-faint">Token expires</dt>
                  <dd className={cn('font-semibold', status.expired ? 'text-down' : 'text-text')}>
                    {status.expiresAt
                      ? new Date(status.expiresAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
                      : 'Not reported by the broker'}
                  </dd>
                </div>
              </dl>
            )}

            {status.expired && (
              <p className="mt-2 text-xs font-semibold text-amber">
                The stored token has expired. Reconnect to restore live data on this account.
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void connect()}
                className={buttonClasses({ variant: status.connected ? 'outline' : 'primary', size: 'sm' })}
              >
                {busy ? 'Working…' : status.connected ? 'Reconnect' : 'Connect Dhan'}
              </button>
              {status.connected && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void disconnect()}
                  className={buttonClasses({ variant: 'danger', size: 'sm' })}
                >
                  Disconnect
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void load()}
                className={buttonClasses({ variant: 'ghost', size: 'sm' })}
              >
                Refresh status
              </button>
            </div>

            {notice && <p className="mt-2 text-xs font-semibold text-muted">{notice}</p>}

            <p className="mt-3 text-[11px] leading-relaxed text-faint">
              Connecting sends you to Dhan to authorise TradeW. The connection is only recorded once
              Dhan redirects back and the token exchange succeeds — this page reports whatever the
              server says afterwards, never an assumption. Your access token is stored against your
              account and is never displayed here.
            </p>
          </div>
        )}
      </Card>

      <Card title="Platform data providers" subtitle="· configured by TradeW, not by you">
        <p className="mb-3 max-w-prose text-xs leading-relaxed text-muted">
          These are the services TradeW itself talks to. They are configured on the server and
          shared across the platform — there is no per-account credential, so there is nothing here
          to connect or disconnect.
        </p>
        <ul className="divide-y divide-border">
          {PLATFORM_PROVIDERS.map((p) => (
            <li key={p.name} className="flex flex-wrap items-start gap-2 py-2">
              <span className="w-40 shrink-0 text-xs font-bold text-text">{p.name}</span>
              <span className="min-w-0 flex-1 text-xs text-muted">{p.purpose}</span>
              <Badge tone="neutral" className="shrink-0 px-1.5 py-0 text-[9px]">
                PLATFORM
              </Badge>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Not available">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          TradeW issues no personal API keys and registers no outbound webhooks. There is no
          developer API, no OAuth provider and no webhook subscription model in the platform, so
          none of them appears here as an empty list waiting to be filled.
        </p>
      </Card>
    </SettingsSection>
  );
}
