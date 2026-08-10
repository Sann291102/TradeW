# AI Conversation Lifecycle — Product Blueprint

Status: design, pre-implementation. Introduced by the direction update of 2026-08-10. Governed by [`TRADEW-OS.md`](TRADEW-OS.md) §1 ("the application is always alive") and §2.7 (knowledge is versioned, never deleted). Extends [`WORKSPACE-CONTINUITY.md`](WORKSPACE-CONTINUITY.md), which lists AI conversations as restorable state but does not say how long one lives.

## 1. The principle

**The conversation is the unit of continuity, and its unit of time is the trading day.** Within a trading day the thread is permanent: close the tab, close the laptop, come back on another device — the conversation is exactly where it was, with nothing lost. Between trading days it rolls: the day's thread is archived and a fresh one opens.

This matches how a trader actually works. A day is a coherent context — the same positions, the same levels, the same news — and carrying yesterday's running conversation into today's session is clutter, not continuity. Losing it mid-session is the failure this document exists to prevent.

## 2. The trading-day thread

```
09:00 IST   pre-open. First message of the day opens the day's thread.
    │
    │  ← reload, tab close, laptop shut, switch to phone: same thread, unchanged
    │
15:30 IST   equity close. Thread stays open — the day isn't over.
    │
23:30 IST   commodities close. Thread stays open.
    │
02:30 IST   ROLL. Thread archived. Next message opens tomorrow's thread.
```

- One active thread per user at a time. This is a continuous conversation with one assistant, not a list of chats the user has to manage.
- The thread is **created lazily**, on the first message — a user who never speaks to the AI on a given day generates no empty rows.
- **Server-owned, so it is cross-device by default.** This is the point of departure from today's client-local `workspaceStore` (`WORKSPACE-CONTINUITY.md` §7): layout state can reasonably be per-device, but a conversation cannot — an assistant that forgets what you told it when you pick up your phone is not one assistant.

## 3. Why 02:30 IST

The boundary has to fall in the gap where no Indian market is open and no user is mid-session:

| | |
|---|---|
| Equity (NSE/BSE) | 09:15–15:30, pre-open from 09:00 |
| Currency derivatives | to 17:00 |
| Commodities (MCX) | to 23:30, extended to ~23:55 during US daylight saving |
| **Roll window** | **02:30 — after every close, ~6.5 h before pre-open** |

- **Anchored to IST, always** — including for users trading crypto or US markets overnight. A single platform-wide boundary is predictable; a per-user or per-asset-class boundary means the same user's assistant rolls at different times depending on what they were looking at. Crypto is continuous and will always be cut somewhere; cutting it at the same time as everything else is the least surprising option.
- **Not market-calendar aware in v1.** The roll happens every night, weekends and holidays included, so Saturday gets its own thread. Suppressing rolls on non-trading days is a refinement, not a correctness issue (§9).
- A user still typing at 02:30 does not get their sentence cut off — the roll applies at the next message boundary, never mid-turn.

## 4. The roll: archive, never delete

At the boundary the active thread's status becomes `archived`. Nothing is destroyed — `TRADEW-OS.md` §2.7 applies to conversation history as much as to knowledge.

- Archived threads stay readable in a history view, indexed by date.
- The user can reread, search, and export them; they cannot resume writing into them. A closed day is closed.
- The archived thread keeps the persona name it was held under, even if the user has since renamed the AI (`AI-PERSONA.md` §7).

## 5. What resets, and what does not

This is the distinction that makes a daily roll feel like continuity rather than amnesia.

| Resets nightly | Persists across the roll |
|---|---|
| The active message thread | The persona name and voice settings (`AI-PERSONA.md` §8) |
| In-thread conversational context ("it", "that chart") | Onboarding profile — experience, goals, risk profile (`ONBOARDING.md` §3) |
| Quick-action chips and the thread's UI state | Long-term memory (`MemoryRecord`, Sentinel Brain) |
| | Every archived thread, searchable (§4) |

