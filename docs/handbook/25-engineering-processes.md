# Chapter 25 — Engineering Processes

**Status: 🟡.** The document-driven architecture practice and the knowledge-vault discipline are 🟢 and genuinely working. Sprint planning, incident response, and postmortems are 🔵 — they are specified here because the platform is about to need them, not because they are running.

---

## 25.0 The process philosophy

> **Process exists to make the right thing the easy thing.** A process that requires discipline to follow will be followed until the first deadline.

Three properties every process in this chapter is built for:

| | |
|---|---|
| **Cheap enough to actually happen** | A postmortem template that takes four hours produces no postmortems |
| **Producing a durable artefact** | A decision that leaves no record is a decision that gets re-litigated |
| **Bounded** | An RFC process with no time limit becomes a way to block work |

---

## 25.1 Sprint planning 🔵

### 25.1.1 The cadence

```
   TWO-WEEK SPRINTS, anchored to the Genesis phase they serve.

   Day 1     Planning        2h — commit to the sprint goal
   Daily     Async standup   written, not a meeting
   Day 5     Mid-sprint      30m — is the goal still reachable?
   Day 10    Review + retro  1h — demo what shipped, improve one thing
```

### 25.1.2 The sprint goal

**One sentence. One outcome. Not a list of tickets.**

```
   ✅ "A new user can complete the MVP loop end to end on staging."
   ✅ "Every money-touching function has test coverage."
   ✅ "The platform is deployed to staging and the deploy is boring."

   ❌ "Finish the scanner, add rate limiting, and start the admin console."
```

A sprint with three goals has no goal — when the sprint is at risk, nobody knows what to cut.

### 25.1.3 ⭐ Planning is shaped by `CLAUDE.md` Rule 3

> **"Implement in small phases; after each phase explain what/why, list changed files, remaining work, and risks. No big-bang commits."**

This is the constraint that shapes planning here, and it is enforced socially rather than mechanically — which makes it the rule most often under pressure. The mitigation is to make small phases the *path of least resistance*:

```
   □ Every sprint item decomposes into phases that each ship independently
   □ A phase that cannot ship alone is not a phase — it is a plan
   □ "Half of X" is not a phase. "X for indices only, stocks next" is.
   □ If an item cannot be decomposed, it needs an RFC, not a sprint slot
```

The paper OMS is the reference example: Phase 1 shipped MARKET/LIMIT/SL/SL_M for indices, stocks, ETFs and commodities, with option-contract orders explicitly deferred and **documented in the controller's own docstring**. That is a phase — usable, honest about its boundary, and shippable.

### 25.1.4 Capacity

```
   60%  planned feature work
   20%  debt (this handbook names ~90 items; work through them)
   10%  unplanned / support
   10%  slack — the buffer that prevents every estimate becoming a lie
```

The 20% debt allocation is not generosity. Chapters 19–22 list three critical security items, three critical DevOps items, and an entire missing test suite. Without a standing allocation, those never compete successfully against features.

### 25.1.5 Definition of Ready / Done

```
   READY                                DONE
   ─────                                ────
   □ the user/problem is named          □ merged to main
   □ acceptance criteria written        □ tests written and passing
   □ decomposed into shippable phases   □ ⚖️ compliance checked
   □ no unresolved architecture         □ docs updated
     question                           □ vault note if durable
   □ dependencies identified            □ demoed
   □ ⚖️ compliance implications known    □ deployed to staging
```

---

## 25.2 Architecture reviews 🟢

### 25.2.1 When one is required

```
   ALWAYS
     · a new service or app
     · a new arrow in the dependency graph (§5.8)
     · a new persistent store
     · a schema change touching a shared table
     · anything touching ARCH-1..4
     · ⚖️ anything changing what data leaves the system
     · a new external dependency on a vendor

   NEVER
     · a new endpoint on an existing module
     · a new UI component
     · a bug fix
     · a new dockable panel
```

### 25.2.2 The review, in order

The checklist from Chapter 5 §5.14, run in this sequence because the early questions are cheap and reject most bad designs:

