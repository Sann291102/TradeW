# n8n Workflow Catalog

Status: design, pre-implementation. Governed by [`TRADEW-OS.md`](TRADEW-OS.md) §3. Extends `ARCHITECTURE.md` §5 (the integration pattern: n8n stays out-of-tree, `workflows/` holds versioned JSON exports, calls are TradeW→n8n webhook triggers and n8n→TradeW service-scoped callbacks, nothing on the trading hot path routes through n8n) with the concrete workflow list the Genesis v2 brief asks for. Each row is a candidate workflow to build in `workflows/`, not yet implemented.

**Orchestration, not logic (direction update §14, `TRADEW-OS.md` §3).** n8n *sequences and coordinates agents* (`AGENT-ARCHITECTURE.md`) — it never contains reasoning. Every workflow below either fires on an event, coordinates a background agent sequence by *calling* agents' `POST /agents/:name/invoke` contracts, or performs an ops action. Any business/reasoning logic lives in the agents, never in an n8n function node. The Continuous Learning Pipeline is the archetype: n8n owns the Market→Research→Historical→News→Validation *sequence, retries, and scheduling*; the agents own what each step actually decides.

| Workflow | Trigger | Direction | Purpose |
|---|---|---|---|
| Welcome / auth emails | new signup, password reset | TradeW → n8n | transactional email via n8n's email nodes |
| Sentinel alert fanout | `services/sentinel` observation crosses a user-configured threshold | TradeW → n8n | email/Slack/push fanout, reuses `services/notification`'s existing trigger pattern |
| Learning Hub content published | new lesson passes validation (`CONTINUOUS-LEARNING-PIPELINE.md`) | TradeW → n8n | notify subscribed users of new content |
| News ingestion | scheduled (cron) | n8n → TradeW | pulls news feed into `services/market-data`'s news store, feeding both TradeW AI's News Analysis agent and the learning pipeline's News Research Agent |
| Knowledge Graph validation orchestration | pipeline candidate node created | TradeW → n8n → TradeW | optional: if the Validation Engine's multi-agent corroboration (`CONTINUOUS-LEARNING-PIPELINE.md` §2) benefits from n8n's fan-out/wait-for-all nodes rather than being purely in-process — evaluate at build time, not decided here |
| EOD market snapshot | scheduled, end of trading day | n8n → TradeW | triggers `services/analytics` end-of-day aggregation |
| Daily Demo Reset | scheduled, midnight IST | n8n → TradeW | resets `demo_order_counter` (`SUBSCRIPTIONS.md` §5) via a service-scoped callback to `services/api` |
| Subscription billing reminders | scheduled, N days before entitlement `expires_at` | n8n → TradeW | reads `entitlements` table (read-only service credential), sends renewal reminder |
| Payment webhook handling | payment provider webhook | external → n8n → TradeW | verifies provider signature, calls `services/api` to write a verified `billing_transactions` row and update `entitlements` — `services/api` never trusts a client-reported payment (`SUBSCRIPTIONS.md` §6) |
| Usage tracking rollups | scheduled | n8n → TradeW | periodic aggregation job, not on the hot path |
| On-call incident paging | alert from observability stack (`ARCHITECTURE.md` §8) | external → n8n | ops-facing, not customer-facing |
| KYC document processing | new KYC doc uploaded | TradeW → n8n → TradeW | already listed as an existing example in `ARCHITECTURE.md` §5 — included here for completeness, not new |

## Explicitly NOT n8n

Per `ARCHITECTURE.md` §5's direction rule, restated because the brief's list ("Authentication, TradeW AI, Voice Commands, Navigation, Sentinel, ...") could be misread as "build all of these as n8n workflows":

- **TradeW AI request/response** — real-time, user-facing, sub-second-latency-sensitive; stays entirely inside `services/tradew-ai`'s request path (`TRADEW-AI.md`, `TRADEW-ASSISTANT.md`). n8n is for minutes-scale ops automation, not the conversational hot path.
- **Voice Commands / Navigation intent resolution** — same reasoning, see `TRADEW-ASSISTANT.md` §6.
- **Sentinel's real-time `observe()` loop** — stays in-process (`SENTINEL.md`); only the *alert fanout* once Sentinel has already produced an observation goes through n8n, not the observation logic itself.
- **Market data ticks, order execution** — explicitly excluded by `ARCHITECTURE.md` §5.
