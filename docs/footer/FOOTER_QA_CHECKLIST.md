# TradeW Footer — QA Checklist

**Run:** 2026-08-20 · **Commit:** the footer/trust audit branch
**Environment:** production build (`next build` + `next start`), Chromium, no
auth cookie set — i.e. exactly what a first-time visitor gets.

A box is ticked only where the check was actually executed and observed. Boxes
that could not be executed say so and say why.

---

## 1. Routes

- [x] **Every internal link resolves.** All 21 footer anchors enumerated from the
      rendered DOM; all 21 same-origin. Landing anchors asserted against the
      section ids in `LandingPage.tsx` by `links.test.ts`.
- [x] **No footer 404s.** All seven `/legal/*` routes returned **200**, and the
      landing anchors resolve to sections that exist.
- [x] **Auth behaviour is correct.** Requested with no `tw_auth` cookie:

      /legal/privacy              200
      /legal/terms               200
      /legal/cookies             200
      /legal/risk-disclosure     200
      /legal/disclaimer          200
      /legal/security            200
      /legal/responsible-trading 200
      /legal/nonsense            404   ← dynamicParams = false

- [x] **No footer link points into the auth wall.** Asserted by `links.test.ts`,
      which reads `middleware.ts` rather than duplicating it.
- [x] **The unknown-slug case 404s** rather than rendering an empty document shell.

## 2. External

- [x] **Every external URL resolves.** Vacuously — **the footer publishes zero
      external URLs**, and `links.test.ts` fails the build if one appears.
- [x] **Every social account is verified.** None is published; every candidate
      is recorded as `NOT VERIFIED — DO NOT PUBLISH` in
      `FOOTER_LINK_REGISTRY.md` §2.
- [x] **No fake accounts.** Confirmed by the negative test below.
- [x] **No placeholder URLs.** No `#`, no `javascript:`, no empty href —
      asserted.

### 2.1 The guard was negative-tested

The rule is only worth having if it fires. Two bad entries were added
temporarily — the real colliding Instagram URL, and an anchor to a section that
does not exist — and the suite was run:

```
× publishes no external destination
  → "Instagram" publishes an external URL (https://www.instagram.com/tradewglobal/).
× every landing anchor names a real section
  → "Ghost anchor" points at #does-not-exist, which no section in LandingPage.tsx declares
× links only to routes the auth wall lets a signed-out reader reach
  → https://www.instagram.com/tradewglobal/ is not public in middleware.ts
Tests  3 failed | 7 passed (10)
```

Both entries were then reverted and the suite returned to green.

## 3. Legal

- [x] Privacy reachable — `/legal/privacy`, 200, signed out
- [x] Terms reachable — `/legal/terms`, 200, signed out
- [x] Cookie policy reachable — `/legal/cookies`, 200, signed out
- [x] Risk disclosure reachable — `/legal/risk-disclosure`, 200, signed out
- [x] Disclaimer reachable — `/legal/disclaimer`, 200, signed out
- [x] Security reachable — `/legal/security`, 200, signed out
- [x] Responsible trading reachable — `/legal/responsible-trading`, 200, signed out
- [x] `#your-rights` anchor present in the rendered privacy page
- [x] Every legal page carries an effective date and a "not legal advice" notice
- [x] Every legal page cross-links to the other six

## 4. UX

- [x] **Desktop (1440×900).** Brand block left, four columns right. No
      horizontal overflow.
- [x] **Tablet (834×1112).** Brand block full width, groups in a 2×2 grid, all
      expanded. No horizontal overflow.
- [x] **Mobile (390×844).** Groups stacked with rules between them; Platform,
      Learn and Account foldable; Legal & Trust rendered as a plain list with no
      fold control at all. No horizontal overflow.
- [x] **Legal pages at 390px.** Five-column cookie table scrolls inside its own
      container; the page itself does not scroll sideways.
- [x] **Keyboard navigation.** Every link is a native `<a>`; every fold control
      is a native `<summary>`. Nothing is reachable only by pointer.
- [x] **Focus states.** `focus-visible:ring-2 ring-focus` present on all 21
      links, both fold summaries and the in-band Risk Disclosure link.
- [x] **Accessible names.** 21 links, **0 with an empty accessible name**. No
      icon-only links exist in the footer.
