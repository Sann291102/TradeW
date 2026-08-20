# TradeW Footer — External Destination Research Report

**Researched:** 2026-08-20
**Method:** repository evidence first (grep across `apps/`, `packages/`,
`services/`, `docs/`, `infra/`, `.github/`, `.env.example`), then open-web search
for any TradeW-controlled public destination.
**Standing rule applied throughout:** an account is published only when TradeW's
*control* of it is evidenced. Availability of a handle, plausibility of a URL and
the existence of a same-named account are all explicitly **not** evidence.

---

## 1. Is there a canonical public domain?

**No — and this is the finding that constrains everything else.**

Every `tradew.*` string in the repository is a test fixture or a local example:

| Occurrence | What it actually is |
| --- | --- |
| `tradew.io` × 27 in `services/api/src/admin/**/*.spec.ts`, `packages/database/scripts/create-operator.ts`, `apps/admin/src/lib/operatorSession.test.ts` | Operator email fixtures in unit tests and a seed script. |
| `admin.tradew.io` in `docs/ADMIN_PORTAL_BLUEPRINT.md` | An illustrative hostname inside a design document. |
| `app.tradew.com` in `docs/handbook/22-devops.md` | An illustrative hostname inside a handbook. |
| `tradew.com` in `services/api/src/learning/learning-access.spec.ts` | A test fixture email. |
| `paper.sentinel.tradew.internal` | A synthetic *internal* execution-account identifier; not a hostname at all. |
| `FRONTEND_URL=http://localhost:3000` (`.env.example:45`) | Local development default. |

Deploy configuration confirms it. `.github/workflows/deploy.yml` addresses the
target by `SSH_HOST` (an IP or hostname supplied as a secret) and builds the web
image with `NEXT_PUBLIC_API_URL=/api`; `.github/workflows/main.yml` deploys to an
Azure Web App named `tradew`, whose public hostname is assigned by Azure. Neither
pins a branded domain.

**Consequences, all of which are load-bearing:**

1. No canonical URL, `metadataBase` or `sitemap.xml` can be emitted honestly.
   The implementation therefore reads an optional `NEXT_PUBLIC_SITE_URL` and
   emits nothing when it is unset, rather than guessing (`FOOTER_IMPLEMENTATION_SPEC.md` §7).
2. No `@domain` email address can be published — including a security contact.
3. Any social handle "verification" that would rest on a link back from the
   official site is impossible, because there is no official site to link back from.

## 2. Social and community destinations

Nothing in the repository references any social platform. The only two hits for
the entire pattern set (`x.com`, `twitter.com`, `linkedin.com`, `instagram.com`,
`youtube.com`, `discord.gg`, `discord.com/invite`, `t.me`, `slack.com`) across
every tracked file are `hooks.slack.com/services/...` placeholders inside
`docs/ADMIN_PORTAL_BLUEPRINT.md` — an internal alerting webhook design, not a
community Slack.

| Platform | Candidate | Control evidenced? | Status | Publish? |
| --- | --- | --- | --- | --- |
| X | none found | No | `EXTERNAL / NOT VERIFIED` | **No** |
| LinkedIn | none found | No | `EXTERNAL / NOT VERIFIED` | **No** |
| Instagram | `@tradewglobal` surfaced by search | **No — actively contradicted.** The account's own bio reads "Official Account of TradeWill Global"; TradeWill is an unrelated multi-regulated broker (`play.google.com/store/apps/details?id=com.tradewill.online`, support `info@tradewill.com`). | `EXTERNAL / NOT VERIFIED` + **brand collision** | **No** |
| YouTube | none found | No | `EXTERNAL / NOT VERIFIED` | **No** |
| GitHub | `github.com/sann291102/tradew` | Repository exists but is **private**; a footer link would 404 for every visitor. It is also a personal namespace, not an organisation. | `EXTERNAL / NOT VERIFIED` (for publication) | **No** |
| Discord | none found | No | `EXTERNAL / NOT VERIFIED` | **No** |
| Slack | none found | No | `EXTERNAL / NOT VERIFIED` | **No** |
| Community portal | none found | No | `MISSING` | **No** |
| Support portal | none found | No | `MISSING` | **No** |
| Public documentation | `docs/`, `knowledge/` | Exists, but is internal engineering material (admin portal blueprint, architecture, runbooks). Not a public docs site. | `PARTIAL` | **No** |
| Status page | none found | No | `MISSING` | **No** |

