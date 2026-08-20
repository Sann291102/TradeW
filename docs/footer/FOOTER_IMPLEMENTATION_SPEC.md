# TradeW Footer — Implementation Spec

**App:** `apps/web` (`@tradew/web`) · Next.js 14 App Router · Tailwind + `@tradew/ui` tokens

---

## 1. Files

| Path | Role |
| --- | --- |
| `src/lib/footer/links.ts` | **The registry.** Every footer URL in the application is written here and nowhere else. |
| `src/lib/footer/links.test.ts` | Fails the build if the registry drifts from `FOOTER_LINK_REGISTRY.md` — see §5. |
| `src/components/footer/SiteFooter.tsx` | The footer. Server component. |
| `src/lib/legal/documents.ts` | The seven legal documents as structured data. |
| `src/components/legal/LegalDocument.tsx` | Shared renderer for a legal document. Server component. |
| `src/app/legal/layout.tsx` | Public shell for the legal surface. |
| `src/app/legal/[slug]/page.tsx` | Renders one document; `generateStaticParams` from the registry. |
| `src/app/robots.ts` | Public-vs-workspace crawl policy. |
| `src/app/sitemap.ts` | Emits only when a canonical domain is configured. |
| `src/middleware.ts` | `/legal/*` added to the public set. |
| `src/components/landing/LandingPage.tsx` | Footer replaced by `<SiteFooter />`; two security claims corrected. |

No new dependency. No new icon library — the one external-link glyph needed is a
seven-line inline SVG in the same style as `components/shell/icons.tsx`.

## 2. The registry module

```ts
export type FooterGroupId = 'platform' | 'learn' | 'account' | 'legal';

export interface FooterLink {
  label: string;
  href: string;
  /** Set only for off-site destinations. Forces rel/target and a labelled glyph. */
  external?: true;
  /** ISO date the destination was last opened and confirmed. */
  verifiedOn: string;
}
```

Rules the module enforces by construction:

- `href` is a same-origin path (`/…`) or a landing anchor (`/#…`). There is no
  external entry today, and `external` exists so that adding one is a deliberate,
  reviewable act rather than a string edit.
- Every entry carries `verifiedOn`. A link nobody has opened does not ship.
- Withheld destinations are **absent from the module** and recorded only in
  `FOOTER_LINK_REGISTRY.md` §2. Keeping them in code as commented-out URLs is how
  a placeholder becomes production.

## 3. Component structure

```
<footer role="contentinfo">
  <div>  brand · description · paper-trading note
  <nav aria-label="Footer">
    <details open={group.id === 'legal'} …>   ← mobile
      <summary>GROUP</summary>
      <ul><li><FooterLinkItem/></li>…</ul>
  <div>  risk disclaimer band
  <div>  © {year} TradeW · Paper trading by default
```

**One markup tree for all breakpoints.** The `<details>` elements are given
`open` and `[&>summary]:pointer-events-none` from `sm:` upward via
`sm:open:…` utilities, so tablet and desktop render an ordinary expanded column
while mobile gets a real accordion. There is no second markup tree and no
JavaScript breakpoint check — a footer must render correctly before hydration.

**Legal & Trust is `open` at every breakpoint** (`FOOTER_INFORMATION_ARCHITECTURE.md` §5).

## 4. Accessibility

| Requirement | How |
| --- | --- |
| Semantic landmark | `<footer>` with an explicit `role="contentinfo"`, one `<nav aria-label="Footer">` |
| Group labelling | Each `<ul>` is `aria-labelledby` its `<summary>`'s id, so a screen reader announces "Legal & Trust, list, 8 items" |
| Accessible names | Every link's name is its visible text. There are no icon-only links. |
| Focus states | `focus-visible:ring-2 focus-visible:ring-focus` from the design tokens, on links and on every `<summary>` |
| Keyboard | Native `<a>` and `<details>/<summary>` — both keyboard-operable with no handlers |
| Contrast | `text-muted` on `bg-bg` for links, `text-text` on hover; the disclaimer band uses `text-muted` rather than the dimmer `text-faint` it replaced, because it carries a risk warning |
| External links | `target="_blank" rel="noopener noreferrer"` plus a visible glyph *and* a visually-hidden "(opens in a new tab)" — applied by the component whenever `external` is set, so it cannot be forgotten per-link |
| Reduced motion | The footer has no animation. It is deliberately outside the landing page's `Reveal` wrapper: a legal link must never be invisible because an IntersectionObserver did not fire. |

