/**
 * The footer registry is a set of PUBLIC CLAIMS, so it is asserted rather than
 * eyeballed.
 *
 * This file belongs in the same category as feed-proxy-routes.spec.ts and the
 * Sentinel reading tests named in vitest.config.mjs: a mistake here is an
 * exposure, not a rendering bug. The specific exposures:
 *
 *  · An invented external URL. The audit that produced this registry found a
 *    real, active, 18k-follower Instagram account at the handle a reasonable
 *    person would assume is TradeW's — it belongs to TradeWill Global, an
 *    unrelated broker. Published, it would have looked correct in review and
 *    sent TradeW's users to a different financial company. So "no unverified
 *    external link" is a FAILING TEST here, not a code-review habit.
 *  · A footer link into the auth wall. Every workspace route redirects a
 *    signed-out reader back to `/`, and this footer's only reader is signed
 *    out, so a link to `/sentinel` is a redirect loop wearing a link's clothes.
 *  · A legal page that is not public. A privacy notice only an account holder
 *    can read is not a privacy notice.
 *  · A dead landing anchor. `/#pricing` stops resolving the moment someone
 *    renames a section, and nothing about the page looks broken afterwards.
 *
 * The last two are checked by READING SOURCE FILES at test time — middleware.ts
 * and LandingPage.tsx — rather than by duplicating their contents here. A
 * duplicate is a second thing to keep in sync; reading the real file means the
 * assertion cannot pass while the real file disagrees.
 *
 * Reviewed companion: docs/footer/FOOTER_LINK_REGISTRY.md.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FOOTER_GROUPS, FOOTER_RISK_NOTICE, type FooterLink } from './links';
import { LEGAL_SLUGS } from '@/lib/legal/documents';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const LANDING_SOURCE = read('../../components/landing/LandingPage.tsx');
const MIDDLEWARE_SOURCE = read('../../middleware.ts');

const ALL_LINKS: FooterLink[] = FOOTER_GROUPS.flatMap((g) => g.links);

describe('footer link registry', () => {
  it('renders at least one group, and no empty group', () => {
    expect(FOOTER_GROUPS.length).toBeGreaterThan(0);
    for (const group of FOOTER_GROUPS) {
      expect(group.links.length, `group "${group.heading}" is empty`).toBeGreaterThan(0);
      expect(group.heading.trim()).not.toBe('');
    }
  });

  it('has no placeholder href', () => {
    for (const link of ALL_LINKS) {
      expect(link.href.trim(), `"${link.label}" has an empty href`).not.toBe('');
      // `#` and `javascript:` are the two shapes a placeholder takes when
      // someone needs a column to look finished.
      expect(link.href, `"${link.label}" links nowhere`).not.toBe('#');
      expect(link.href.toLowerCase().startsWith('javascript:')).toBe(false);
    }
  });

  /**
   * THE GUARD. Every href is same-origin: a path, or a landing anchor. A bare
   * `https://…` in the registry fails this suite.
   *
   * This is deliberately stricter than "external links must be verified",
   * because a test cannot verify that a URL is controlled by TradeW — only a
   * person can, by the procedure in FOOTER_LINK_REGISTRY.md §4. What a test CAN
   * do is make adding one impossible by accident: publishing the first external
   * destination requires editing this assertion, which puts the question in
   * front of a reviewer instead of letting a URL slip in as a string change.
   */
  it('publishes no external destination', () => {
    for (const link of ALL_LINKS) {
      expect(
        /^https?:\/\//i.test(link.href),
        `"${link.label}" publishes an external URL (${link.href}). External destinations require ` +
          'the verification procedure in docs/footer/FOOTER_LINK_REGISTRY.md §4 — and this ' +
          'assertion has to be changed deliberately, not worked around.',
      ).toBe(false);
      expect(link.external, `"${link.label}" is flagged external but has a same-origin href`).toBeUndefined();
      expect(link.href.startsWith('/'), `"${link.label}" is not same-origin`).toBe(true);
    }
  });

  it('records a parseable verification date for every destination', () => {
    for (const link of ALL_LINKS) {
      expect(link.verifiedOn, `"${link.label}" has no verifiedOn`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(link.verifiedOn))).toBe(false);
    }
  });

  it('does not repeat a label within a group', () => {
    for (const group of FOOTER_GROUPS) {
      const labels = group.links.map((l) => l.label);
      expect(new Set(labels).size, `duplicate label in "${group.heading}"`).toBe(labels.length);
    }
  });
});