### 2.1 On the Instagram collision specifically

This is worth stating plainly because it is exactly the failure this audit
exists to prevent. A search for TradeW's Instagram returns a real, active,
18k-follower account at a handle a reasonable person would assume is TradeW's.
It is not. Publishing it would have sent TradeW's users to a **different
financial services company**, which is a consumer-harm and trademark exposure at
the same time, and it would have looked completely correct in review.

The same reasoning applies to any future handle discovered by search rather than
supplied by the account owner: `FOOTER_LINK_REGISTRY.md` §4 records the
verification procedure that must be completed before any of these is published.

## 3. System status

`services/api/src/control/control.controller.ts` exposes `GET system/health` and
`services/api/src/admin/admin.controller.ts` exposes `GET health`. Both sit
behind the operator boundary described in
`knowledge/Plans/2026-08-12 - Admin consolidation auth design (operator boundary).md`
and are consumed by `apps/admin`, not by the public web app.

There is therefore **no public status mechanism**. The footer does not render a
status indicator, does not say "All systems operational", and does not link to a
status page. A green dot backed by nothing is worse than no dot: it is a claim.

## 4. Security-claim verification (and two corrections)

§8 of the mission forbids unverified security claims. Auditing the claims the
product *already* makes turned up two that the implementation does not support.
Both are on the public landing page today, in `LandingPage.tsx` `const SECURITY`.

| Claim as written | Verified? | Evidence |
| --- | --- | --- |
| "End-to-end encryption in transit and at rest" | **No.** TLS in transit is real (`next.config.mjs` sets `upgrade-insecure-requests` and HSTS). Encryption **at rest is not implemented**. | `packages/database/prisma/schema.prisma:1183-1193` states in its own comment that encryption at rest "is genuinely outstanding … NOT solved by this change", and stores `accessToken String` — a broker credential — in plaintext. The originating migration `20260729010000_broker_credential/migration.sql` says the same. "End-to-end" is additionally wrong as a term of art: TradeW can read this data. |
| "Two-factor authentication, including authenticator apps" | **No.** | A repository-wide grep for `totp`, `authenticator`, `otpauth`, `speakeasy` returns **only this marketing string**. What exists is `services/api/src/auth/otp.service.ts` — one-time codes over email and SMS, hashed at rest, 10-minute TTL, 5-attempt cap. The only 2FA involving an authenticator is *Dhan's own*, performed on Dhan's site during broker consent. |
| "A single audited ingress — every request passes one policy layer" | **Yes.** | `services/api` `AuthGuard`; the same-origin proxy in `next.config.mjs`; `TRADEW-OS.md` §2.2. |
| "Session, entitlement and audit handling built into the platform core" | **Yes.** | `services/api/src/auth/auth.guard.ts`, entitlement checks in `services/api/src/learning/learning-access.spec.ts`, audit tables in the Prisma schema. |

Both unverified claims are corrected by this change — see
`FOOTER_CHANGELOG.md`. The corrected wording states what is true (TLS in
transit; email/SMS one-time codes; encryption at rest tracked and not yet
shipped) and the `/legal/security` page repeats it, because a security page that
overstates is the one page where overstating is unforgivable.

## 5. Regulatory research (India)

TradeW's markets are Indian equities, indices and F&O, so the two frameworks
that shape the legal surface are SEBI's and the DPDP regime.

### 5.1 SEBI — why the observation-only posture is a compliance position

SEBI amended the Investment Advisers Regulations 2013 and the Research Analysts
Regulations 2014 on 16 December 2024, with implementing guidelines on 8 January
2025, and issued clarifying FAQs during 2025. The material points for TradeW:

- Providing "research services" **for consideration** brings a person inside the
  Research Analyst definition and therefore inside a registration requirement.
- The scope of research services now expressly includes **model portfolios, stop-loss
  targets and trading calls**.
- A registered analyst must display a registration number and the prescribed
  disclosures and conflict-of-interest declarations.

TradeW's architectural rule — observations with cited evidence, never a buy/sell
instruction, never a price target, no AI on the order path — is what keeps its
paid intelligence surfaces outside that perimeter. That makes the rule a
**compliance boundary, not a product preference**, and it is why
`/legal/disclaimer` states it as a commitment the platform cannot quietly drop.

