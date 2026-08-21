# workflows/ 🟡

Version-controlled JSON exports of the n8n workflows TradeW actually runs. The n8n engine itself (`n8n-master`) stays vendored and out-of-tree per the consolidation plan — this folder is just the workflow *definitions*, so changes to them go through code review and CI deployment instead of being edited invisibly inside a running n8n instance.

**Planned workflows** (internal ops automation only — never customer-facing trade logic, never anything on the sub-150ms trading hot path):
- Alert fanout across channels (email/Slack/push), triggered by `services/notification`
- KYC document processing, triggered by `services/api` on new signup
- EOD (end-of-day) report generation
- On-call incident paging

**Direction of calls:** TradeW services trigger a workflow via webhook; a running workflow calls back into `services/api` using a service-scoped credential (never an end-user JWT) to actually take action. See ARCHITECTURE.md §5.

**Status:** empty — no exports exist, and **no orchestration in TradeW passes through n8n**, despite `../docs/product-architecture/AGENT-ARCHITECTURE.md` §3 assigning n8n the background-sequencing role. That role is currently filled in-process by raw `setInterval` timers under Nest lifecycle hooks: `MarketWatchService`, `OutcomeLearningService` and `AdaptiveCalibrationService` in `services/sentinel`, and `IngestionQueueService`. Populate this once the first real ops workflow (alert fanout is the natural first candidate) is built in the n8n instance.
