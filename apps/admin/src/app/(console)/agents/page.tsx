import { UnavailableState } from '@/components/UnavailableState';

/**
 * Agent management — scaffolded, and honest about what would go in it.
 *
 * The previous copy advertised "Enable/disable agents, confidence thresholds,
 * prompts and versions", three of which describe capabilities that do not
 * exist anywhere in TradeW rather than capabilities `services/api` has not
 * exposed yet:
 *
 *   · thresholds are environment variables read at boot
 *     (`SI_CONFIDENCE_THRESHOLD`, `SI_REQUIRED_CORROBORATION`,
 *     `SI_REQUIRE_LIVE_PERFORMANCE`), not per-agent values,
 *   · there are no prompts to version — no agent in Sentinel uses an LLM, and
 *     the one that does in `services/tradew-ai` runs against an empty prompt
 *     library, so every `systemPromptId` is inert,
 *   · there is no enable/disable switch for an individual agent; the roster is
 *     compiled in, and the only kill switches are service-wide env flags.
 *
 * The sections below name what an operator could actually be given, so a future
 * implementation builds the real thing rather than the advertised one. See
 * `docs/product-architecture/AGENT-LAYERS.md`.
 */
export default function AgentsPage() {
  return (
    <UnavailableState
      title="Agent Management"
      description="Roster, gate configuration and per-agent run history."
      reason="Sentinel's agent roster is compiled in and its gates are environment variables read at boot, so there is nothing for a portal to write to yet — no per-agent enable switch, no per-agent threshold, and no prompt templates, because no agent uses one. Live agent state and run history ARE available today, in the AI & Sentinel console."
      sections={[
        {
          label: 'Agent roster',
          hint: 'The 16 agents that emit telemetry — 10 SentinelIntelligence reasoners plus the 6 /observe engines',
          span: 2,
        },
        {
          label: 'Gate configuration',
          hint: 'Confidence threshold, required corroboration, live-performance requirement — env-only today',
          span: 1,
        },
        {
          label: 'Per-agent run history',
          hint: 'Abstention rate, veto count, median latency and cost attribution per agent',
          span: 3,
        },
      ]}
    />
  );
}
