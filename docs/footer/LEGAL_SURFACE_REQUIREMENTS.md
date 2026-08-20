# TradeW — Legal & Trust Surface Requirements

**Written:** 2026-08-20

> **This document is not legal advice, and neither are the pages it specifies.**
> It is an engineering requirements document written from published regulatory
> sources and from what the TradeW codebase actually does. Every page it
> specifies must be reviewed by a SEBI-qualified adviser and a DPDP-competent
> privacy counsel before TradeW takes a payment or onboards users at scale.
> §8 lists exactly what needs that review and why.

---

## 1. Starting position

Before this change the repository contained **no legal surface at all**: no
privacy policy, no terms, no cookie policy, no risk disclosure, no disclaimer
page, no security page. Verified by grep across `apps/`, `docs/` and `packages/`.

What did exist, and what these pages are built from, is a set of **enforced
product invariants** — not aspirations, but rules the architecture holds:

| Invariant | Where it is enforced |
| --- | --- |
| Observations only; never a buy/sell instruction, never a price target | `OBSERVATION_ONLY_DISCLAIMER` in `lib/sentinel/types.ts`; asserted by `SentinelContractReading.test.tsx` and `StrategyConditionsPanel.test.tsx` |
| No AI service can reach the order path | `TRADEW-OS.md` §5; Sentinel runs alongside order flow and cannot block, delay or gate it |
| Paper trading by default; real money requires a deliberate broker connection | `services/api/src/paper-execution/`; landing `#start` |
| One audited ingress; every request passes one policy layer | `services/api` `AuthGuard`; same-origin proxy in `next.config.mjs` |
| Payments are not switched on | Stated on `#pricing`; Razorpay integrated but not live |

A legal surface built on invariants the code enforces is defensible. One built on
a template is not. That is the organising principle for all seven pages.

## 2. Regulatory basis

Full research and citations: `FOOTER_RESEARCH_REPORT.md` §5.

**SEBI.** The Investment Advisers Regulations 2013 and Research Analysts
Regulations 2014 were amended on 16 December 2024, with guidelines on 8 January
2025 and clarifying FAQs during 2025. Research services provided *for
consideration* trigger a registration requirement, and the scope now expressly
covers model portfolios, stop-loss targets and trading calls. TradeW's
observation-only rule is what keeps its paid surfaces outside that perimeter,
which makes the rule a compliance boundary rather than a product preference.

**DPDP.** The Digital Personal Data Protection Rules, 2025 were notified on
13 November 2025. Substantive consent, notice and security obligations take
effect **13 May 2027** — roughly nine months from today. `/legal/privacy` is
written to the DPDP notice structure now so it is extended rather than rebuilt.

## 3. Page-by-page requirements

### 3.1 `/legal/disclaimer` — the load-bearing one

The single most important page on the surface, because it states the boundary
that keeps everything else lawful.

**Must state:** TradeW provides observations and information; TradeW does not
provide investment advice; TradeW does not guarantee outcomes; TradeW does not
represent that AI observations are always correct; TradeW does not remove the
risks of trading; no AI in the system can place, block or delay an order; TradeW
is not a SEBI-registered Investment Adviser or Research Analyst and does not hold
itself out as one.

**Must not:** soften any of the above with a marketing qualifier, or imply that
"observations" are a weaker form of advice rather than a different thing.

### 3.2 `/legal/risk-disclosure`

**Must state:** capital loss is possible; derivatives (F&O) can lose more than
the amount committed; leverage magnifies loss; past performance does not
indicate future results; paper-trading results do not transfer to live markets —
fills, slippage and psychology all differ; market data may be delayed, gapped or
wrong; a broker outage can prevent exit at any price.

**Must not:** quantify a probability of profit or loss, name an expected return,
or describe any strategy as low-risk.

### 3.3 `/legal/terms`

**Must state:** eligibility (18+, legally capable of contracting in India);
account and credential responsibility; acceptable use; that TradeW is not a
broker and does not execute trades; that broker relationships are between the
user and the broker; that intelligence surfaces are informational; subscription
terms *as they actually are* — including that payments are not switched on and
no account can be charged today; suspension and termination; limitation of
liability; governing law and jurisdiction.

**Must not:** promise availability figures, response times or SLAs that nothing
measures.

### 3.4 `/legal/privacy` — DPDP-structured

Required sections, in DPDP's own terms: what personal data is collected and why;
the lawful basis; how consent is given and withdrawn; retention; sharing and
sub-processors; cross-border transfer; security measures **as implemented**;
**Data Principal rights** (access, correction, erasure, grievance, nomination) at
`#your-rights`; how to complain to the Data Protection Board; children's data;
contact for privacy queries.

**Cannot yet be answered, and is marked outstanding on the page rather than
filled in:** the named Data Protection Officer / grievance officer, the
grievance postal address, a per-category retention schedule, and the sub-processor
list with transfer bases.

### 3.5 `/legal/cookies`

**Must state:** each browser-storage item, its purpose, its lifetime and whether
it is essential. Verified against the implementation:

| Item | Kind | Purpose | Essential? |
| --- | --- | --- | --- |
| `tw_auth` | Cookie | Routing hint the auth wall reads (`middleware.ts`); valueless, proves nothing | Yes |
| Bearer token | `sessionStorage` | The actual credential; per-tab by design (`lib/session-storage.ts`) | Yes |
| `tradew-workspace-v1` | `localStorage` | Theme and workspace-layout preference (`app/layout.tsx`) | Functional |

