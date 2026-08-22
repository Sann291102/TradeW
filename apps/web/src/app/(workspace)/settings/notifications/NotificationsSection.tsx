'use client';

import Link from 'next/link';
import { Badge, Card } from '@tradew/ui';
import { useSessionStore } from '@/lib/store/sessionStore';
import { useSettingsStore } from '@/lib/store/settingsStore';
import {
  NOTIFICATION_CATEGORY_LABELS,
  type NotificationCategory,
} from '@/lib/settings/preferences';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SaveStatus, SettingRow, SignInRequired, Toggle } from '@/components/settings/controls';

/**
 * Settings → Notifications.
 *
 * ── WHAT A TOGGLE HERE ACTUALLY DOES ───────────────────────────────────────
 *
 * TradeW's notification system is in-app: producers in `services/api` write
 * `Notification` rows, and the web client polls `GET /notifications`. There is
 * no per-category subscription table on the server, so muting a category
 * cannot stop it being WRITTEN — it stops it being DELIVERED to you. The
 * preference is applied in `lib/query/useNotifications`, which filters the fed
 * list, so a muted category disappears from the bell count and the notification
 * centre alike.
 *
 * That distinction is stated on the page rather than glossed over. It is the
 * difference between "you will not see this" (true) and "this will not be
 * generated" (false).
 *
 * EMAIL, SMS AND PUSH. TradeW sends email for a fixed set of security and
 * billing events — sign-in alerts, password changes, payment receipts — and
 * those are not optional, because they are the record that something happened
 * to your account. There is no email preference system, no SMS notification
 * path (SMS is used only for one-time codes), and no web-push registration.
 * They are listed as unavailable rather than rendered as dead switches.
 */

const CATEGORY_ORDER: NotificationCategory[] = [
  'trade',
  'portfolio',
  'sentinel',
  'research',
  'learning',
  'broker',
  'announcement',
];

export function NotificationsSection() {
  const signedIn = useSessionStore((s) => s.status === 'authenticated');
  const prefs = useSettingsStore((s) => s.prefs.notifications);
  const update = useSettingsStore((s) => s.update);
  const saving = useSettingsStore((s) => s.saveState.notifications === 'saving');

  if (!signedIn) {
    return (
      <SettingsSection title="Notifications" description="Which alerts reach you, and how.">
        <SignInRequired what="choose which notifications reach you" />
      </SettingsSection>
    );
  }

  function setCategory(category: NotificationCategory, enabled: boolean) {
    void update('notifications', {
      categories: { ...prefs.categories, [category]: enabled },
    });
  }

  return (
    <SettingsSection title="Notifications" description="Which alerts reach you, and how.">
      <Card title="In-app notifications" subtitle="· the bell and the Alerts feed" actions={<SaveStatus section="notifications" />}>
        {CATEGORY_ORDER.map((category) => {
          const meta = NOTIFICATION_CATEGORY_LABELS[category];
          return (
            <SettingRow
              key={category}
              label={meta.label}
              htmlFor={`notify-${category}`}
              hint={meta.hint}
              control={
                <Toggle
                  id={`notify-${category}`}
                  label={meta.label}
                  disabled={saving}
                  checked={prefs.categories[category]}
                  onChange={(enabled) => setCategory(category, enabled)}
                />
              }
            />
          );
        })}
        <SettingRow
          label="Notification sound"
          htmlFor="notify-sound"
          hint="A short chime when something new arrives while TradeW is open."
          control={
            <Toggle
              id="notify-sound"
              label="Notification sound"
              disabled={saving}
              checked={prefs.sound}
              onChange={(sound) => void update('notifications', { sound })}
            />
          }
        />
        <p className="pt-3 max-w-prose text-[11px] leading-relaxed text-faint">
          Muting a category hides it from your bell count and your{' '}
          <Link href="/notifications" className="text-teal hover:underline">
            Alerts feed
          </Link>
          . It does not stop the event being recorded on your account — there is no per-category
          subscription on the server, so the filtering happens on delivery.
        </p>
      </Card>

      <Card title="Other channels">
        <SettingRow
          label="Security emails"
          hint="Sign-in alerts, password changes and payment receipts."
          control={
            <Badge tone="positive" className="px-1.5 py-0 text-[9px]">
              ALWAYS ON
            </Badge>
          }
        />
        <SettingRow
          label="Product and marketing email"
          hint="Announcements and product updates by email."
          unavailable="TradeW sends no marketing email and has no email preference system. There is nothing to opt out of."
          control={<span className="text-sm text-muted">—</span>}
        />
        <SettingRow
          label="SMS notifications"
          hint="Alerts delivered by text message."
          unavailable="The SMS provider is wired only for one-time sign-in codes. There is no notification path over SMS."
          control={<span className="text-sm text-muted">—</span>}
        />
        <SettingRow
          label="Push notifications"
          hint="Alerts on your device when TradeW is closed."
          unavailable="No service worker and no push subscription exist in the app, so nothing could be delivered."
          control={<span className="text-sm text-muted">—</span>}
        />
      </Card>
    </SettingsSection>
  );
}
