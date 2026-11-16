import { CoursePathClient } from '@/components/learning/CoursePathClient';

export const metadata = { title: 'Course — TradeW Learning' };

/** Restored 2026-08-04. A generated learning path. `courseId` selects the course. */
export default async function CoursePage({ params: paramsPromise }: { params: Promise<{ courseId: string }> }) {
  // Next 15+ passes route params as a Promise.
  const params = await paramsPromise;
  return <CoursePathClient courseId={params.courseId} />;
}
