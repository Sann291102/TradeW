import type { ComponentType, SVGProps } from 'react';
import {
  ProfileIcon,
  SlidersIcon,
  PaletteIcon,
  TradeIcon,
  AlertsIcon,
  ShieldIcon,
  PlugIcon,
  CrownIcon,
  HelpIcon,
  LegalIcon,
  InfoIcon,
  BookIcon,
} from '../shell/icons';

export interface SettingsNavItem {
  href: string;
  label: string;
  /** The one-line description under the label, as in the reference design. */
  hint: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/**
 * The Settings centre's own navigation.
 *
 * Settings is a PARENT AREA with one route per concern, not a single scrolling
 * page — that was the brief, and it is also what makes each section
 * linkable: `/settings/appearance` is a URL you can send someone.
 *
 * Order follows the reference design. Every entry resolves to a real route
 * under `app/(workspace)/settings/`; adding one here without the route is a
 * dead link, so the two change together.
 */
export const SETTINGS_NAV: SettingsNavItem[] = [
  { href: '/settings/account', label: 'Account', hint: 'Profile, password, security', icon: ProfileIcon },
  { href: '/settings/preferences', label: 'Preferences', hint: 'Language, formats, landing page', icon: SlidersIcon },
  { href: '/settings/appearance', label: 'Appearance', hint: 'Theme, candle colours, charts', icon: PaletteIcon },
  { href: '/settings/trading', label: 'Trading', hint: 'Order defaults, confirmations', icon: TradeIcon },
  { href: '/settings/notifications', label: 'Notifications', hint: 'What you are alerted about', icon: AlertsIcon },
  { href: '/settings/privacy', label: 'Privacy & Security', hint: 'Data, sessions, deletion', icon: ShieldIcon },
  { href: '/settings/integrations', label: 'Integrations', hint: 'Broker and data connections', icon: PlugIcon },
  { href: '/settings/subscription', label: 'Subscription', hint: 'Plan, entitlements, billing', icon: CrownIcon },
  { href: '/settings/how-to-use', label: 'How to Use', hint: 'Guide to every workspace', icon: BookIcon },
  { href: '/settings/help', label: 'Help & Support', hint: 'Docs, support, feedback', icon: HelpIcon },
  { href: '/settings/legal', label: 'Legal', hint: 'Policies, agreements, terms', icon: LegalIcon },
  { href: '/settings/about', label: 'About', hint: 'Version, environment, credits', icon: InfoIcon },
];
