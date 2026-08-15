import { UnavailableState } from '@/components/UnavailableState';

export default function AgentsPage() {
  return (
    <UnavailableState
      title="Agent Management"
      description="Enable/disable agents, confidence thresholds, prompts and versions."
      reason="Agent configuration and lifecycle control is not yet exposed by services/api. Live agent state and run history are available today in the AI & Sentinel console."
      sections={[
        { label: 'Agent roster', hint: 'Name, type, status, performance, tasks', span: 2 },
        { label: 'Confidence thresholds', hint: 'Per-agent publication thresholds', span: 1 },
        { label: 'Prompt & version control', hint: 'Prompt templates, active version, rollout', span: 3 },
      ]}
    />
  );
}
