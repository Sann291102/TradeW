import { UnavailableState } from '@/components/UnavailableState';

export default function AuditPage() {
  return (
    <UnavailableState
      title="Audit & Compliance"
      description="AI decisions, overrides, policy violations and user activity."
      reason="A compliance-scoring and policy-violation API is not yet exposed. The underlying auth audit trail is already live on the Users / System page; this surface will add the compliance framing on top of it."
      sections={[
        { label: 'Compliance framework', hint: 'SEBI, data privacy, security standards, risk', span: 1 },
        { label: 'Recent audit events', hint: 'Authentication, configuration and data-access events', span: 2 },
        { label: 'Policy violations & overrides', hint: 'Flagged decisions and operator overrides', span: 3 },
      ]}
    />
  );
}
