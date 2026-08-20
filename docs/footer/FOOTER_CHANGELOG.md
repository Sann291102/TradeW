# TradeW Footer & Trust Surface — Changelog

Append-only. Newest first. Every entry names what changed, why, and what was
deliberately not changed.

---

## 2026-08-20 — Legal & trust surface created; footer rebuilt on a verified registry

### Added

- **Seven public legal documents**, where there were none:
  `/legal/privacy`, `/legal/terms`, `/legal/cookies`, `/legal/risk-disclosure`,
  `/legal/disclaimer`, `/legal/security`, `/legal/responsible-trading`.
  Authored as structured data (`lib/legal/documents.ts`) and rendered by one
  server component, so every heading gets a stable anchor and the document set
  is enumerable by the test suite.
- **`/legal/` added to the middleware public prefix set.** A legal page behind
  an auth wall is not a legal page. Asserted by test.
- **A canonical footer link registry** (`lib/footer/links.ts`) — the only place
  in the application a footer URL is written.
- **`SiteFooter`** — a server component with no state, no effects and no
  animation, rendered by the landing page and by the legal layout.
- **A build-failing guard** (`lib/footer/links.test.ts`, 10 assertions, added to
  the `vitest.config.mjs` allowlist) covering: no external URL without the
  documented verification procedure; no placeholder href; no link into the auth
  wall; every landing anchor names a real section, read from `LandingPage.tsx`
  at test time; every `/legal/*` href has a document; every legal document is
  public in `middleware.ts`, read from that file at test time.
- **`robots.ts`** — allows `/` and `/legal/`, disallows every workspace route.
- **`sitemap.ts`** and a conditional **`metadataBase`**, both driven by an
  optional `NEXT_PUBLIC_SITE_URL`.
- **`lib/site.ts`** — the one place the "is there a public origin?" question is
  answered, returning `null` when there is not.
- **Eight audit documents** under `docs/footer/`.

### Changed

- Footer group **"Deciding" → "Learn"**, same contents. "Deciding" named a
  conversion funnel; "Learn" names what a returning reader scans for.
- **Security** moved from the Learn column into **Legal & Trust**, where it now
  points at a document instead of a marketing section.
- The risk band gained a second sentence about derivative losses and a link to
  the full Risk Disclosure, and moved from `text-faint` to `text-muted` — it
  carries a warning about losing more than you commit, which is not fine print.
- A copyright line and a paper-trading-by-default note were added.

### Corrected — two published security claims the code does not support

Found while auditing TradeW's existing claims under mission §8, in
`LandingPage.tsx` `const SECURITY`, live on the public landing page:

| Was | Now | Why |
| --- | --- | --- |
| "End-to-end encryption in transit and at rest" | "Encryption in transit — TLS everywhere, with strict transport security enforced" | Encryption at rest is **not implemented**. `packages/database/prisma/schema.prisma:1183-1193` stores a broker `accessToken` in plaintext and says in its own comment that encryption at rest "is genuinely outstanding … NOT solved by this change". "End-to-end" was also wrong as a term of art — TradeW can read this data. |
| "Two-factor authentication, including authenticator apps" | "One-time sign-in codes over email and SMS, stored hashed, expiring, and rate-limited" | A repository-wide grep for `totp`, `authenticator`, `otpauth`, `speakeasy` returned **only that marketing string**. What exists is `services/api/src/auth/otp.service.ts`. The only authenticator-app step in the product is Dhan's own, on Dhan's site. |

The FAQ answer "What happens to my data?" repeated the at-rest claim and was
corrected the same way; it now points at the Privacy Policy and the Security
page. The security section's footnote now links to `/legal/security`, which
lists the gaps as well as the controls.

### Deliberately NOT added

Each of these was researched, and each is recorded with its evidence in
`FOOTER_LINK_REGISTRY.md` §2.

- **No social links at all.** No X, LinkedIn, Instagram, YouTube, GitHub,
  Discord or Slack account could be evidenced as TradeW-controlled. The
  Instagram search result — `@tradewglobal`, real, active, 18k followers —
  belongs to **TradeWill Global, an unrelated broker**. Publishing it would have
  passed review and sent TradeW's users to a different financial company.
- **No status indicator and no status link.** The health endpoints that exist
  are operator-gated. "All systems operational" backed by nothing is a claim.
- **No Community, Company or Resources column.** No community, no published
  contact address, no careers, no partners, no press kit, no referral programme,
  no public docs site, no API product, no tracker. A column of headings with
  nothing real behind them is worse than no column.
- **No Contact link.** There is no monitored address anywhere in the
  repository. An unread address is worse than an absent one.
- **No "Documentation" link.** `docs/` and `knowledge/` are internal
  engineering material; publishing them would put TradeW's architecture in front
  of every visitor.
- **No footer analytics events.** `lib/analytics.ts` is a console-logging stub;
  emitting into it would produce devtools noise and no data. Events specified in
  `FOOTER_QA_CHECKLIST.md` §7 for the day a real sink exists.
- **No invented domain.** Canonicals are relative and the sitemap is empty until
  `NEXT_PUBLIC_SITE_URL` is configured at build time.
- **No cookie-consent banner.** A real DPDP question, but a product-wide consent
  decision rather than a footer change. Raised in
  `LEGAL_SURFACE_REQUIREMENTS.md` §6.
- **No footer in the workspace shell.** `(workspace)/layout.tsx` is a
  fixed-height application shell with its own scroll model; a marketing footer
  there would be unreachable or would break the dock's layout contract.

### Verification

TypeScript clean · lint clean (one pre-existing unrelated warning) · 611 tests
passing across 35 files · production build green, 52 static pages · all seven
legal routes 200 with no auth cookie, unknown slug 404 · footer checked at
1440 / 834 / 390 px with no horizontal overflow at any width · 21 links, none
with an empty accessible name · the link guard negative-tested and observed to
fail on a real colliding URL. Detail in `FOOTER_QA_CHECKLIST.md`.

### Known gaps carried forward

1. No monitored contact address — blocks the DPDP grievance route, the
   vulnerability-disclosure route, and the Company group.
2. **No way to report a security vulnerability.** Highest-priority item in the
   whole audit; a platform holding plaintext broker credentials with no private
   disclosure channel leaves a researcher only a public one.
3. No canonical domain — blocks canonical URLs, the sitemap and social
   verification.
4. No named contracting entity — the Terms cannot name a counterparty.
5. All seven legal documents are pending professional review; each says so on
   the page itself. `LEGAL_SURFACE_REQUIREMENTS.md` §8 maps document to reviewer.
