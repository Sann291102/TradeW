import { CoursePathClient } from '@/components/learning/CoursePathClient';

export const metadata = { title: 'Course — TradeW Learning' };

/** Restored 2026-08-04. A generated learning path. `courseId` selects the course. */
export default function CoursePage({ params }: { params: { courseId: string } }) {
  return <CoursePathClient courseId={params.courseId} />;
}
