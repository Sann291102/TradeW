'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Card, buttonClasses, cn } from '@tradew/ui';
import { useSessionStore } from '@/lib/store/sessionStore';
import { useSettingsStore } from '@/lib/store/settingsStore';
import { buildAccountExport, downloadFile, todayStamp } from '@/lib/settings/export';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SaveStatus, SettingRow, SignInRequired, TextField, Toggle } from '@/components/settings/controls';

/**
 * Settings → Privacy & Security.
 *
 * ── ACCOUNT DELETION IS NOT IMPLEMENTED, AND THIS PAGE SAYS SO ─────────────
 *
 * There is no delete-account route in `services/api`, and no soft-delete or
 * anonymisation path in the schema. A `User` row is referenced by roughly two
 * dozen tables — orders, trades, positions, holdings, wallets, journal
 * entries, notifications, discipline sessions, broker credentials, audit
 * events — none of them declared with a cascade. Deleting an account is
 * therefore a real piece of work with real ordering constraints and a real
 * decision about which financial records must survive it; it is not something
 * to bolt onto a settings screen.
 *
 * So the section below is a disabled control with a written explanation and a
 * route to a human, not a button that pretends. The confirmation UI is built
 * and wired to the disabled state on purpose: when the endpoint exists, the
 * flow it needs is already here and already requires typing the account email.
 */
