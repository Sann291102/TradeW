/**
 * The canonical footer link registry.
 *
 * EVERY footer destination in this application is written here and nowhere
 * else. No component hardcodes a URL; `links.test.ts` fails the build if one
 * does something this module forbids. The reviewed companion to this file is
 * `docs/footer/FOOTER_LINK_REGISTRY.md`, which additionally records the
 * destinations that were researched and deliberately NOT published.
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────────────────
 *
 * A footer link is a claim. "Discord" claims a Discord exists. "System Status"
 * claims something measures status. "API" claims there is an API product. On a
 * financial platform those claims are read as facts about the company, and the
 * cheapest way to make them is to type a plausible URL — which is exactly why
 * the audit that produced this file (docs/footer/FOOTER_RESEARCH_REPORT.md)
 * found a real, active, 18k-follower Instagram account at the handle a
 * reasonable person would assume is TradeW's. It belongs to TradeWill Global, a
 * different financial services company. Published, it would have looked correct
 * in review and sent TradeW's users to a competitor.
 *
 * So: no entry here has a URL that was not opened. There are currently no
 * external entries at all, because TradeW controls no verified public
 * destination — no domain, no social account, no status page, no tracker. The
 * `external` flag exists so that adding the first one is a deliberate,
 * reviewable act rather than a string edit.
 *
 * ── WHY THE LINKS POINT AT ANCHORS, NOT ROUTES ─────────────────────────────
 *
 * `middleware.ts` is a default-deny auth wall: `/`, `/reset` and the two OAuth
 * paths are the entire public surface. This footer's only reader is a
 * SIGNED-OUT reader, so a link to `/sentinel` does not open Sentinel — it
 * bounces them back to the page they are standing on, which reads as a broken
 * link. The Platform and Learn groups therefore point at sections of the
 * landing page. That is the correct destination for this audience, not a
 * compromise. `links.test.ts` asserts every one of those section ids still
 * exists in `LandingPage.tsx`.
 *
 * The `/legal/*` routes are the exception: they are new, they are public (added
 * to `PUBLIC_PATHS`), and the test asserts that too. A legal page behind an
 * auth wall is not a legal page.
 */

/** ISO date on which every destination below was last opened and confirmed. */
export const FOOTER_LINKS_VERIFIED_ON = '2026-08-20';

export type FooterGroupId = 'platform' | 'learn' | 'account' | 'legal';

export interface FooterLink {
  label: string;
  /** Same-origin path or landing anchor. External URLs require `external`. */
  href: string;
  /**
   * Off-site destination. Set this and the renderer applies
   * target/rel/glyph/"opens in a new tab" as one unit, so the accessibility and
   * security treatment of an external link cannot be forgotten per call site.
   * Nothing sets it today — see the header.
   */
  external?: true;
  /** When this destination was last opened and confirmed to resolve. */
  verifiedOn: string;
}

export interface FooterGroup {
  id: FooterGroupId;
  heading: string;
  /**
   * Rendered expanded even on mobile, where the other groups collapse into
   * accordions. True for Legal & Trust only: collapsing Privacy, Terms and the
   * Risk Disclosure puts a legally required destination behind an extra tap on
   * the device most visitors arrive on.
   */
  alwaysOpen?: true;
  links: FooterLink[];
}

const V = FOOTER_LINKS_VERIFIED_ON;

export const FOOTER_GROUPS: FooterGroup[] = [
  {
    id: 'platform',
    heading: 'Platform',
    links: [
      { label: 'Surfaces', href: '/#platform', verifiedOn: V },
      // The assistant's name is a single source of truth in
      // lib/assistant/identity.ts. It is NOT imported here: this module is
      // consumed by a test that reads it as data, and the label has to be a
      // literal for the registry doc to be reviewable against it. The landing
      // page and this list are asserted to agree by links.test.ts.
      { label: 'Tara', href: '/#assistant', verifiedOn: V },
      { label: 'Sentinel', href: '/#sentinel', verifiedOn: V },
      { label: 'Learning Hub', href: '/#learning', verifiedOn: V },
    ],
  },
  {
    id: 'learn',
    heading: 'Learn',
    links: [
      { label: 'What you get', href: '/#brief', verifiedOn: V },
      { label: 'Getting started', href: '/#start', verifiedOn: V },
      { label: 'Pricing', href: '/#pricing', verifiedOn: V },
      { label: 'Our commitments', href: '/#intelligence', verifiedOn: V },
      { label: 'FAQ', href: '/#faq', verifiedOn: V },
    ],
  },
  {
    id: 'account',
    heading: 'Account',
    links: [
      { label: 'Sign in', href: '/#auth', verifiedOn: V },
      { label: 'Create account', href: '/#auth', verifiedOn: V },
      // Public by design in middleware.ts — it is reached from an email link by
      // someone who by definition cannot sign in.
      { label: 'Reset password', href: '/reset', verifiedOn: V },
    ],
  },
  {
    id: 'legal',
    heading: 'Legal & Trust',
    alwaysOpen: true,
    links: [
      { label: 'Privacy Policy', href: '/legal/privacy', verifiedOn: V },
      { label: 'Terms & Conditions', href: '/legal/terms', verifiedOn: V },
      { label: 'Cookie Policy', href: '/legal/cookies', verifiedOn: V },
      { label: 'Risk Disclosure', href: '/legal/risk-disclosure', verifiedOn: V },
      { label: 'Disclaimer', href: '/legal/disclaimer', verifiedOn: V },
      { label: 'Security', href: '/legal/security', verifiedOn: V },
      { label: 'Responsible Trading', href: '/legal/responsible-trading', verifiedOn: V },
      // A section of the privacy notice rather than a document of its own: under
      // the DPDP Rules a Data Principal's rights are part of the notice, and
      // splitting them creates two texts that can disagree. Given its own row
      // because "how do I delete my data" is what a reader searches for.
      { label: 'Your data rights', href: '/legal/privacy#your-rights', verifiedOn: V },
    ],
  },
];

/**
 * The risk band above the copyright.
 *
 * Two sentences, not one. The first is the platform-boundary line the landing
 * page already carried. The second exists because F&O is TradeW's focus and
 * "markets carry risk" understates a product where a position can lose more
 * than the amount committed to it.
 */
export const FOOTER_RISK_NOTICE =
  'TradeW does not provide investment advice and does not place trades on your behalf. ' +
  'Markets carry risk, and derivatives can lose more than the amount you commit to them.';

/** Sits beside the copyright — a fact about the default, not a marketing line. */
export const FOOTER_TRUST_NOTE = 'Paper trading by default. Nothing moves real money until you connect a broker yourself.';