So the assistant starts each day with a clean desk and a full memory. "What did we discuss about RELIANCE last week?" is answerable; "explain that again" from yesterday is not, and the assistant says which it is rather than guessing.

**Optional carry-over.** A short, generated recap of the prior session may seed the new thread ("Yesterday you were tracking NIFTY's 24,300 level"). This is a UX enhancement, not a memory mechanism, and it is generated from the archived thread on demand — never a hidden copy of yesterday's context smuggled into today's prompt.

## 6. Schema and ownership

Two new tables, owned by **`services/api`**:

```prisma
model AiConversation {
  id           String    @id @default(cuid())
  userId       String
  tradingDay   DateTime  @db.Date        // IST-resolved; unique per user
  status       AiConversationStatus      // active | archived
  personaName  String?                   // snapshot at creation (AI-PERSONA.md §7)
  startedAt    DateTime  @default(now())
  lastMessageAt DateTime?
  archivedAt   DateTime?
  @@unique([userId, tradingDay])
}

model AiMessage {
  id             String   @id @default(cuid())
  conversationId String
  role           AiMessageRole            // user | assistant
  content        String   @db.Text
  inputMode      AiInputMode              // text | voice
  intent         String?                  // command | analysis | refusal
  actions        Json?                    // executed AssistantActions, for the trace
  complianceVerdict Json?                 // TRADEW-ASSISTANT.md §11 gate result
  createdAt      DateTime @default(now())
}
```

**Why `services/api` and not `services/tradew-ai`:** `WORKSPACE-CONTINUITY.md` §2 assigns conversation history to `services/tradew-ai`. That assignment is refined here, for three reasons — `services/tradew-ai` is specified as request-scoped and stateless (`TRADEW-ASSISTANT.md` §8), `services/api` is the only layer holding authenticated user identity (`TRADEW-OS.md` §2.2), and the shared Prisma schema already owns every adjacent AI table (`AiCallLog`, `AgentActivity`, `AgentRun`, `MemoryRecord`). Giving the reasoning runtime its own conversation store would create a second schema owner for user-scoped data, which `TRADEW-OS.md` §2.5 forbids. The reasoning runtime receives the thread it needs per request and stores nothing.

`workspace_session.open_conversation_id` (`WORKSPACE-CONTINUITY.md` §3) references `AiConversation.id` — the continuity layer keeps pointing at the conversation rather than duplicating it.

## 7. Restore flow

1. User loads the app → `services/api` resolves the current trading day and returns the active `AiConversation` (or none, if the user hasn't spoken today).
2. The dock renders the thread **lazily, when opened** — not eagerly on login (`WORKSPACE-CONTINUITY.md` §4.3, don't block first render).
3. Long threads load the most recent messages with history paged on scroll.
4. If restore fails, the dock opens empty and usable rather than blocking — best-effort, same as every other restored surface (`WORKSPACE-CONTINUITY.md` §5).

## 8. Retention

- Archived threads are retained by default and deletable by the user, per account or per thread (DPDP: the user's data is the user's to remove). User-initiated deletion is the one case that overrides §4's archive rule.
- Account deletion removes conversations with everything else.
- No raw audio is ever stored (`AI-VOICE.md` §6); a voice turn persists only as its transcript.
- Message content is user data, not training data. Any future use beyond serving the user requires separate, explicit consent.

## 9. Open items

- Whether the roll suppresses on weekends and NSE holidays, so a Saturday of reading doesn't fragment across two empty threads.
- Whether a user can pin a thread open past the boundary for a multi-day research question, or whether that belongs in Research Vault instead (`RESEARCH-VAULT.md`).
- How the roll job runs — a scheduled task in `services/api` versus n8n (`N8N-WORKFLOWS.md`). Lazy roll-on-next-message needs no job at all and may be sufficient; decide at build time.
- Thread size cap and what happens on a very long day — summarise-and-continue, or let it grow.