```
   1. Does it add an arrow?          ← 30 seconds, catches most problems
   2. Does it duplicate a platform system?
   3. Which extraction trigger fired? (if it is a new service)
   4. ARCH-1..4 unviolated?
   5. ⚖️ Compliance implications?
   6. Blast radius when it is down?
   7. What is the rollback?
```

> **Most bad designs are bad because of one arrow that should not exist.** Catching it at the graph level takes thirty seconds; catching it at the code level takes a week.

### 25.2.3 ⭐ The output is a document, not a meeting

`CLAUDE.md` Rule 2: **architecture is decided in documents before code.**

```
   proposal  → docs/product-architecture/<TOPIC>.md
             OR an RFC (§25.3) for something smaller

   decision  → knowledge/Decisions/<date> - <title>.md
             + a row in Chapter 26
             + a link from _INDEX.md
```

This practice is already working. `ARCHITECTURE.md` was written up-front as *"approved design, not yet implemented"* — that was the method, not an apology, and it now reads *"approved design, now substantially implemented"* because the code caught up to the boundaries it set. The product-architecture documents were written for a platform where much was still unbuilt, and the boundaries have held as the code landed.

**The cost is real** and should be named: an engineer can waste a day reading a design for something that does not exist. The mitigations are the status legend in this handbook and the reconciliation note (`knowledge/Plans/2026-07-21 - Full platform and product audit.md`) that maps docs against a ground-truth code pass. **Read the audit note before the blueprints.**

---

## 25.3 The RFC process 🔵

For decisions too small for a product-architecture document and too large to make in a pull request.

### 25.3.1 When

```
   □ changing a constant that defines product behaviour
        ← SURFACE_THRESHOLD, the composite gate, signal weights
   □ adopting a new library or tool
   □ changing a coding standard
   □ amending this handbook
   □ changing a performance or security budget
   □ any decision two engineers disagree about after one conversation
```

### 25.3.2 The template

```markdown
# RFC-NNN: <title>

Status: draft | review | accepted | rejected | superseded by RFC-MMM
Author: · Date: · Deciders:

## Problem
What is wrong today. Evidence, not assertion.

## Proposal
What to do. Specific enough to implement.

## Alternatives considered
Including "do nothing". For each: why not.

## Consequences
What gets better. What gets worse. What we accept.

## Blast radius
What breaks if this is wrong. How we find out. How we undo it.

## ⚖️ Compliance / 🔒 Security
Implications, or "none, because …"

## Decision
Recorded when accepted, with the date and who decided.
```

**"Alternatives considered" including "do nothing" is the load-bearing section.** Most RFCs that should be rejected are rejected there, by their own author.

### 25.3.3 Bounded review

```
   3 business days for comment.
   Silence is assent.
   A blocking objection must propose an alternative.
```

> An RFC process with no time limit becomes a way to block work without arguing against it.

### 25.3.4 ⭐ The constitutional check

```
   Does this require amending TRADEW-OS.md to stop being a violation?
        │
        ├─ YES → STOP. Re-check the change first.
        │
        └─ NO  → proceed
```

From the reversed-Sentinel decision:

> **"A change that requires amending the constitution to stop being a violation is a signal to re-check the change."**

This is the single most useful heuristic the project has produced. It caught the Sentinel decoupling before any code shipped. If a constitutional amendment is genuinely warranted, it is a **separate RFC, reviewed on its own** — never a side effect of another change.

---

## 25.4 Bug workflow 🔵

### 25.4.1 Severity

| Sev | Definition | Response | Example |
|---|---|---|---|
| **S1** | Money-shaped numbers wrong; data loss; ⚖️ compliance breach; total outage | **immediate, drop everything** | P&L computed incorrectly; a Buy recommendation surfaced |
| **S2** | A core flow broken; ⚖️ audit gap; 🔒 security finding | same day | orders cannot be placed; audit writes failing |
| **S3** | A feature broken with a workaround | current sprint | a dashboard widget shows stale data |
| **S4** | Cosmetic; edge case | backlog | a label truncates at 1366px |