## 5. Test

`src/lib/footer/links.test.ts`, added to the `vitest.config.mjs` allowlist, which
is an explicit list of "a mistake here is an exposure, not a rendering bug".
Publishing an unverified external destination is exactly that class of mistake.

Asserted:

1. No group is empty, and no `href` is empty, `#` or `javascript:`.
2. Every `href` is same-origin — a path or a landing anchor. **A bare
   `https://…` in the registry fails the suite.** This is the guard that makes
   "no invented social URLs" a build failure rather than a code-review habit.
3. Every entry has a `verifiedOn` that parses as a date.
4. Every landing anchor (`/#…`) names a section id that exists in
   `LandingPage.tsx`, read from source at test time — so deleting a section
   without fixing the footer fails the build.
5. Every `/legal/*` href resolves to a document in `lib/legal/documents.ts`.
6. Every legal slug appears in `middleware.ts` `PUBLIC_PATHS` — an auth-gated
   legal page fails the build.
7. No two labels collide inside one group.

That is the whole of §13 "internal link integrity" and §12 "external link
behaviour" turned into assertions, rather than a checklist someone re-walks by
hand.

## 6. Analytics

`src/lib/analytics.ts` is a console-logging seam with a single call site
(`logChartClick`). It is not an analytics implementation, and mission §16
forbids introducing a provider for this task.

**Decision: no footer events are emitted.** Adding `footer_link_clicked` to a
`console.log` seam produces noise in every user's devtools and no data anywhere.
The events named in §16 are specified in `FOOTER_QA_CHECKLIST.md` §7 so they can
be wired in one commit the day a real sink exists — that is the honest form of
"follow the existing architecture" when the existing architecture is a stub.

## 7. SEO

- `metadata` per legal page: title, description, and `alternates.canonical` set
  to the page path.
- `metadataBase` in the root layout reads `NEXT_PUBLIC_SITE_URL`. Unset — which
  is the state today — Next emits relative canonicals instead of guessing a host.
  **No domain is invented** (`FOOTER_RESEARCH_REPORT.md` §1).
- `robots.ts`: allow `/`, `/legal/*`, `/reset`; disallow `/dashboard`, `/trade`,
  `/portfolio`, `/settings`, `/profile`, `/notifications`, `/sentinel`,
  `/research`, `/learning`, `/markets`, `/news`, `/crypto`, `/forex`,
  `/discipline`, `/checkout`, `/auth/`, `/api/`. The middleware already redirects
  those for a signed-out crawler; `robots.txt` states the intent rather than
  relying on that as the only defence.
- `sitemap.ts`: returns the public routes when `NEXT_PUBLIC_SITE_URL` is set and
  an empty list when it is not, because a sitemap requires absolute URLs.

## 8. Placement

`<SiteFooter />` is rendered by `LandingPage.tsx` (replacing the inline footer)
and by `app/legal/layout.tsx`.

It is **not** added to `(workspace)/layout.tsx`. The workspace is a fixed-height
application shell — `globals.css` pins `body { overflow: hidden }` and the dock
manages its own scroll — so a marketing footer there would either be unreachable
or would break the dock's layout contract. Legal pages are reachable from
`/settings` in the workspace instead; wiring that link is listed as follow-up
work in `FOOTER_QA_CHECKLIST.md` §8 rather than done here, because it touches a
gated surface this task did not audit.

## 9. Explicitly out of scope

- No redesign of the landing page beyond the footer and the two corrected
  security claims.
- No status widget (nothing backs it).
- No social row (nothing verified).
- No cookie-consent banner. It is a real DPDP question, but it is a
  product-wide consent-management decision, not a footer change, and it is
  raised in `LEGAL_SURFACE_REQUIREMENTS.md` §6 instead of being half-built here.
