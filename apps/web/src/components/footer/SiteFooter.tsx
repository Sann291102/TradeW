import Link from 'next/link';
import {
  FOOTER_GROUPS,
  FOOTER_RISK_NOTICE,
  FOOTER_TRUST_NOTE,
  type FooterGroup,
  type FooterLink,
} from '@/lib/footer/links';

/**
 * The site footer — landing page and legal surface.
 *
 * A SERVER component with no state, no effects and no animation. That is
 * deliberate on all three counts: this footer carries the only route to the
 * privacy notice, the terms and the risk disclosure, and a legally required
 * destination must not depend on hydration, on an IntersectionObserver firing,
 * or on JavaScript running at all. It is also why it sits OUTSIDE the landing
 * page's `Reveal` wrapper, which hides its children until observed — a pattern
 * that already once left a sign-in form invisible (see LandingPage.tsx).
 *
 * ── WHAT IS NOT HERE, AND WHY ──────────────────────────────────────────────
 *
 * No social row. No status indicator. No Community, Company or Resources
 * column. None of those was cut for space: every candidate destination in them
 * was researched and none could be verified. TradeW controls no evidenced
 * public account, has no published contact address, and has no public status
 * mechanism — the health endpoints that exist are operator-gated, so a green
 * "all systems operational" dot would be a claim backed by nothing.
 *
 * The Instagram case is the one worth remembering when someone proposes adding
 * a social row: the handle a reasonable person would assume is TradeW's belongs
 * to TradeWill Global, an unrelated broker with 18k followers. It would have
 * passed review and sent TradeW's users to a different financial company.
 *
 * Full audit: docs/footer/FOOTER_RESEARCH_REPORT.md.
 * The links themselves: lib/footer/links.ts — the only place a footer URL is
 * written, asserted by lib/footer/links.test.ts.
 *
 * ── RESPONSIVE ─────────────────────────────────────────────────────────────
 *
 * ONE markup tree at every breakpoint, and no breakpoint check in JavaScript,
 * because a footer has to be right before hydration. Groups that may fold are
 * native `<details>` elements rendered OPEN — a phone reader can fold them
 * away, and nobody ever meets a collapsed one, so no link is hidden by default
 * at any width or with scripting off. From `sm:` up the summary stops
 * responding to a pointer and reads as an ordinary column heading.
 *
 * Legal & Trust is not a `<details>` at all. Collapsing Platform on a phone is
 * a convenience; making the risk disclosure foldable puts a legally required
 * destination one tap from disappearing on the device most visitors arrive on.
 * The only way to guarantee it cannot fold — for a pointer, a keyboard, or a
 * stylesheet that fails to load — is to not give it a control that folds it.
 */

/** External-link glyph, in the stroke style of components/shell/icons.tsx. */
function ExternalGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={11}
      height={11}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="ml-1 inline-block shrink-0 align-baseline"
    >
      <path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4" />
    </svg>
  );
}

const LINK_CLASS =
  'rounded-sm text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

function FooterLinkItem({ link }: { link: FooterLink }) {
  // The external treatment is applied here, as one unit, rather than per call
  // site — target, rel, the glyph and the spoken "opens in a new tab" travel
  // together so none of them can be forgotten for an individual link. Nothing
  // sets `external` today; this exists so the first one that does is safe.
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
        {link.label}
        <ExternalGlyph />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }

  // next/link for same-origin navigation, including the `/#anchor` hrefs — Next
  // handles the hash on the current route without a full reload.
  return (
    <Link href={link.href} className={LINK_CLASS}>
      {link.label}
    </Link>
  );
}

/**
 * One navigation group.
 *
 * Two renderings, chosen by `alwaysOpen` rather than by breakpoint:
 *
 *  · A group that MAY collapse is a native `<details>/<summary>`. It is
 *    server-rendered `open`, so nothing is ever hidden from a reader without
 *    JavaScript; on a phone the reader can fold it away, and from `sm:` up the
 *    summary is styled and behaves as a plain column heading.
 *  · Legal & Trust is a plain heading and list — NOT a disclosure widget at
 *    all. It is the one group that must never be foldable, by anyone, at any
 *    width, including by a keyboard user who tabs onto a summary and presses
 *    Enter. The way to guarantee that is to not give it a summary.
 */
