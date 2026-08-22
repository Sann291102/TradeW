'use client';

import Link from 'next/link';
import { Card } from '@tradew/ui';
import { useSessionStore } from '@/lib/store/sessionStore';
import { useSettingsStore } from '@/lib/store/settingsStore';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SaveStatus, Select, SettingRow, SignInRequired, Toggle } from '@/components/settings/controls';

/**
 * Settings → Trading.
 *
 * ── THE RULE THIS PAGE IS BUILT AROUND ─────────────────────────────────────
 *
 * A trading preference may change what the order ticket OPENS WITH, and may
 * ADD a confirmation step. It may never remove one, weaken a validation, or
 * bypass a control.
 *
 * Concretely: nothing here touches the discipline engine (which can block an
 * order and demand a typed reason), the margin and lot-size checks in the
 * ticket, or any server-side validation in `/sim/orders`. Those run identically
 * whatever is set on this page — which is why there is no "skip warnings"
 * toggle, no "disable friction prompt", and no risk-limit override. Those
 * belong to the discipline system, where they are a deliberate, logged
 * override, not a setting someone flips once and forgets.
 */
export function TradingSection() {
  const signedIn = useSessionStore((s) => s.status === 'authenticated');
  const prefs = useSettingsStore((s) => s.prefs.trading);
  const update = useSettingsStore((s) => s.update);
  const saving = useSettingsStore((s) => s.saveState.trading === 'saving');

  if (!signedIn) {
    return (
      <SettingsSection title="Trading" description="What the order ticket opens with, and how much it asks before sending.">
        <SignInRequired what="set your trading defaults" />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="Trading"
      description="What the order ticket opens with, and how much it asks before sending."
    >
      <Card title="Order ticket defaults" actions={<SaveStatus section="trading" />}>
        <SettingRow
          label="Default product"
          htmlFor="default-product"
          hint="Intraday positions are squared off the same day; delivery is held overnight and needs the full cash."
          control={
            <Select
              id="default-product"
              label="Default product"
              disabled={saving}
              value={prefs.defaultProductType}
              options={[
                { value: 'MIS', label: 'Intraday (MIS)' },
                { value: 'CNC', label: 'Delivery (CNC)' },
                { value: 'NRML', label: 'Normal (NRML)' },
              ]}
              onChange={(defaultProductType) => void update('trading', { defaultProductType })}
            />
          }
        />
        <SettingRow
          label="Quantity entered as"
          htmlFor="default-qty-unit"
          hint="Lots multiply by the instrument's lot size from the exchange scrip master. Raw quantity must still be a whole number of lots — the ticket enforces that either way."
          control={
            <Select
              id="default-qty-unit"
              label="Quantity entered as"
              disabled={saving}
              value={prefs.defaultQuantityUnit}
              options={[
                { value: 'lots', label: 'Lots' },
                { value: 'qty', label: 'Quantity' },
              ]}
              onChange={(defaultQuantityUnit) => void update('trading', { defaultQuantityUnit })}
            />
          }
        />
        <SettingRow
          label="Default lots"
          htmlFor="default-lots"
          hint="How many lots the ticket pre-fills. You can always change it before sending."
          control={
            <Select
              id="default-lots"
              label="Default lots"
              disabled={saving}
              value={String(prefs.defaultLots)}
              options={[1, 2, 3, 5, 10].map((n) => ({ value: String(n), label: String(n) }))}
              onChange={(value) => void update('trading', { defaultLots: Number(value) })}
            />
          }
        />
      </Card>

      <Card title="Confirmation" actions={<SaveStatus section="trading" />}>
        <SettingRow
          label="Confirm before placing an order"
          htmlFor="confirm-order"
          hint="Adds a summary step — instrument, side, quantity, product, estimated value — that you have to accept before the order is sent."
          control={
            <Toggle
              id="confirm-order"
              label="Confirm before placing an order"
              disabled={saving}
              checked={prefs.confirmBeforeOrder}
              onChange={(confirmBeforeOrder) => void update('trading', { confirmBeforeOrder })}
            />
          }
        />
        <p className="pt-3 text-[11px] leading-relaxed text-faint">
          This setting only ever adds a step. Turning it off restores the ticket&apos;s original
          behaviour and changes nothing else — the discipline limits, the margin and lot-size
          checks, and every server-side validation run exactly the same way in both states.
        </p>
      </Card>

      <Card title="Not settings" className="border-amber bg-amber-bg">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Some things that look like trading preferences are deliberately not on this page.
        </p>
        <ul className="mt-2 space-y-2 text-xs text-muted">
          <li>
            <span className="font-semibold text-text">Risk and session limits.</span> Your daily loss
            limit, trade count and cooling-off live in the discipline system, where exceeding one
            requires a typed reason that is recorded.{' '}
            <Link href="/discipline" className="text-teal hover:underline">
              Open discipline
            </Link>
            .
          </li>
          <li>
            <span className="font-semibold text-text">Default order type and validity.</span> The
            ticket opens on MARKET / DAY. Making these configurable would let an account default to
            a resting limit order, which is a materially different behaviour and needs more than a
            dropdown.
          </li>
          <li>
            <span className="font-semibold text-text">Default exchange.</span> The exchange is a
            property of the instrument, resolved from the scrip master. There is nothing for an
            account-level default to select.
          </li>
        </ul>
      </Card>
    </SettingsSection>
  );
}
