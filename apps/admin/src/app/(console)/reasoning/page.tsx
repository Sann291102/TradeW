import { UnavailableState } from '@/components/UnavailableState';

export default function ReasoningPage() {
  return (
    <UnavailableState
      title="Reasoning Inspector"
      description="Full reasoning trace — agent votes, confidence, evidence and citations."
      reason="An aggregated reasoning-trace API is not yet exposed. Per-run reasoning is captured today and surfaced within individual Sentinel runs in the AI & Sentinel console."
      sections={[
        { label: 'Run selector', hint: 'Pick a run to inspect', span: 1 },
        { label: 'Reasoning steps', hint: 'Ordered steps, checks and conclusion', span: 2 },
        { label: 'Evidence & citations', hint: 'Supporting observations and knowledge links', span: 3 },
      ]}
    />
  );
}