**Must state, because it is true and unusual enough to be worth saying:** TradeW
sets **no advertising or third-party tracking cookies**. There is no analytics
provider in the web app — `lib/analytics.ts` is a console-logging seam. Razorpay's
checkout script sets its own cookies **only during a payment**, and payments are
not switched on.

### 3.6 `/legal/security`

The page where overstating is least forgivable. It states only what was verified
in the implementation, and states the gaps.

**Verified, may be claimed:** TLS in transit with HSTS and
`upgrade-insecure-requests` (`next.config.mjs`); an enforced CSP, honestly
described including its `unsafe-inline` limitation; a single audited ingress;
one-time codes over email and SMS, stored hashed, 10-minute TTL, 5-attempt cap,
resend cooldown, no account enumeration (`services/api/src/auth/otp.service.ts`);
per-tab session isolation; Google OAuth; an operator boundary separating the
admin portal from the public app.

**NOT verified, must not be claimed:** encryption at rest — the broker
`accessToken` column is plaintext and the schema says so at
`packages/database/prisma/schema.prisma:1183-1193`; TOTP / authenticator-app 2FA
— no implementation exists; any certification (ISO 27001, SOC 2, PCI DSS);
penetration-test results; uptime or availability figures.

**Must include:** a vulnerability-reporting route. Today there is none, and the
page says so explicitly rather than printing an address that nobody reads.

### 3.7 `/legal/responsible-trading`

Grounded in a feature that already exists — the discipline surface
(`app/(workspace)/discipline`, `components/discipline/`, session budgets and
friction prompts) — so this is documentation of a real control, not a wellness
statement.

**Must state:** what the discipline tooling does; that limits are the user's own
and TradeW does not trade for them; that paper trading is the default and is the
right place to practise; plain warning signs of loss-chasing and overtrading; and
that TradeW is not a substitute for professional help where trading has become
compulsive.

## 4. Shared requirements for all seven pages

1. Publicly reachable — added to `middleware.ts` `PUBLIC_PATHS`. A legal page
   behind an auth wall is not a legal page.
2. A visible **effective date**, and a review-cadence statement.
3. Written in plain language (DPDP requires it for the notice; the rest inherit it).
4. Reachable from every other legal page — a cross-linked set, not seven silos.
5. Marked, on the page itself, as pending professional review where it is.
6. No claim that contradicts §3.6's verified list.

## 5. Where these pages differ from a standard template

| Standard template says | TradeW says | Why |
| --- | --- | --- |
| "We use cookies to improve your experience" | Names all three storage items and states that no advertising or tracking cookies are set | It is true, verifiable, and materially better than the template |
| "Your data is encrypted at rest" | "Encryption at rest is not yet implemented; the gap is tracked" | The schema says it is outstanding |
| "Two-factor authentication" | "One-time codes over email and SMS. No authenticator-app TOTP." | Nothing else exists |
| "Subject to our SLA" | No SLA is offered | Nothing measures one |
| "Contact us at privacy@…" | "No published address yet — outstanding" | Publishing an unmonitored address is worse than publishing none |
| "Past performance is not indicative…" (once, in small type) | A whole page, plus a footer band, plus paper-vs-live specifics | It is the central risk of the product |

## 6. Open items requiring a business decision (not an engineering one)

1. **A monitored contact address.** Blocks the DPDP grievance route, the
   security-disclosure route and the whole Company group.
2. **A canonical domain.** Blocks canonical URLs, sitemap, verifiable social
   accounts and any `@domain` address.
3. **The registered legal entity.** The Terms cannot name a counterparty, and
   the copyright line cannot name a legal person, until this is fixed.
4. **Governing law and jurisdiction.** Stated as India / the courts of the
   entity's seat, pending §3.
5. **SEBI determination** on whether paid Sentinel observations fall inside the
   Research Analyst perimeter. **Must be resolved before payments are switched
   on**, because "for consideration" is the trigger.

## 7. Highest-priority gap in the whole audit

**There is no way to report a security vulnerability to TradeW.**

No `security.txt`, no security address, no public tracker (the repository is
private). A researcher who finds a flaw in a platform that holds broker
credentials — currently in plaintext — has no channel but a public one. That is
a worse outcome for TradeW than the flaw.

Fix: publish one monitored address, add `/.well-known/security.txt`, and state a
disclosure window on `/legal/security`. It is hours of work and it is the single
highest-return item on this list.

## 8. What must go to a human reviewer, and why

| Page | Reviewer | The specific question |
| --- | --- | --- |
| `/legal/disclaimer` | SEBI-qualified adviser | Does the observation-only framing hold once observations are paid for? |
| `/legal/terms` | Commercial counsel | Limitation of liability, jurisdiction, and the counterparty entity |
| `/legal/privacy` | DPDP privacy counsel | Notice completeness, retention schedule, transfer basis, grievance mechanism |
| `/legal/risk-disclosure` | SEBI-qualified adviser | Sufficiency for F&O, and whether a signed acknowledgement is required |
| `/legal/cookies` | Privacy counsel | Whether consent is required for the functional `localStorage` item |
| `/legal/security` | Security lead | Confirm every claim; approve the disclosure route once one exists |
| `/legal/responsible-trading` | Product + counsel | That guidance does not become advice |

None of these pages should be treated as final. All of them are better than the
nothing that was there on 2026-08-19.
