import { UnavailableState } from '@/components/UnavailableState';

export default function RulesPage() {
  return (
    <UnavailableState
      title="TradingView Rule Management"
      description="Learned rules, approval workflow, rollback and version history."
      reason="A rule-management API is not yet exposed by services/api. This surface will manage learned trading rules once that capability comes online."
      sections={[
        { label: 'Rules', hint: 'Name, type, status, conditions, actions, priority', span: 2 },
        { label: 'Approval workflow', hint: 'Pending, approved, rejected', span: 1 },
        { label: 'Version history & rollback', hint: 'Change log and one-click rollback', span: 3 },
      ]}
    />
  );
}