function FooterColumn({ group }: { group: FooterGroup }) {
  const headingId = `footer-group-${group.id}`;
  const headingClass =
    'text-fs2xs font-semibold uppercase tracking-wideTrack text-faint';
  const listClass = 'mt-4 space-y-2.5 text-fsXs';

  const items = group.links.map((link) => (
    <li key={`${link.label}-${link.href}`}>
      <FooterLinkItem link={link} />
    </li>
  ));

  if (group.alwaysOpen) {
    return (
      <div className="border-t border-border py-3 sm:border-t-0 sm:py-0">
        <h3 id={headingId} className={headingClass}>
          {group.heading}
        </h3>
        <ul aria-labelledby={headingId} className={listClass}>
          {items}
        </ul>
      </div>
    );
  }

  return (
    <details open className="group border-t border-border py-3 sm:border-t-0 sm:py-0">
      <summary
        className={`flex cursor-pointer list-none items-center justify-between rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:cursor-default sm:pointer-events-none ${headingClass}`}
      >
        {/* The id sits on the TEXT, not on the <summary>, so the list's
            aria-labelledby resolves to "Platform" and not "Platform+". The
            caret is aria-hidden and a correct accessible-name computation would
            skip it either way, but pointing at the text removes the question. */}
        <span id={headingId}>{group.heading}</span>
        {/* The fold affordance. Hidden from `sm:` up, where the summary no
            longer responds to a pointer — a caret that does nothing is a
            broken affordance, and a caret is the only thing that made this
            look foldable in the first place. */}
        <span
          aria-hidden="true"
          className="text-fsXs font-normal text-teal transition-transform duration-panel group-open:rotate-45 sm:hidden"
        >
          +
        </span>
      </summary>

      <ul aria-labelledby={headingId} className={`${listClass} pb-2 sm:pb-0`}>
        {items}
      </ul>
    </details>
  );
}

export function SiteFooter() {
  // Server-rendered, so this is the deploy's year rather than the visitor's
  // clock — which is what a copyright line should assert.
  const year = new Date().getFullYear();

  return (
    <footer role="contentinfo" className="border-t border-border px-6 py-14">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 lg:flex-row lg:justify-between">
        <div className="max-w-xs">
          <span className="text-lg font-extrabold text-navy">
            Trade<span className="text-teal">W</span>
          </span>
          <p className="mt-3 text-fs2xs leading-normal2 text-muted">
            An AI trading operating system. Observations only — never investment advice.
          </p>
          <p className="mt-3 text-fs2xs leading-normal2 text-faint">{FOOTER_TRUST_NOTE}</p>
        </div>

        {/* One <nav> for the whole link set, not one per column: a screen
            reader user wants a single "Footer" landmark containing four labelled
            lists, not four landmarks with the same name. */}
        <nav
          aria-label="Footer"
          className="grid grid-cols-1 gap-x-14 gap-y-0 sm:grid-cols-2 sm:gap-y-10 lg:flex lg:flex-wrap"
        >
          {FOOTER_GROUPS.map((group) => (
            <FooterColumn key={group.id} group={group} />
          ))}
        </nav>
      </div>

      {/* The risk band. `text-muted` rather than the dimmer `text-faint` this
          replaced — it carries a warning about losing more money than you put
          in, and that is not fine print. */}
      <div className="mx-auto mt-12 max-w-6xl border-t border-border pt-6">
        <p className="text-fs2xs leading-normal2 text-muted">
          {FOOTER_RISK_NOTICE}{' '}
          <Link
            href="/legal/risk-disclosure"
            className="rounded-sm text-teal underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Read the full Risk Disclosure
          </Link>
          .
        </p>
        <p className="mt-4 text-fs2xs text-faint">© {year} TradeW. All rights reserved.</p>
      </div>
    </footer>
  );
}
