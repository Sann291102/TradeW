# TradeW Footer — Canonical Link Registry

**The source of truth for what the footer is allowed to point at.**

This file and `apps/web/src/lib/footer/links.ts` are two views of one registry.
The TypeScript module is what ships; this file is what it is reviewed against.
`apps/web/src/lib/footer/links.test.ts` fails the build if the module drifts from
the rules stated here — specifically, if any entry marked unpublished ever
acquires a URL.

**Last verified:** 2026-08-20

---

## 1. Published — these render in production

| Name | Category | Destination | Int/Ext | Verified | Status | Auth | Purpose | Last verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Surfaces | Platform | `/#platform` | Internal | Yes | Live | Public | What the workspace contains | 2026-08-20 |
| Tara | Platform | `/#assistant` | Internal | Yes | Live | Public | The assistant, and its limits | 2026-08-20 |
| Sentinel | Platform | `/#sentinel` | Internal | Yes | Live | Public | The premium intelligence surface | 2026-08-20 |
| Learning Hub | Platform | `/#learning` | Internal | Yes | Live | Public | Curriculum overview | 2026-08-20 |
| What you get | Learn | `/#brief` | Internal | Yes | Live | Public | Product summary | 2026-08-20 |
| Getting started | Learn | `/#start` | Internal | Yes | Live | Public | What happens after sign-up | 2026-08-20 |
| Pricing | Learn | `/#pricing` | Internal | Yes | Live | Public | Full price list | 2026-08-20 |
| Our commitments | Learn | `/#intelligence` | Internal | Yes | Live | Public | The three product principles | 2026-08-20 |
| FAQ | Learn | `/#faq` | Internal | Yes | Live | Public | Common questions | 2026-08-20 |
| Sign in | Account | `/#auth` | Internal | Yes | Live | Public | Auth panel | 2026-08-20 |
| Create account | Account | `/#auth` | Internal | Yes | Live | Public | Auth panel | 2026-08-20 |
| Reset password | Account | `/reset` | Internal | Yes | Live | Public (by design) | Recovery for users who cannot sign in | 2026-08-20 |
| Privacy Policy | Legal & Trust | `/legal/privacy` | Internal | Yes | Live | Public | DPDP-structured privacy notice | 2026-08-20 |
| Terms & Conditions | Legal & Trust | `/legal/terms` | Internal | Yes | Live | Public | Contract of use | 2026-08-20 |
| Cookie Policy | Legal & Trust | `/legal/cookies` | Internal | Yes | Live | Public | What is stored on the device | 2026-08-20 |
| Risk Disclosure | Legal & Trust | `/legal/risk-disclosure` | Internal | Yes | Live | Public | Market and derivative risk | 2026-08-20 |
| Disclaimer | Legal & Trust | `/legal/disclaimer` | Internal | Yes | Live | Public | Observation-only boundary | 2026-08-20 |
| Security | Legal & Trust | `/legal/security` | Internal | Yes | Live | Public | What is and is not in place | 2026-08-20 |
| Responsible Trading | Legal & Trust | `/legal/responsible-trading` | Internal | Yes | Live | Public | Discipline tooling and limits | 2026-08-20 |
| Your data rights | Legal & Trust | `/legal/privacy#your-rights` | Internal | Yes | Live | Public | Access, correction, erasure | 2026-08-20 |

20 published destinations. Every one was opened and read on 2026-08-20.

## 2. Withheld — known, deliberately not rendered

Nothing in this table has a URL in the shipped code. The `Destination` column
records what *would* be linked once the blocker clears, so that a future
maintainer does not have to redo the research — it is not a value the
application reads.