> Not legal advice. Whether Sentinel's paid observations fall inside the
> Research Analyst perimeter is a determination only a SEBI-qualified adviser can
> make, and it must be made before payments are switched on.
> Sources: SEBI amendment and 2025 FAQ analyses — Lexology, LKS Attorneys,
> Mondaq, Grip Invest (see §7).

### 5.2 DPDP — a dated, actionable compliance runway

The Digital Personal Data Protection Rules, 2025 were notified on **13 November
2025** (gazetted 14 November 2025), operationalising the DPDP Act, 2023. The
staging that matters:

| Date | What takes effect |
| --- | --- |
| 13 Nov 2025 | Data Protection Board and administrative provisions. |
| 13 Nov 2026 | Consent-manager registration opens. |
| **13 May 2027** | **Consent, privacy-notice and security requirements — the substantive obligations.** |

Today is 2026-08-20, so TradeW has roughly nine months. The obligations that
directly shape `/legal/privacy` and `/legal/cookies`: a notice in clear and plain
language stating the personal data collected, the purpose, how to exercise Data
Principal rights and how to complain to the Board; rights of access, correction
and erasure; breach notification; retention limits; and rules for cross-border
transfer.

`/legal/privacy` is written to that structure now so the document does not have
to be rebuilt later. The items it cannot yet answer — named Data Protection
Officer, grievance address, retention schedule, sub-processor list — are marked
in the page itself as outstanding rather than filled with plausible text.

> Sources: PIB notification release; Lexology and Privacy World analyses;
> EY and India Briefing compliance guides (see §7).

## 6. What research changed about the implementation

1. Community group **dropped entirely** rather than stubbed (§2).
2. Status indicator **not built** (§3).
3. Two live marketing security claims **corrected** (§4).
4. Legal pages structured to DPDP's notice requirements and SEBI's advice
   boundary rather than to a generic SaaS template (§5).
5. `sitemap.xml` and `metadataBase` made **conditional on a domain being
   configured**, because none is established (§1).

## 7. Sources

- [SEBI 2025 FAQs — key clarifications (Lexology)](https://www.lexology.com/library/detail.aspx?g=67c302ab-697b-4740-b5b9-a3c805206173)
- [Updated framework for Investment Advisers and Research Analysts (Lexology)](https://www.lexology.com/library/detail.aspx?g=666c5c80-23cb-4217-a261-ac19257cd5b2)
- [Key clarifications under the SEBI FAQs 2025 (LKS Attorneys)](https://www.lkslaw.com/insights/articles/key-clarifications-under-the-sebi-issued-faqs-2025)
- [Understanding SEBI's 2025 FAQs on Research Analysts (Mondaq)](https://www.mondaq.com/india/securities/1695408/understanding-sebis-2025-faqs-on-research-analysts-a-business-centric-analysis)
- [SEBI eases rules for Investment Advisers and Analysts in 2025 (Grip Invest)](https://www.gripinvest.in/blog/sebi-ia-ra-regulations)
- [Government notifies DPDP Rules, 2025 (PIB)](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190014&reg=3&lang=2)
- [DPDP Rules, 2025: operationalising consent, security and governance (Lexology)](https://www.lexology.com/library/detail.aspx?g=7e3af947-10aa-4712-bc1e-54179a613409)
- [India passes the DPDP Rules (Privacy World)](https://www.privacyworld.blog/2025/11/india-passes-the-digital-personal-data-protection-rules-ushering-in-a-new-digital-age-in-india/)
- [DPDP Act 2023 and DPDP Rules 2025 compliance guide (EY India)](https://www.ey.com/en_in/insights/cybersecurity/decoding-the-digital-personal-data-protection-act-2023)
- [DPDP Rules 2025 notified (India Briefing)](https://www.india-briefing.com/news/dpdp-rules-2025-india-data-protection-law-compliance-40769.html/)
- [Trade W / TradeWill on Google Play — the Instagram collision](https://play.google.com/store/apps/details?id=com.tradewill.online&hl=en)
- [`@tradewglobal` on Instagram — "Official Account of TradeWill Global"](https://www.instagram.com/tradewglobal/)
