'use client';

import Link from 'next/link';
import { Badge, Card, cn } from '@tradew/ui';
import { useSessionStore } from '@/lib/store/sessionStore';
import { useSettingsStore } from '@/lib/store/settingsStore';
import { initials } from '@/lib/format';
import { CandlePreview } from '@/components/settings/CandlePreview';
import { LEGAL_DOCUMENTS } from '@/components/settings/legal-documents';
import {
  KeyIcon,
  ShieldIcon,
  DeviceIcon,
  BookIcon,
  SlidersIcon,
  TradeIcon,
  AlertsIcon,
  PlugIcon,
  CrownIcon,
  HelpIcon,
  LegalIcon,
} from '@/components/shell/icons';

/**
 * The Settings landing page — the "control centre" view from the reference
 * design: who you are, the security surface, the preference surfaces, a live
 * preview of the appearance settings, and the legal documents.
 *
 * Every tile here LINKS to the section that owns the setting; none of them
 * edits anything in place. That is deliberate. A landing page that also saved
 * would be a second writer for every preference, and the first inconsistency
 * would be a value edited here not showing up there.
 */

function TileLink({
  href,
  icon,
  title,
  body,
  cta,
  status,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  cta?: string;
  status?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex flex-col rounded-card border border-border bg-card p-4 shadow-card',
        'transition-colors duration-micro hover:border-teal hover:bg-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-teal">{icon}</span>
        <span className="text-sm font-bold text-text">{title}</span>
        {status && <span className="ml-auto">{status}</span>}
      </div>
      <p className="mt-1.5 flex-1 text-xs leading-relaxed text-muted">{body}</p>
      {cta && <span className="mt-2.5 text-xs font-semibold text-teal">{cta} →</span>}
    </Link>
  );
}

export function SettingsOverview() {
  const status = useSessionStore((s) => s.status);
  const user = useSessionStore((s) => s.user);
  const hasSentinel = useSessionStore((s) => s.hasCapability('sentinel'));
  const appearance = useSettingsStore((s) => s.prefs.appearance);

  const memberSince = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    : null;

  return (
    <div className="space-y-6">
      {/* ── Account overview ────────────────────────────────────────────── */}
      <Card title="Account overview">
        {status === 'authenticated' && user ? (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-teal text-sm font-bold text-white">
                {initials(user.email)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-text">{user.email}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <Badge tone="warning" className="px-1.5 py-0 text-[9px]">PAPER</Badge>
                  {hasSentinel && (
                    <Badge tone="positive" className="px-1.5 py-0 text-[9px]">SENTINEL</Badge>
                  )}
                </div>
              </div>
            </div>
            {memberSince && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-faint">Member since</div>
                <div className="text-sm font-semibold text-text">{memberSince}</div>
              </div>
            )}
            <div>
              <div className="text-[11px] uppercase tracking-wide text-faint">Account type</div>
              <div className="text-sm font-semibold text-text">Paper trading</div>
            </div>
            <Link
              href="/settings/account"
              className="ml-auto rounded-lg border border-border2 px-3 py-2 text-xs font-bold text-text transition-colors hover:bg-hover"
            >
              Edit profile
            </Link>
          </div>
        ) : (
          <p className="text-sm text-muted">
            You are not signed in. Settings live on your TradeW account —{' '}
            <Link href="/" className="text-teal hover:underline">
              sign in
            </Link>{' '}
            to see and change them.
          </p>
        )}
      </Card>

      {/* ── Account & security ──────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-bold text-text">Account &amp; security</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <TileLink
            href="/settings/account#password"
            icon={<KeyIcon />}
            title="Change password"
            body="Update your password from inside this session. Signs every other device out."
            cta="Change password"
          />
          <TileLink
            href="/settings/account#sessions"
            icon={<DeviceIcon />}
            title="Active sessions"
            body="Every sign-in that is still valid on your account, and a way to end the others."
            cta="Review sessions"
          />
          <TileLink
            href="/settings/privacy"
            icon={<ShieldIcon />}
            title="Privacy & security"
            body="What TradeW stores, what you can export, and how to close the account."
            cta="Open privacy"
          />
        </div>
      </section>

      {/* ── Preferences ─────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-bold text-text">Preferences</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <TileLink
            href="/settings/preferences"
            icon={<SlidersIcon />}
            title="App preferences"
            body="Number and date formats, where sign-in lands, and how dense the tables are."
            cta="Configure"
          />
          <TileLink
            href="/settings/trading"
            icon={<TradeIcon />}
            title="Trading defaults"
            body="What the order ticket opens with, and whether orders need a second confirmation."
            cta="Configure"
          />
          <TileLink
            href="/settings/how-to-use"
            icon={<BookIcon />}
            title="How to use TradeW"
            body="What each workspace does, what it reads from, and what it does not do."
            cta="View guide"
          />
        </div>
      </section>

      {/* ── Appearance preview ──────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-bold text-text">Appearance</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <Card
            title="Candle colours"
            actions={
              <Link href="/settings/appearance" className="text-xs font-semibold text-teal hover:underline">
                Customise →
              </Link>
            }
          >
            <p className="mb-3 text-xs text-muted">
              These are the colours your charts are painted with right now.
            </p>
            <CandlePreview up={appearance.candleUp} down={appearance.candleDown} hollowUp={appearance.hollowUpCandles} />
          </Card>
          <Card
            title="Theme"
            actions={
              <Link href="/settings/appearance" className="text-xs font-semibold text-teal hover:underline">
                Change →
              </Link>
            }
          >
            <p className="text-xs text-muted">
              Currently{' '}
              <span className="font-semibold text-text">
                {appearance.theme === 'system' ? 'System (follows your device)' : titleCase(appearance.theme)}
              </span>
              . Light, Dark, System and High Contrast are all available.
            </p>
          </Card>
        </div>
      </section>

      {/* ── Legal ───────────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-bold text-text">Legal &amp; policies</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {LEGAL_DOCUMENTS.slice(0, 4).map((doc) => (
            <TileLink
              key={doc.slug}
              href={`/settings/legal/${doc.slug}`}
              icon={<LegalIcon />}
              title={doc.title}
              body={doc.summary}
              cta="Read"
            />
          ))}
        </div>
        <p className="mt-2 text-[11px] text-faint">
          <Link href="/settings/legal" className="text-teal hover:underline">
            All policies
          </Link>{' '}
          · every document is marked as awaiting legal review, because none of it has been through
          one.
        </p>
      </section>

      {/* ── Other ───────────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-bold text-text">Other</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TileLink
            href="/settings/notifications"
            icon={<AlertsIcon />}
            title="Notifications"
            body="Choose which categories reach you."
          />
          <TileLink
            href="/settings/integrations"
            icon={<PlugIcon />}
            title="Integrations"
            body="Broker and market-data connections."
          />
          <TileLink
            href="/settings/subscription"
            icon={<CrownIcon />}
            title="Subscription"
            body="Your plan and what it entitles you to."
            status={
              hasSentinel ? (
                <Badge tone="positive" className="px-1.5 py-0 text-[9px]">ACTIVE</Badge>
              ) : undefined
            }
          />
          <TileLink
            href="/settings/help"
            icon={<HelpIcon />}
            title="Help & support"
            body="Documentation and how to reach us."
          />
        </div>
      </section>
    </div>
  );
}

function titleCase(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