### 25.4.2 ⚠️ The special S1 class

> **A wrong number is S1 even when nothing errors.**

This system computes money-shaped numbers, and its worst failure mode is *plausible wrong output*: `applyFill`'s close-and-flip, the margin model, IST session boundaries, the composite gate. None of these throw when wrong. All of them produce a number a user will believe.

**Anything that could silently produce a wrong number is S1**, regardless of how many users are affected.

### 25.4.3 The lifecycle

```
   REPORT     symptom · reproduction · expected vs actual · severity
      ↓
   TRIAGE     confirm · assign severity · assign owner
      ↓
   REPRODUCE  ⚠️ if you cannot reproduce it, you cannot fix it.
              A "fix" for an unreproduced bug is a guess.
      ↓
   ⭐ TEST     write the FAILING test first
      ↓
   FIX        targeted edit (Rule 1) — the test now passes
      ↓
   VERIFY     the reporter confirms
      ↓
   RECORD     if it cost real time → knowledge/Gotchas/
```

### 25.4.4 ⭐ Every bug fix ships with its regression test

**No exceptions**, once the test suite exists (Chapter 21).

The vault already records bugs that will recur without one:

| Bug | Would recur during |
|---|---|
| DAY order placed Friday 16:00 expires within 3 seconds | any refactor of `todayIstSessionEnd` |
| `bid=ask=0` fills every resting BUY limit at zero | removing the "unnecessary" synthetic spread |
| Zustand persist hydration mismatch | adding any new persisted store |
| Mount-only `useEffect` in `AppFrame` | any shell refactor |

Each of those is a comment today. A comment explains; a test **enforces**.

---

## 25.5 The knowledge vault workflow 🟢

**This is the process that already works best, and it is unusual enough to be worth protecting.**

### 25.5.1 The mandatory loop

`CLAUDE.md` Rule 4, for every substantive task:

```
   1. SEARCH the vault      _INDEX.md first, then grep
   2. RETRIEVE and REUSE    do not re-derive what is written down
   3. REASON on what is genuinely new
   4. RECORD if durable     Decisions / Patterns / Gotchas / Research / Plans
   5. LINK related notes and update _INDEX.md
```

### 25.5.2 What goes where

| Folder | Contents |
|---|---|
| `Decisions/` | ADR-style — what was decided, why, what was rejected |
| `Patterns/` | reusable engineering patterns, development standards |
| `Gotchas/` | things that cost time once and must not cost it twice |
| `Research/` | verified findings from external sources |
| `Plans/` | milestones, roadmaps, implementation plans |

### 25.5.3 ⚠️ What must never go in

```
   ❌ live market data, real-time analytics, raw session transcripts
   ❌ anything already canonical in ARCHITECTURE.md or
      docs/product-architecture/  ← LINK to it, never duplicate
   ❌ market CONCEPTS  → those go in knowledge-base/ (YAML),
      which IS wired into the production runtime
```

The engineering vault is **never wired into the production runtime.** Mixing it with `knowledge-base/` would mean a 3 a.m. debugging note could be cited in a user-facing market observation.

### 25.5.4 ⭐ Correct in place; never rewrite

From the 2026-07-21 audit:

> *"Each of these was appended to in-place (not rewritten, per repo archive-don't-delete policy)."*

A stale note gets an `Update <date>` section, not a rewrite. The reversed Sentinel decision is retained in full and marked **⛔ REVERSED, do not implement** — *"retained per Rule 1 for its still-accurate ground-truth audit findings."*

**A wrong decision, retained with its reasoning, is more valuable than a deleted one** — because the next person to have the same idea finds out why it failed.

### 25.5.5 Why this works

| Property | Effect |
|---|---|
| Git-tracked | reviewable, diffable, and it travels with the code |
| One index read first | cheaper than searching, and it keeps the vault navigable |
| Mandatory before reasoning | prevents re-deriving what someone already solved |
| Browsable in-app (`/knowledge`) | knowledge that is read is knowledge that compounds |