- [x] **Semantic structure.** One `<footer role="contentinfo">`, one
      `<nav aria-label="Footer">`, four `<ul>`s each `aria-labelledby` its own
      heading. Announced group names read `Platform`, `Learn`, `Account`,
      `Legal & Trust` — the fold caret is `aria-hidden` and the id is on the
      heading text, so it is not spoken.
- [x] **No-JavaScript.** The footer is server-rendered with every group open. It
      is outside the landing page's `Reveal` wrapper, so no legal link depends on
      an IntersectionObserver firing.
- [x] **Reduced motion.** The footer has no animation. The only transition is a
      45° caret rotation on a native disclosure, which reduced-motion users can
      still operate.
- [ ] **Colour contrast measured with a tool.** *Not executed.* Link colour is
      the design system's `text-muted` on `bg-bg`, the same pairing every
      existing surface uses, so this footer neither improves nor regresses it.
      The disclaimer band was moved up from `text-faint` to `text-muted` because
      it carries a risk warning. A system-wide contrast audit is worth doing and
      is out of scope here.
- [ ] **Screen-reader pass with a real screen reader.** *Not executed* — no
      assistive tech in this environment. Structure was verified from the
      accessibility-relevant DOM instead, as recorded above.

## 5. Engineering

- [x] **TypeScript passes.** `tsc --noEmit -p apps/web/tsconfig.json` — clean.
- [x] **Lint passes.** `next lint` — no errors. One pre-existing
      `react-hooks/exhaustive-deps` warning in `lib/assistant/useAssistant.ts`,
      untouched by this change.
- [x] **Tests pass.** `npm test -w @tradew/web` — **35 files, 611 tests, all
      passing**, including the 10 new registry assertions.
- [x] **Production build passes.** `next build` — 52 static pages, including all
      seven legal routes prerendered, plus `robots.txt` and `sitemap.xml`.

## 6. SEO

- [x] `robots.txt` served; allows `/` and `/legal/`; disallows every workspace
      route plus `/api/`, `/auth/`, `/reset`, `/login`, `/signup`.
- [x] `sitemap.xml` served and **empty**, which is correct: no public origin is
      configured, and a sitemap entry must be an absolute URL. Setting
      `NEXT_PUBLIC_SITE_URL` at build time populates it and adds the sitemap
      reference to `robots.txt`, with no code change.
- [x] Each legal page has a distinct `<title>` and `<meta name="description">`.
- [x] Each legal page emits `<link rel="canonical" href="/legal/…">` — relative,
      because no domain is established. No host is invented.
- [x] No account or workspace route is exposed to crawlers.

## 7. Analytics — specified, deliberately not wired

`lib/analytics.ts` is a console-logging seam with one call site. Emitting footer
events into it would produce noise in every user's devtools and data nowhere, so
nothing is emitted. When a real sink exists, these are the events and the call
site is `FooterLinkItem` in `SiteFooter.tsx`:

| Event | Fires on | Properties |
| --- | --- | --- |
| `footer_link_clicked` | any footer link | `group`, `label`, `href` |
| `footer_legal_clicked` | a `/legal/*` link | `document` (slug), `entry_point` |
| `footer_social_clicked` | an `external` link | `platform`, `href` — no external link exists yet |
| `footer_support_clicked` | a support destination | none exists yet |

Two of the four cannot fire today because the destinations they describe do not
exist. That is the honest state and it is worth recording rather than shipping
handlers that are permanently dead.

## 8. Follow-up work, not done here

Each of these was identified during the audit and deliberately left out of this
change. None is a defect in what shipped.

1. **A monitored contact address.** Unblocks the DPDP grievance route, the
   vulnerability-reporting route, and the Company footer group. Highest return
   per hour of anything on this list.
2. **`/.well-known/security.txt`** and a stated disclosure window, once §1 exists.
   Today a researcher who finds a flaw has no private channel.
3. **Link the legal surface from the workspace** — `/settings` is the natural
   place. Not done here because it touches an authenticated surface this audit
   did not cover.
4. **Cookie-consent decision.** Whether the functional `localStorage` items need
   consent under the DPDP Rules is a real question, and a product-wide consent
   mechanism is not a footer change.
5. **Public status surface**, projecting the health endpoints that already exist
   behind the operator boundary. Only then can the footer show a status
   indicator truthfully.
6. **A canonical domain**, which unblocks canonical URLs, the sitemap, and any
   verifiable social account.
7. **Re-verify the registry every 180 days.** `FOOTER_LINK_REGISTRY.md` §4.
