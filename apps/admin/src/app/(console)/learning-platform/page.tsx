import { UnavailableState } from '@/components/UnavailableState';

export default function LearningPlatformPage() {
  return (
    <UnavailableState
      title="Learning Platform"
      description="Courses, generated content, user progress and AI teacher analytics."
      reason="Learning-platform analytics are not yet exposed to the operator console. The trader-facing learning experience lives in apps/web; this operator view awaits its analytics API."
      sections={[
        { label: 'Training progress', hint: 'Models in training, accuracy, last run', span: 2 },
        { label: 'Recent training sessions', hint: 'Session status and outcomes', span: 1 },
        { label: 'AI teacher analytics', hint: 'Content generation and learner progress', span: 3 },
      ]}
    />
  );
}
