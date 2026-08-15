import { UnavailableState } from '@/components/UnavailableState';

export default function HealthPage() {
  return (
    <UnavailableState
      title="Engine Health"
      description="Per-engine status, queue depth, latency, memory, model usage and errors."
      reason="A per-engine health feed is not yet exposed by services/api. Platform-wide service health is live on the Dashboard and Users / System pages today."
      sections={[
        { label: 'Engine status', hint: 'Data, AI, Execution, Risk, Analytics engines — running/degraded/down', span: 1 },
        { label: 'Performance metrics', hint: 'CPU, memory, response time, throughput per engine', span: 2 },
        { label: 'Queue depth & model usage', hint: 'Backlog and per-model call volume', span: 3 },
      ]}
    />
  );
}