describe('internal link integrity', () => {
  /**
   * Every `/#anchor` names a section that exists in the landing page. Read from
   * source, so renaming a section id without fixing the footer fails the build
   * — which is the failure mode that produces a footer full of links that
   * scroll nowhere and look perfectly fine in a screenshot.
   */
  it('every landing anchor names a real section', () => {
    const anchors = ALL_LINKS.filter((l) => l.href.startsWith('/#')).map((l) => ({
      label: l.label,
      id: l.href.slice(2),
    }));

    expect(anchors.length, 'expected the footer to link into the landing page').toBeGreaterThan(0);

    for (const anchor of anchors) {
      expect(
        LANDING_SOURCE.includes(`id="${anchor.id}"`),
        `"${anchor.label}" points at #${anchor.id}, which no section in LandingPage.tsx declares`,
      ).toBe(true);
    }
  });

  it('every /legal href resolves to a document that exists', () => {
    const legalHrefs = ALL_LINKS.filter((l) => l.href.startsWith('/legal/'));
    expect(legalHrefs.length).toBeGreaterThan(0);

    for (const link of legalHrefs) {
      // Strip any anchor — /legal/privacy#your-rights resolves to the privacy doc.
      const slug = link.href.slice('/legal/'.length).split('#')[0]!;
      expect(LEGAL_SLUGS, `"${link.label}" points at /legal/${slug}, which has no document`).toContain(slug);
    }
  });

  it('every legal document is reachable signed out', () => {
    // The auth wall is default-deny. A legal page that is not covered by the
    // public prefix is a legal page nobody can read before signing up.
    expect(MIDDLEWARE_SOURCE).toContain("'/legal/'");

    const prefixLine = MIDDLEWARE_SOURCE.match(/const PUBLIC_PREFIXES\s*=\s*\[[^\]]*\]/);
    expect(prefixLine, 'middleware.ts no longer declares PUBLIC_PREFIXES').not.toBeNull();
    expect(prefixLine![0]).toContain("'/legal/'");

    for (const slug of LEGAL_SLUGS) {
      expect(`/legal/${slug}`.startsWith('/legal/')).toBe(true);
    }
  });

  /**
   * The registry links to `/reset`, which is gated by an explicit entry rather
   * than a prefix. If that entry ever leaves PUBLIC_PATHS the footer would be
   * offering password recovery to people the auth wall bounces first.
   */
  it('links only to routes the auth wall lets a signed-out reader reach', () => {
    const plainPaths = ALL_LINKS.map((l) => l.href.split('#')[0]!).filter(
      (p) => p !== '' && p !== '/',
    );

    for (const path of Array.from(new Set(plainPaths))) {
      const covered =
        path.startsWith('/legal/') || MIDDLEWARE_SOURCE.includes(`'${path}',`);
      expect(covered, `${path} is not public in middleware.ts — it would bounce a signed-out reader`).toBe(true);
    }
  });
});

describe('risk notice', () => {
  it('states the boundary and the derivative risk', () => {
    // Both halves are load-bearing: the first is the platform boundary, the
    // second is the fact that F&O losses are not capped at the amount committed.
    expect(FOOTER_RISK_NOTICE).toContain('does not provide investment advice');
    expect(FOOTER_RISK_NOTICE).toContain('derivatives');
  });
});
