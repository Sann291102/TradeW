# TradeW Footer — Route Inventory

**Audited:** 2026-08-20 · **App:** `apps/web` (`@tradew/web`, Next.js 14 App Router)
**Auditor:** automated repository audit, verified against source. No destination in
this file was accepted on the strength of a name being plausible.

---

## 0. How the public surface is actually shaped

This is the fact that governs every classification below, and it is easy to get
wrong from memory.

`apps/web/src/middleware.ts` is a **default-deny** auth wall. The complete set of
paths reachable by a signed-out visitor today is:

| Path | Why it is public |
| --- | --- |
| `/` | The marketing landing page — the only real public surface. |
| `/reset` | Reached from an email link by someone who by definition cannot sign in. |
| `/auth/callback` | Google OAuth landing; runs before a session exists. |
| `/login`, `/signup` | Kept public only so they resolve to their `/#auth` redirect. |

Everything else — `/dashboard`, `/sentinel`, `/learning`, `/research`, `/markets`,
`/settings`, … — redirects a signed-out visitor to `/?next=…#auth`.

**Consequence for the footer.** The landing page's only reader is a signed-out
reader. A footer link to `/sentinel` is not a link to Sentinel; it is a link that
bounces the reader back to the page they are standing on. That reads as a broken
link, so the Platform and Learn groups link to *sections of the landing page*
(`#sentinel`, `#learning`) rather than to workspace routes. This is not a
shortcut — it is the only correct target for this audience.

---

## 1. Classification key

| Status | Meaning |
| --- | --- |
| `EXISTS / VERIFIED` | Route or destination exists in this repository and was read. |
| `EXISTS / NEEDS REVIEW` | Exists, but its content or access posture is wrong for a footer link. |
| `PARTIAL` | Some of the substance exists, but not as a linkable destination. |
| `MISSING` | Does not exist. Would have to be invented to be linked. |
| `NOT APPLICABLE` | Real for the product category, not real for TradeW today. |
| `EXTERNAL / VERIFIED` | Off-site, and TradeW's control of it was evidenced. |
| `EXTERNAL / NOT VERIFIED` | Off-site, and control could **not** be evidenced. Never published. |

---

## 2. Platform

| Item | Status | Evidence | Footer target |
| --- | --- | --- | --- |
| Surfaces | `EXISTS / VERIFIED` | `LandingPage.tsx:524` `<section id="platform">` | `/#platform` |
| Tara (assistant) | `EXISTS / VERIFIED` | `LandingPage.tsx:584` `id="assistant"`; name from `lib/assistant/identity.ts` | `/#assistant` |
| Sentinel | `EXISTS / VERIFIED` | `LandingPage.tsx:649` `id="sentinel"`; route `app/(workspace)/sentinel` (gated) | `/#sentinel` |
| Learning Hub | `EXISTS / VERIFIED` | `LandingPage.tsx:727` `id="learning"`; route `app/(workspace)/learning` (gated) | `/#learning` |
| TradeW Terminal | `EXISTS / NEEDS REVIEW` | `app/(workspace)/trade/page.tsx` (`Trade — TradeW Terminal`), `components/terminal/` | **Not linked.** Auth-gated with no public section of its own. Linking it would bounce. |
| Research | `EXISTS / NEEDS REVIEW` | `app/(workspace)/research/page.tsx` — gated, no landing section | **Not linked** for the same reason. |
| Demo Trading | `PARTIAL` | Paper trading is real (`FREE_PAPER_ORDERS_PER_DAY`, `DEMO_PASSES` in `@tradew/types`); described under `#pricing` and `#start`. No page of its own. | Covered by `/#pricing`. |
| Market Intelligence | `NOT APPLICABLE` | No surface by that name. Closest is Sentinel, already listed. | — |

## 3. Learn

| Item | Status | Evidence | Footer target |
| --- | --- | --- | --- |
| Getting Started | `EXISTS / VERIFIED` | `LandingPage.tsx:808` `id="start"` | `/#start` |
| Learning Hub | `EXISTS / VERIFIED` | see above | `/#learning` |
| Market Education | `PARTIAL` | Curriculum exists under `app/(workspace)/learning/[courseId]`, all auth-gated. No public index. | Covered by `/#learning`. |
| Trading Glossary | `MISSING` | No glossary route, no glossary data module. | **Not linked.** |
| Research | `EXISTS / NEEDS REVIEW` | gated route only | **Not linked.** |
| Blog | `MISSING` | No blog route, no CMS, no content collection. | **Not linked.** |
| Changelog | `MISSING` | No public changelog route. Engineering history lives in `knowledge/` and root `*.md`, which are internal. | **Not linked.** |

## 4. Community

Researched in full in `FOOTER_RESEARCH_REPORT.md` §2. Summary:

| Item | Status | Footer target |
| --- | --- | --- |
| TradeW Community | `MISSING` | Not linked |
| Discord | `EXTERNAL / NOT VERIFIED` | Not linked |
| Slack Community | `EXTERNAL / NOT VERIFIED` | Not linked |
| X | `EXTERNAL / NOT VERIFIED` | Not linked |
| Instagram | `EXTERNAL / NOT VERIFIED` — and a **brand collision** exists (`@tradewglobal` is TradeWill Global, an unrelated broker) | Not linked |
| YouTube | `EXTERNAL / NOT VERIFIED` | Not linked |
| LinkedIn | `EXTERNAL / NOT VERIFIED` | Not linked |
| GitHub | `EXTERNAL / NOT VERIFIED` — repository is private (`sann291102/tradew`) | Not linked |

