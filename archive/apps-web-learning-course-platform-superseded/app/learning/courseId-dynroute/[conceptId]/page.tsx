import { LessonClient } from './LessonClient';

export const metadata = { title: 'Lesson — TradeW Learning' };

/** Generated lesson viewer. `courseId` + `conceptId` compose the lesson id. */
export default function LessonPage({ params }: { params: { courseId: string; conceptId: string } }) {
  return <LessonClient courseId={params.courseId} conceptId={params.conceptId} />;
}