export function PrivacySection() {
  const signedIn = useSessionStore((s) => s.status === 'authenticated');
  const user = useSessionStore((s) => s.user);
  const prefs = useSettingsStore((s) => s.prefs.privacy);
  const update = useSettingsStore((s) => s.update);
  const saving = useSettingsStore((s) => s.saveState.privacy === 'saving');

  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  async function exportAccount() {
    setExporting(true);
    setExportMsg(null);
    try {
      const data = await buildAccountExport();
      downloadFile(
        `tradew-account-export-${todayStamp()}.json`,
        JSON.stringify(data, null, 2),
        'application/json',
      );
      setExportMsg({ ok: true, text: 'Export downloaded.' });
    } catch (err) {
      setExportMsg({ ok: false, text: err instanceof Error ? err.message : 'Export failed.' });
    } finally {
      setExporting(false);
    }
  }

  if (!signedIn) {
    return (
      <SettingsSection title="Privacy & Security" description="What TradeW holds, what you can take with you, and how to close the account.">
        <SignInRequired what="manage privacy and security" />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="Privacy & Security"
      description="What TradeW holds, what you can take with you, and how to close the account."
    >
      <Card title="Privacy" actions={<SaveStatus section="privacy" />}>
        <SettingRow
          label="Product analytics"
          htmlFor="product-analytics"
          hint="Anonymous interaction events used to see which parts of the workspace get used. Turning this off stops the browser sending them."
          control={
            <Toggle
              id="product-analytics"
              label="Product analytics"
              disabled={saving}
              checked={prefs.productAnalytics}
              onChange={(productAnalytics) => void update('privacy', { productAnalytics })}
            />
          }
        />
        <p className="pt-3 max-w-prose text-[11px] leading-relaxed text-faint">
          This governs the browser&apos;s own telemetry. It does not switch off server-side request
          and security logging — the API records those so that &ldquo;what happened to my
          order&rdquo; and &ldquo;was that sign-in me&rdquo; have answers — and a toggle that
          claimed otherwise would be false.
        </p>
      </Card>

      <Card title="What TradeW stores about you">
        <ul className="space-y-2 text-xs leading-relaxed text-muted">
          <li>
            <span className="font-semibold text-text">Identity.</span> Your email, and — if you use
            them — a linked Google identity or verified phone number. Passwords are stored only as
            bcrypt hashes and are never logged.
          </li>
          <li>
            <span className="font-semibold text-text">Account activity.</span> Paper orders, fills,
            positions, holdings, wallet balances, journal entries, learning progress, notifications.
          </li>
          <li>
            <span className="font-semibold text-text">Security records.</span> Sign-ins, password
            changes and session revocations, with IP and user agent.
          </li>
          <li>
            <span className="font-semibold text-text">Broker credentials.</span> If you connect a
            broker, its access token is stored against your account and is never rendered in the
            interface.
          </li>
        </ul>
        <p className="mt-3 text-[11px] text-faint">
          The full statement is in the{' '}
          <Link href="/settings/legal/data-policy" className="text-teal hover:underline">
            Data Policy
          </Link>{' '}
          and the{' '}
          <Link href="/settings/legal/privacy-policy" className="text-teal hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </Card>

      <Card id="data-export" title="Export your data">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Downloads a JSON file containing your profile, preferences, entitlements, portfolio
          summary, positions, holdings, orders and fills. It is assembled in your browser from the
          endpoints your account can already read.
        </p>
        <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-amber">
          This is your account data, not everything TradeW holds. Server-side audit rows, API call
          logs and Sentinel&apos;s internal memory are not exposed to account holders by any route,
          so they are not in the file — and this page will not claim they are.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={exporting}
            onClick={() => void exportAccount()}
            className={buttonClasses({ variant: 'outline', size: 'sm' })}
          >
            {exporting ? 'Preparing…' : 'Download account export (JSON)'}
          </button>
          <Link href="/reports" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
            CSV exports →
          </Link>
          {exportMsg && (
            <span className={cn('text-[11px] font-semibold', exportMsg.ok ? 'text-up' : 'text-down')}>
              {exportMsg.text}
            </span>
          )}
        </div>
      </Card>

      <Card title="Sessions and connected services">
        <SettingRow
          label="Active sessions"
          hint="Every sign-in still valid on your account, and a way to end the others."
          control={
            <Link href="/settings/account#sessions" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
              Review sessions
            </Link>
          }
        />
        <SettingRow
          label="Connected services"
          hint="Brokers and data providers linked to your account, and their connection state."
          control={
            <Link href="/settings/integrations" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
              Open integrations
            </Link>
          }
        />
        <SettingRow
          label="Third-party applications"
          hint="Applications you have authorised to act on your TradeW account."
          unavailable="TradeW has no OAuth provider and issues no third-party API keys, so no application can hold access to your account."
          control={<span className="text-sm text-muted">None</span>}
        />
      </Card>

      {/* ── Deletion ─────────────────────────────────────────────────────── */}
      <Card id="delete-account" className="border-down">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-down">Delete account</h2>
          <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">NOT AVAILABLE</Badge>
        </div>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
          Account deletion is not implemented. There is no endpoint that deletes or anonymises a
          TradeW account, and this page will not present a button that appears to do it.
        </p>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
          The reason is not oversight. Your account row is referenced by your orders, fills,
          positions, holdings, wallet, journal, notifications, discipline history, broker
          credentials and audit trail. Removing it correctly means deciding, per table, what is
          deleted and what has to survive as a financial or security record — and doing it in an
          order that leaves nothing dangling. That work has not been done, so the control is
          disabled rather than dangerous.
        </p>

        <div className="mt-4 max-w-md space-y-2 rounded-lg border border-border2 bg-bg p-3 opacity-60">
          <label htmlFor="delete-confirm" className="block text-xs font-semibold text-faint">
            Type your email address to confirm
          </label>
          <TextField
            id="delete-confirm"
            label="Type your email address to confirm"
            value={deleteConfirm}
            onChange={setDeleteConfirm}
            placeholder={user?.email ?? ''}
            disabled
          />
          <button
            type="button"
            disabled
            className={cn('w-full', buttonClasses({ variant: 'danger', size: 'sm' }))}
          >
            Permanently delete this account
          </button>
        </div>

        <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-faint">
          To have your account closed today, contact support from{' '}
          <Link href="/settings/help" className="text-teal hover:underline">
            Help &amp; Support
          </Link>
          . In the meantime you can export everything above and sign out of every device from{' '}
          <Link href="/settings/account#sessions" className="text-teal hover:underline">
            Active sessions
          </Link>
          .
        </p>
      </Card>
    </SettingsSection>
  );
}