**The entire Community group is therefore omitted from the footer.** Not
deferred, not stubbed — omitted, because every candidate destination in it is
unverifiable today.

## 5. Company

| Item | Status | Evidence | Footer target |
| --- | --- | --- | --- |
| About TradeW | `PARTIAL` | The landing page *is* the about surface (`#brief`, `#intelligence`). No `/about` route. | `/#brief` |
| Contact | `MISSING` | No contact route, no published support address anywhere in the repository (grep for `support@`/`contact@` returns nothing). | **Not linked.** |
| Careers | `MISSING` | No careers route, no listings source. | **Not linked.** |
| Partners | `MISSING` | No partner programme exists. | **Not linked.** |
| Press / Media | `MISSING` | No press kit, no media assets directory. | **Not linked.** |
| Affiliate / Referral | `MISSING` | No referral code model in `packages/database/prisma/schema.prisma`. | **Not linked.** |

## 6. Resources

| Item | Status | Evidence | Footer target |
| --- | --- | --- | --- |
| Documentation | `PARTIAL` | `docs/` and `knowledge/` are **internal engineering** documentation — architecture, admin blueprints, runbooks. Publishing them would put internal architecture in front of every visitor. | **Not linked.** |
| API | `NOT APPLICABLE` | `services/api` is TradeW's own private ingress, not a public developer API. There is no API product. | **Not linked.** |
| Developer resources | `NOT APPLICABLE` | Same. | **Not linked.** |
| Integrations | `PARTIAL` | Dhan (broker), Razorpay (payments, not switched on), Binance / Twelve Data (global market data). Real, but there is no integrations page. | **Not linked.** |
| Supported Brokers | `PARTIAL` | Dhan only (`services/api/src/broker/dhan-auth.service.ts`). Described on the landing page; no page of its own. | **Not linked.** |
| Market Data | `PARTIAL` | Real providers, no public attribution page. Recommended — see `FOOTER_INFORMATION_ARCHITECTURE.md` §6. | **Not linked.** |
| System Status | `MISSING` | Health endpoints exist (`services/api/src/control/control.controller.ts` `GET system/health`, `admin.controller.ts` `GET health`) but they are **operator-gated** and there is no public status surface. | **Not linked.** No "all systems operational" claim is made anywhere in the footer. |
| Feedback | `MISSING` | No feedback route or intake. | **Not linked.** |
| Feature Requests | `MISSING` | No public tracker (repository is private). | **Not linked.** |
| Report a Bug | `MISSING` | No public tracker, no security/bug intake address. | **Not linked.** See `LEGAL_SURFACE_REQUIREMENTS.md` §7 — this is the highest-value gap in the whole audit. |

## 7. Account

| Item | Status | Evidence | Footer target |
| --- | --- | --- | --- |
| Sign in | `EXISTS / VERIFIED` | `components/landing/AuthPanel.tsx` at `LandingPage.tsx:979` `id="auth"` | `/#auth` |
| Create account | `EXISTS / VERIFIED` | same panel | `/#auth` |
| Reset password | `EXISTS / VERIFIED` | `app/reset/page.tsx`, public in `middleware.ts` | `/reset` |
| Account settings | `EXISTS / NEEDS REVIEW` | `app/(workspace)/settings` — auth-gated | **Not linked.** Would bounce a signed-out reader. |
| Subscription | `EXISTS / NEEDS REVIEW` | Plans live in `/settings`; pricing is public at `#pricing` | `/#pricing` (as "Pricing") |

## 8. Legal & Trust

**Every item in this group was `MISSING` before this change.** The repository
contained no privacy policy, no terms, no cookie policy, no risk disclosure, no
disclaimer page and no security page — verified by grep across `apps/`, `docs/`
and `packages/`.

| Item | Status before | Status after | Route |
| --- | --- | --- | --- |
| Privacy Policy | `MISSING` | `EXISTS / VERIFIED` | `/legal/privacy` |
| Terms & Conditions | `MISSING` | `EXISTS / VERIFIED` | `/legal/terms` |
| Cookie Policy | `MISSING` | `EXISTS / VERIFIED` | `/legal/cookies` |
| Risk Disclosure | `MISSING` | `EXISTS / VERIFIED` | `/legal/risk-disclosure` |
| Disclaimer | `MISSING` | `EXISTS / VERIFIED` | `/legal/disclaimer` |
| Security | `MISSING` | `EXISTS / VERIFIED` | `/legal/security` |
| Responsible Trading | `MISSING` | `EXISTS / VERIFIED` | `/legal/responsible-trading` |
| Data Privacy / User Rights | `MISSING` | `EXISTS / VERIFIED` | `/legal/privacy#your-rights` (a section, not a separate document — see `FOOTER_INFORMATION_ARCHITECTURE.md` §4) |

All seven routes are added to `middleware.ts` `PUBLIC_PATHS`. A legal page behind
an auth wall is not a legal page.

---

## 9. Counts

| | Investigated | Linked | Omitted as unverifiable / non-existent |
| --- | --- | --- | --- |
| Internal | 38 | 14 | 24 |
| External | 11 | 0 | 11 |

Fourteen destinations reach production. Every one of them was opened and read.
