'use client';

import { Card } from '@tradew/ui';
import { useSessionStore } from '@/lib/store/sessionStore';
import { useSettingsStore } from '@/lib/store/settingsStore';
import { LANDING_ROUTES } from '@/lib/settings/preferences';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SaveStatus, Select, SettingRow, SignInRequired, Toggle } from '@/components/settings/controls';

/**
 * Settings → Preferences.
 *
 * Everything on this page persists to the `general` preference document on the
 * account. Where a preference has a reader, the comment on the field in
 * `lib/settings/preferences.ts` names it.
 *
 * Language and currency are shown as unavailable rather than offered. TradeW
 * ships no translations — there is no i18n framework, no message catalogue and
 * no locale routing — and every figure in the product is rupee-denominated all
 * the way down to the OMS, which stores integer quantities against INR prices.
 * A language picker with one language, or a currency picker that changed a
 * symbol without converting a number, would both be worse than the honest
 * absence.
 */
export function PreferencesSection() {
  const signedIn = useSessionStore((s) => s.status === 'authenticated');
  const prefs = useSettingsStore((s) => s.prefs.general);
  const update = useSettingsStore((s) => s.update);
  const saving = useSettingsStore((s) => s.saveState.general === 'saving');

  if (!signedIn) {
    return (
      <SettingsSection title="Preferences" description="How TradeW behaves and what it opens on.">
        <SignInRequired what="set your preferences" />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Preferences" description="How TradeW behaves and what it opens on.">
      <Card title="Application" actions={<SaveStatus section="general" />}>
        <SettingRow
          label="Landing page"
          htmlFor="landing-route"
          hint="Where you arrive after signing in."
          control={
            <Select
              id="landing-route"
              label="Landing page"
              disabled={saving}
              value={prefs.landingRoute}
              options={LANDING_ROUTES.map((r) => ({ value: r.value, label: r.label }))}
              onChange={(landingRoute) => void update('general', { landingRoute })}
            />
          }
        />
        <SettingRow
          label="Number format"
          htmlFor="number-format"
          hint="Indian grouping writes 12,34,567; international writes 1,234,567. Applies to figures rendered through the shared formatter."
          control={
            <Select
              id="number-format"
              label="Number format"
              disabled={saving}
              value={prefs.numberFormat}
              options={[
                { value: 'en-IN', label: 'Indian (12,34,567)' },
                { value: 'en-US', label: 'International (1,234,567)' },
              ]}
              onChange={(numberFormat) => void update('general', { numberFormat })}
            />
          }
        />
        <SettingRow
          label="Date format"
          htmlFor="date-format"
          hint="Used where TradeW renders a date through the preference-aware formatter."
          control={
            <Select
              id="date-format"
              label="Date format"
              disabled={saving}
              value={prefs.dateFormat}
              options={[
                { value: 'dd-mm-yyyy', label: '31-12-2026' },
                { value: 'yyyy-mm-dd', label: '2026-12-31' },
                { value: 'mm-dd-yyyy', label: '12-31-2026' },
              ]}
              onChange={(dateFormat) => void update('general', { dateFormat })}
            />
          }
        />
        <SettingRow
          label="Compact layout"
          htmlFor="density"
          hint="Tightens row height and padding on dense tables. Applied as a data attribute on the document, so it affects the whole app rather than one page."
          control={
            <Toggle
              id="density"
              label="Compact layout"
              disabled={saving}
              checked={prefs.density === 'compact'}
              onChange={(compact) => void update('general', { density: compact ? 'compact' : 'comfortable' })}
            />
          }
        />
      </Card>

      <Card title="Not available">
        <SettingRow
          label="Language"
          hint="TradeW is English-only."
          unavailable="No translations exist — there is no i18n framework or message catalogue in the app, so there is nothing to switch between."
          control={<span className="text-sm text-muted">English</span>}
        />
        <SettingRow
          label="Currency"
          hint="Every price, charge and P&L figure in TradeW is in Indian rupees."
          unavailable="The order engine is rupee-denominated end to end. A currency selector would change a symbol without converting a number, which would misstate your account."
          control={<span className="text-sm text-muted">INR (₹)</span>}
        />
        <SettingRow
          label="Timezone"
          hint="Market times are shown in IST, which is the exchange's timezone."
          unavailable="Chart axes, session boundaries and the market calendar are all IST-relative by construction; rendering them in another zone would move the trading day."
          control={<span className="text-sm text-muted">Asia/Kolkata (IST)</span>}
        />
        <SettingRow
          label="Default market and instrument"
          hint="Which instrument the Trade workspace opens on."
          unavailable="The workspace already remembers the last instrument you selected, per device. A second, server-side default would fight with it."
          control={<span className="text-sm text-muted">Last used</span>}
        />
      </Card>
    </SettingsSection>
  );
}
