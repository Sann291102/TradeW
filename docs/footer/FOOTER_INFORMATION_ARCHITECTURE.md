# TradeW Footer — Information Architecture

**Decided:** 2026-08-20

---

## 1. The constraint that sets the shape

The mission's reference IA proposes seven groups: Platform, Learn, Community,
Company, Resources, Account, Legal & Trust.

Four of those cannot be filled honestly today.

- **Community** — every candidate destination is unverified; one is an
  active brand collision (`FOOTER_RESEARCH_REPORT.md` §2).
- **Company** — no contact address, no careers, no partners, no press, no
  referral programme exists anywhere in the repository.
- **Resources** — no public docs, no API product, no status page, no tracker.
- **Account settings / Subscription** — real, but authenticated, and the
  footer's reader is signed out.

A column rendered for those groups would be a column of claims. So the shipped
IA is **four groups**, and the mission's §19 governs the choice: *a smaller
footer with verified destinations is better than a large footer full of fake
links.*

## 2. Shipped structure

```
┌──────────────────────────────────────────────────────────────────────┐
│  TradeW                        PLATFORM   LEARN   ACCOUNT   LEGAL &  │
│  An AI trading operating                                     TRUST   │
│  system. Observations only     Surfaces   What      Sign in  Privacy │
│  — never investment advice.    Tara       you get   Create   Terms   │
│                                Sentinel   Getting   account  Cookies │
│  [no social row — nothing      Learning   started   Reset    Risk    │
│   verified to put in it]       Hub        Pricing   password Disclm. │
│                                           Our                Security│
│                                           commit-            Resp.   │
│                                           ments              trading │
│                                           FAQ                Your    │
│                                                              data    │
│                                                              rights  │
├──────────────────────────────────────────────────────────────────────┤
│  TradeW does not provide investment advice and does not place trades │
│  on your behalf. Markets carry risk — trade responsibly.             │
│  Derivatives can lose more than you put in. See the Risk Disclosure.  │
├──────────────────────────────────────────────────────────────────────┤
│  © 2026 TradeW                          Paper trading by default     │
└──────────────────────────────────────────────────────────────────────┘
```

Against the mission's conceptual structure, item by item:

| Mission element | Shipped | Why |
| --- | --- | --- |
| 1. TradeW branding | Yes | Existing wordmark treatment, unchanged. |
| 2. Product description | Yes | Existing line, unchanged — it already carries the observation-only posture. |
| 3. Social / community links | **No** | Nothing verified. §19. |
| 4. Navigation columns | Yes — 4 of 7 | See §1. |
| 5. Legal links | Yes — 8 entries, all new | The substance of this change. |
| 6. Trust / status area | **Partial** | The trust half ships (Security, Responsible Trading, the disclaimer band). The **status half does not** — there is no public status mechanism, and a green dot backed by nothing is a claim (`FOOTER_RESEARCH_REPORT.md` §3). |
| 7. Risk disclaimer | Yes — extended | The existing line plus a derivatives-specific sentence and a route to the full disclosure. |
| 8. Copyright | Yes | `© {year} TradeW`, computed server-side. |

## 3. Why "Deciding" became "Learn"

The pre-existing footer named its second column **Deciding** — the questions a
visitor works through before signing up. That was a good name for a
conversion-funnel column and a poor name for the group the mission calls
**Learn**.

Its contents (What you get, Getting started, Pricing, Our commitments, FAQ) are
unchanged and still correct; only the heading moves, because *Learn* is what a
returning reader scans for. The mission's Learn group also lists Learning Hub,
Market Education, Trading Glossary, Research, Blog and Changelog — the first is
already in Platform, and the rest are `MISSING` or authenticated
(`FOOTER_ROUTE_INVENTORY.md` §3).

`Security` moved out of this column and into **Legal & Trust**, where it now
points at a real document instead of a marketing section.

## 4. Why "Data Privacy / User Rights" is a section, not a page

The mission lists it as a distinct destination. It ships as
`/legal/privacy#your-rights`.

Two reasons. Under the DPDP Rules the rights of a Data Principal — access,
correction, erasure, grievance, nomination — are part of the **notice** the
Data Fiduciary must give; splitting them into a second document creates two
places to keep synchronised and a real chance they disagree, which is the one
outcome a privacy notice must not produce. And a reader looking for "how do I
delete my data" is served better by an anchor inside the document that explains
what was collected than by a page that restates it.

The footer entry is still its own row, so the destination the mission asked for
is reachable by its own name.

## 5. Responsive behaviour

| Breakpoint | Layout |
| --- | --- |
| `< 640px` (mobile) | Brand block, then the four groups as native `<details>` accordions — **except Legal & Trust, which is always open**. Then the disclaimer band and copyright. |
| `640–1024px` (tablet) | Brand block full width; groups as a 2-column grid, all expanded. |
| `≥ 1024px` (desktop) | Brand block left; four groups in a row to its right, all expanded. |

The accordion is deliberately **not** applied uniformly. Collapsing Platform and
Learn on a phone is a convenience; collapsing Privacy, Terms and Risk Disclosure
puts a legally required destination behind an extra tap on the device most
visitors arrive on. Mission §10 asks for exactly this — "keeping legal and
essential trust links easily accessible" — and it is why the implementation uses
native `<details open>` rather than a JavaScript accordion: the open state is
declarative, server-rendered, and cannot be lost to a hydration failure.

## 6. Recommended next groups, in priority order

Each of these becomes a footer column the moment its blocker clears. None should
ship before then.

1. **Contact** — publish one monitored address. This unblocks the DPDP grievance
   route, the security-disclosure route in `/legal/security`, and the Company
   group all at once. Cheapest item with the highest trust return.
2. **System Status** — a public read-only projection of the health endpoints
   that already exist. Only then does a status indicator become truthful.
3. **Market Data attribution** — Dhan, Binance and Twelve Data are real
   dependencies; naming them is both a trust signal and, for some providers, a
   licensing obligation worth checking.
4. **Community** — only after §4 of `FOOTER_LINK_REGISTRY.md` is satisfied, and
   only for platforms TradeW will actually staff.
5. **Changelog / Blog** — real editorial surfaces, not a column heading.