---

## 25.6 Incident response 🔵

**Status: no plan exists.** ⚖️ DPDP breach-notification obligations require one, and it is a pre-deployment blocker (SEC-8).

### 25.6.1 Severity and roles

| Sev | Definition | Response |
|---|---|---|
| **SEV1** | ⚖️ Confirmed breach · broker credentials compromised · funds at risk · total outage | immediate, all hands, regulator clock starts |
| **SEV2** | Suspected breach · auth bypass · ⚖️ audit integrity compromised · core flow down | within 1 hour |
| **SEV3** | Degradation with a workaround · a vulnerability with no evidence of exploitation | within 1 business day |
| **SEV4** | Minor | next sprint |

```
   INCIDENT COMMANDER   decides. Does NOT debug.
   OPERATIONS LEAD      executes changes
   COMMUNICATIONS       users, ⚖️ regulator, internal
   SCRIBE               timestamps everything — the postmortem depends on it
```

For SEV3 and below one person holds all four roles. **For SEV1 they must be different people** — an incident commander who is also debugging stops commanding within ten minutes.

### 25.6.2 The runbook

```
   1. DECLARE     state the severity out loud. Start the scribe log.
   2. STABILISE   ⭐ mitigate before diagnosing.
                  Roll back. Disable the flag. Degrade the feature.
                  UNDERSTANDING WHY CAN WAIT; the user cannot.
   3. COMMUNICATE first update within 15 minutes even if it says
                  "we are investigating"
   4. DIAGNOSE    now find the cause
   5. FIX         forward-fix only if it is genuinely faster than rollback
   6. VERIFY      confirm with data, not with hope
   7. CLOSE       announce resolution
   8. POSTMORTEM  ≤5 business days, blameless
```

**Step 2 is the one that gets skipped under pressure**, by engineers who want to understand before acting. Rolling back an unclear change and diagnosing afterwards is almost always right.

### 25.6.3 ⚖️ Alignment with the alerting policy

Only five conditions page a human (Chapter 22 §22.7.3): ⚖️ audit write failures, API 5xx > 1%, Postgres unreachable, market feed down in session, disk > 85%.

**Everything else degrades gracefully and waits for business hours.** An alerting policy that pages for degradation trains people to ignore pages — which is how a real SEV1 gets missed.

---

## 25.7 Postmortems 🔵

### 25.7.1 Blameless, and what that actually means

> **Blameless does not mean "nobody made a mistake." It means the mistake was possible, and the system that permitted it is the finding.**

```
   ❌ "Priya deployed a migration that dropped a column still in use."
   ✅ "A migration dropping an in-use column reached production because
      no CI check verifies migration compatibility with the running
      release, and the deploy has no smoke test."
```

The second version produces two action items. The first produces a cautious engineer and an unchanged system.

### 25.7.2 The template

```markdown
# Postmortem: <title>
Date · Duration · Severity · Author

## Impact
Users affected. What they experienced. Data lost. Revenue.
Be specific. "Some users" is not impact.

## Timeline
All times IST, from the scribe log.
  09:14  deploy started
  09:16  first 500s (undetected — no alerting)
  09:41  user report in support
  09:44  incident declared SEV2
  09:52  rolled back to the previous tag
  09:54  recovered

## Root cause
The technical cause, and the systemic reason it was possible.

## What went well
Always fill this in. It identifies controls worth keeping.

## What went badly

## Where we got lucky
⭐ The most valuable section. Near-misses are free lessons.

## Action items
| # | Action | Owner | Due | Prevents recurrence? |
Each item must be SPECIFIC and ASSIGNED. "Improve monitoring" is not
an action item.
```

### 25.7.3 ⭐ "Where we got lucky"

The section most often omitted and most often valuable. Example, from a hypothetical version of the OPS-1 leader-lock gap:

> *"The matching engine ran on a single replica, so the missing leader lock did not cause double fills. We had not verified that a single replica was enforced — we simply had not scaled yet."*

That is a SEV1 that has not happened, identified for free.