| Name | Category | Destination | Int/Ext | Verified | Status | Auth | Purpose | Blocker | Last verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TradeW Terminal | Platform | `/trade` | Internal | Route exists | Withheld | **Authenticated** | Order surface | Signed-out readers would be bounced to `/` | 2026-08-20 |
| Research | Platform / Learn | `/research` | Internal | Route exists | Withheld | **Authenticated** | Research workspace | Same | 2026-08-20 |
| Demo Trading | Platform | — | Internal | Feature exists | Withheld | Authenticated | Paper trading | No public surface of its own; covered by Pricing | 2026-08-20 |
| Market Education | Learn | `/learning/*` | Internal | Routes exist | Withheld | **Authenticated** | Curriculum | Same | 2026-08-20 |
| Trading Glossary | Learn | — | Internal | **No** | Missing | — | Term definitions | Does not exist | 2026-08-20 |
| Blog | Learn | — | Internal | **No** | Missing | — | Editorial | Does not exist | 2026-08-20 |
| Changelog | Learn | — | Internal | **No** | Missing | — | Release history | No public changelog | 2026-08-20 |
| TradeW Community | Community | — | External | **No** | Missing | — | Peer discussion | No community exists | 2026-08-20 |
| Discord | Community | — | External | **No** | **NOT VERIFIED — DO NOT PUBLISH** | — | Chat | No account evidenced | 2026-08-20 |
| Slack | Community | — | External | **No** | **NOT VERIFIED — DO NOT PUBLISH** | — | Chat | No account evidenced | 2026-08-20 |
| X | Community | — | External | **No** | **NOT VERIFIED — DO NOT PUBLISH** | — | Announcements | No account evidenced | 2026-08-20 |
| Instagram | Community | — | External | **No** | **NOT VERIFIED — DO NOT PUBLISH — BRAND COLLISION** | — | Brand | `@tradewglobal` belongs to TradeWill Global, an unrelated broker | 2026-08-20 |
| YouTube | Community | — | External | **No** | **NOT VERIFIED — DO NOT PUBLISH** | — | Education | No account evidenced | 2026-08-20 |
| LinkedIn | Community | — | External | **No** | **NOT VERIFIED — DO NOT PUBLISH** | — | Company | No account evidenced | 2026-08-20 |
| GitHub | Community / Resources | `github.com/sann291102/tradew` | External | Repo exists, **private** | **NOT VERIFIED — DO NOT PUBLISH** | — | Source | Private repo 404s for visitors; personal namespace, not an org | 2026-08-20 |
| Contact | Company | — | Internal | **No** | Missing | — | Reach a human | No published address anywhere in the repository | 2026-08-20 |
| Careers | Company | — | Internal | **No** | Missing | — | Hiring | Does not exist | 2026-08-20 |
| Partners | Company | — | Internal | **No** | Missing | — | Partnerships | No programme | 2026-08-20 |
| Press / Media | Company | — | Internal | **No** | Missing | — | Media kit | Does not exist | 2026-08-20 |
| Affiliate / Referral | Company | — | Internal | **No** | Missing | — | Referrals | No referral model in the schema | 2026-08-20 |
| Documentation | Resources | `docs/`, `knowledge/` | Internal | Exists, **internal** | Withheld | — | Engineering docs | Publishing would expose internal architecture | 2026-08-20 |
| API / Developer resources | Resources | — | External | **No** | Not applicable | — | Public API | No API product exists | 2026-08-20 |
| Integrations | Resources | — | Internal | Features exist | Missing page | — | Dhan, Razorpay, Binance, Twelve Data | No page | 2026-08-20 |
| Supported Brokers | Resources | — | Internal | Dhan only | Missing page | — | Broker list | No page | 2026-08-20 |
| Market Data | Resources | — | Internal | Providers real | Missing page | — | Source attribution | No page (recommended next) | 2026-08-20 |
| System Status | Resources | — | External | **No** | Missing | — | Uptime | Health endpoints are operator-gated; no public status surface | 2026-08-20 |
| Feedback | Resources | — | Internal | **No** | Missing | — | Product feedback | No intake | 2026-08-20 |
| Feature Requests | Resources | — | External | **No** | Missing | — | Roadmap input | Repository is private | 2026-08-20 |
| Report a Bug | Resources | — | External | **No** | Missing | — | Defect / vulnerability intake | No public tracker and no security address | 2026-08-20 |
| Account settings | Account | `/settings` | Internal | Route exists | Withheld | **Authenticated** | Plans and preferences | Would bounce a signed-out reader | 2026-08-20 |
| Subscription | Account | `/settings` | Internal | Route exists | Withheld | **Authenticated** | Billing | Same; public equivalent is `/#pricing` | 2026-08-20 |

## 3. Rules this registry enforces

1. **No URL without evidence of control.** Not availability, not plausibility,
   not a same-named account. Control.
2. **No authenticated route in a signed-out footer.** The landing page's only
   reader is signed out; a gated link is a redirect loop wearing a link's
   clothes.
3. **No claim rendered as a link.** "System Status" implies a status mechanism.
   "API" implies an API product. Neither exists, so neither is rendered.
4. **A withheld row keeps its research.** Deleting the row would guarantee the
   next maintainer repeats the work and reaches a worse answer under deadline.
5. **`links.ts` is the only place a footer URL is written.** No component
   hardcodes one. The test in `links.test.ts` asserts this.

## 4. Verification procedure — required before publishing any external link

A destination moves from §2 to §1 only after all four steps, and only with the
`verifiedOn` field set in `links.ts`:

1. **Ownership.** The account owner (not a search engine) supplies the URL, and
   the account is administered from a TradeW-controlled credential.
2. **Cross-link.** The destination links back to TradeW's canonical domain, or
   the canonical domain links out to it. This requires a canonical domain to
   exist first — see `FOOTER_RESEARCH_REPORT.md` §1.
3. **Resolution.** The URL returns 200 for a signed-out, cookie-less client in a
   region TradeW serves. A private GitHub repository and an invite-only Discord
   both fail this step.
4. **Fitness.** The destination is active and appropriate for a financial
   audience — an abandoned account is a trust cost, not a trust signal.

Record the date in both this file and `links.ts`. Re-verify every published
external link at least every 180 days; a dead social link in a trading product's
footer reads as an abandoned company.
