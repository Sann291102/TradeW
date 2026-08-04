import { LessonClient } from '@/components/learning/LessonClient';

export const metadata = { title: 'Lesson — TradeW Learning' };

/** Restored 2026-08-04. Generated lesson viewer. `courseId` + `conceptId` compose the lesson id. */
export default function LessonPage({ params }: { params: { courseId: string; conceptId: string } }) {
  return <LessonClient courseId={params.courseId} conceptId={params.conceptId} />;
}