### 25.7.4 The rules

```
   □ ≤5 business days. A postmortem written a month later is fiction.
   □ Every action item has an OWNER and a DUE DATE
   □ Action items go into the next sprint's 20% debt allocation
   □ Published internally, always
   □ ⚖️ SEV1 and SEV2 postmortems are reviewed by the compliance owner
```

---

## 25.8 Release process 🔵

### 25.8.1 The train

| Release | Genesis phases | Gate |
|---|---|---|
| v0.4 Foundations | 1, 2 | local compose green; manual MVP-loop smoke |
| v0.5 Intelligence | 8 (partial) | US-B2 and US-B4 pass; ⚖️ zero directive-language findings in 100 generated observations |
| v0.6 Knowledge | 5, 6 | the validation gate demonstrably rejects single-signal promotions |
| v0.7 Education | 4 | curriculum navigable; progress persists |
| v0.8 Deployment | — | blue-green demonstrated; **restore-from-backup rehearsed** |
| v0.9 Hardening | — | **all NFR-P targets MEASURED, not asserted** |
| v1.0 GA | 3, 9, 10, 11 | 🔒 security review passed; ⚖️ compliance review passed |

### 25.8.2 The four gates

```
   ┌─ CODE ────────────────────────────────────────────┐
   │ ✓ tests pass      ✓ coverage ≥ threshold          │
   │ ✓ typecheck       ✓ lint                          │
   ├─ ARCHITECTURE ────────────────────────────────────┤
   │ ✓ ARCH-1..4 unviolated                            │
   │ ✓ no new arrow in the dependency graph            │
   │ ✓ no duplicated platform system                   │
   ├─ ⚖️ COMPLIANCE ───────────────────────────────────┤
   │ ✓ no directive language in new copy or prompts    │
   │ ✓ disclaimers on every AI surface                 │
   │ ✓ new observations carry evidence + category      │
   ├─ OPERATIONS ──────────────────────────────────────┤
   │ ✓ migrations reversible, or forward-only by design│
   │ ✓ rollback rehearsed   ✓ runbook updated          │
   │ ✓ dashboards/alerts exist for what changed        │
   └───────────────────────────────────────────────────┘
```

### 25.8.3 ⚠️ The release-day rules

```
   □ NEVER release during market hours (09:15–15:30 IST)
     unless it is fixing something worse
   □ Never on a Friday afternoon
   □ Never with the release owner unavailable for the next 4 hours
   □ Never two risky changes in one release —
     if it breaks, you want ONE suspect
```

Rule 1 is specific to this domain and is absolute in effect: a deploy at 10:30 IST interrupts people mid-trade, and a rollback at 10:35 interrupts them again.

### 25.8.4 Post-release

```
   T+0min   deploy · smoke test · confirm health
   T+15min  check error rate, latency, feed status
   T+1h     check again. Most regressions surface here.
   T+24h    review metrics against the pre-release baseline
   T+1week  close the release; note anything for the next retro
```

---

## 25.9 The on-call rotation 🔵

**Not yet needed.** From `ARCHITECTURE.md` §8: *"don't stand up PagerDuty-style paging before there's an on-call rotation to page."*

The trigger is the first production deployment with real users. Design when it fires:

```
   □ Weekly rotation, ≥3 people (2 is not a rotation, it is a burden)
   □ Explicit handover with open-issue context
   □ ⚠️ Market hours are the critical window — 09:15–15:30 IST
   □ Escalation path documented and tested BEFORE it is needed
   □ Being paged out of hours is compensated
   □ ⭐ Every page produces either an action item or an alert-tuning change
```

That last rule prevents the failure mode where an alert fires weekly, is acknowledged weekly, and is never fixed.

---

## 25.10 Documentation maintenance

### 25.10.1 The hierarchy, and who updates what

| Document | Updated when | By |
|---|---|---|
| `TRADEW-OS.md` | constitutional amendment only, on its own RFC | architecture |
| `ARCHITECTURE.md` | a service boundary changes | architecture |
| `docs/product-architecture/*` | a pillar's design changes | product + architecture |
| **This handbook** | a standard, process, or subsystem changes materially | whoever changed it |
| `knowledge/` | every substantive task | whoever did the task |
| Code comments | with the code | the author |

