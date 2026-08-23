# `docs/footer/` — the footer, trust and legal surface

The audit that produced TradeW's legal surface and rebuilt its footer on a
verified link registry. Written 2026-08-20.

**The governing rule, and the reason this directory exists:**

> A footer link is a claim. Research first, verify every destination, implement
> only what is real, document everything, then test the whole surface. A smaller
> footer with verified destinations beats a large one full of fake links.

---

## 1. What is here now

| Document | Read it when |
| --- | --- |
| [`FOOTER_ROUTE_INVENTORY.md`](./FOOTER_ROUTE_INVENTORY.md) | You want to know whether a destination exists at all, and how it is classified. |
| [`FOOTER_RESEARCH_REPORT.md`](./FOOTER_RESEARCH_REPORT.md) | You are about to add an external link, or you want the evidence behind an omission. Also carries the SEBI and DPDP research and the two corrected security claims. |
| [`FOOTER_LINK_REGISTRY.md`](./FOOTER_LINK_REGISTRY.md) | **The canonical list.** What is published, what is withheld, and the four-step procedure for publishing an external destination. |
| [`FOOTER_INFORMATION_ARCHITECTURE.md`](./FOOTER_INFORMATION_ARCHITECTURE.md) | You are changing the footer's shape, groups or responsive behaviour. |
| [`LEGAL_SURFACE_REQUIREMENTS.md`](./LEGAL_SURFACE_REQUIREMENTS.md) | You are editing a legal document, or briefing a lawyer. |
| [`FOOTER_IMPLEMENTATION_SPEC.md`](./FOOTER_IMPLEMENTATION_SPEC.md) | You are touching the code. Files, component structure, a11y, SEO, test design. |
| [`FOOTER_QA_CHECKLIST.md`](./FOOTER_QA_CHECKLIST.md) | You are about to ship a change here. Re-run it. |
| [`FOOTER_CHANGELOG.md`](./FOOTER_CHANGELOG.md) | You want to know what changed and why. Append-only. |

### The code these describe

```
apps/web/src/
  lib/footer/links.ts          the registry — the ONLY place a footer URL is written
  lib/footer/links.test.ts     the guard — fails the build on an unverified destination
  lib/legal/documents.ts       seven legal documents, as data
  lib/site.ts                  "is a public origin configured?" — one answer, one place
  components/footer/SiteFooter.tsx
  components/legal/LegalDocumentView.tsx
  app/legal/layout.tsx · app/legal/[slug]/page.tsx
  app/robots.ts · app/sitemap.ts
  middleware.ts                PUBLIC_PREFIXES — why /legal/* is reachable signed out
```

## 2. The four rules that survive this audit

1. **Nothing ships without evidence of control.** Availability of a handle is
   not evidence. A same-named account is not evidence — it is the trap this
   audit actually walked into and stepped back from.
2. **No authenticated route in a signed-out footer.** It is a redirect loop
   wearing a link's clothes.
3. **No claim rendered as a link.** "System Status" claims a status mechanism.
   "API" claims an API product.
4. **Withheld destinations keep their research.** Deleting the row guarantees
   the next maintainer redoes the work under deadline and reaches a worse answer.

## 3. Forward writing plan

Documentation is written when the thing it documents becomes real, in this
order. Each row names its trigger — nothing here should be written speculatively,
which is the same discipline the footer itself is built on.

### Tier 1 — write as soon as the blocker clears (weeks)

| Document | Trigger | Contents | Also update |
| --- | --- | --- | --- |
| `CONTACT_AND_SUPPORT_SURFACE.md` | A monitored address exists | Which address, who reads it, response window, routing for privacy vs. security vs. support | Registry → publish Contact; privacy grievance section; `/legal/security` reporting section |
| `SECURITY_DISCLOSURE_POLICY.md` | Same address exists | `security.txt` contents, scope, safe-harbour statement, disclosure window, triage owner | `/legal/security`; add `/.well-known/security.txt` |
| `LEGAL_REVIEW_LOG.md` | First lawyer review completes | Document, reviewer, date, findings, what changed, what was accepted as-is | Remove the matching `pendingReview` note — **only** when the review actually happened |
| `CANONICAL_DOMAIN_AND_SEO.md` | A domain is registered and served | Canonical host, redirect map, `NEXT_PUBLIC_SITE_URL` at build time, sitemap expectations, OG image strategy | `lib/site.ts` header; deploy workflow build args |

### Tier 2 — write when the surface is built (months)

| Document | Trigger | Contents |
| --- | --- | --- |
| `STATUS_PAGE_SPEC.md` | A public projection of the health endpoints exists | What each indicator means, the measurement behind it, incident-history retention, and the wording rules that keep "operational" truthful |
| `COMMUNITY_STRATEGY.md` | A platform is chosen **and staffed** | Which platform, who staffs it, moderation policy given financial content, and how the four-step verification in the registry was satisfied |
| `SUBPROCESSOR_REGISTER.md` | Before 13 May 2027 (DPDP substantive obligations) | Named sub-processors, data categories, transfer basis, review cadence. Feeds the privacy notice's outstanding note |
| `DATA_RETENTION_SCHEDULE.md` | Same deadline | Per-category retention periods, deletion mechanism, legal-hold exceptions |
| `MARKET_DATA_ATTRIBUTION.md` | Before a Resources column exists | Providers, licence terms, required attribution wording, delay disclosures |

### Tier 3 — write when the product grows into them

`API_PUBLIC_SURFACE.md` (only if an API product is actually built),
`PRESS_KIT.md`, `AFFILIATE_PROGRAMME.md`, `ACCESSIBILITY_CONFORMANCE.md` (after a
tooled audit — the contrast and screen-reader checks left unticked in the QA
checklist belong there).

### Maintenance cadence

| Cadence | Action |
| --- | --- |
| Every change to the footer or a legal page | Re-run `FOOTER_QA_CHECKLIST.md`; append to `FOOTER_CHANGELOG.md` |
| Every 180 days | Re-verify every published destination; bump `verifiedOn` in `links.ts` **and** the registry, or withdraw the link |
| Every 12 months | Re-read all seven legal documents against what the platform now does. A legal page that has drifted from the implementation is worse than none, because it is a written claim |
| On any security change | Re-check `/legal/security` §"What is in place" and §"What is not in place" against the code. **Neither list may grow a claim without a file behind it** |

### How to add a document to this directory

1. It documents something that exists, or a requirement for something being
   built now. Not a possibility.
2. It cites the file or the source it is derived from, the way these do.
3. It states what it does **not** cover.
4. It is linked from §1 of this README in the same commit.