### 25.10.2 The staleness problem, named

**A handbook is stale the moment it is written.** The mitigations built into this one:

```
   □ status markers on every subsystem (🟢🟡🔵⚪⛔)
   □ debt tables per chapter, with IDs
   □ "the code wins and the handbook has a bug" stated in the front matter
   □ every chapter cites file paths so a claim can be checked in seconds
   □ a mandatory review at each Genesis phase boundary
```

> ⚠️ **If you find this handbook wrong, fix it in the same PR as the change that made it wrong.** A stale handbook is worse than no handbook, because it is trusted.

### 25.10.3 Amending the handbook

```
   1. RFC if it changes a standard or a process (§25.3)
   2. ⚠️ If it contradicts TRADEW-OS.md → STOP, amend the constitution first,
      on its own RFC
   3. Targeted edit (Rule 1) — never a whole-file rewrite
   4. Add a row to the revision history in 00-front-matter.md
   5. Never delete a row; strike through and annotate superseded guidance
```

---

## 25.11 Onboarding a new engineer

```
   DAY 1     · read Chapters 1, 2 (the four rules; the ten principles)
             · get docker compose green (Appendix C)
             · ⭐ if it takes longer than 15 minutes, FILE A BUG —
               that is the point of the exercise
             · read knowledge/_INDEX.md

   WEEK 1    · Chapters 4, 5 (the map, the boundaries)
             · read knowledge/Plans/2026-07-21 - Full platform and product audit
               ⭐ read this BEFORE the 21 blueprints
             · ship one small fix end to end

   WEEK 2    · the chapter covering your first real ticket
             · Chapter 23 before your first pull request
             · pair on a review

   MONTH 1   · your subsystem's chapter in full
             · Chapter 26 (decision records) — why things are the way they are
             · ⭐ write one vault note

   ONGOING   · read a chapter when you touch its subsystem
             · Chapters 6–10 before touching anything AI
```

### 25.11.1 The onboarding buddy

Every new engineer gets one for thirty days. Their job:

- answer the questions the handbook does not
- **and then fix the handbook so it does**

That second half is the point. A question a new engineer asks is a gap in the documentation, and the thirty-day window is the only period in which someone can see the gaps clearly.

---

## 25.12 Process debt

| ID | Item | Severity | Effort |
|---|---|---|---|
| **PROC-1** | ⚖️ **No incident-response plan** (SEC-8) | **critical** | 1 day |
| PROC-2 | No postmortem practice or template | high | hours |
| PROC-3 | No RFC process running | medium | hours |
| PROC-4 | No sprint cadence formalised | medium | — |
| PROC-5 | No on-call rotation (correctly deferred) | low | trigger not fired |
| PROC-6 | No PR template (TD-14) | medium | 30 minutes |
| PROC-7 | Bug severity taxonomy not adopted | medium | hours |
| PROC-8 | No release checklist in use | medium | hours |
| PROC-9 | No onboarding buddy assignment | low | — |

### 25.12.1 What is already working

Worth stating plainly, because most of this chapter is 🔵:

- **Document-driven architecture** — 21 blueprints, a constitution, and boundaries that have held through a reversed product decision
- **The knowledge vault** — a genuinely functioning institutional memory, with the discipline to correct in place rather than rewrite
- **Archive-never-delete** — applied to code, to schema, and to decisions
- **Incremental phases** — the OMS, market data, and the workspace all shipped in documented, bounded phases
- **⭐ The constitutional check** — a heuristic that already caught a significant product misdirection before any code shipped

The gap is not architectural process, which is strong. It is **operational** process — incidents, postmortems, releases — and it is a gap precisely because nothing has ever been deployed. It closes with the first deployment, or it becomes the reason the first deployment goes badly.

---

*Next: [Chapter 26 — Decision Records](26-decision-records.md)*
