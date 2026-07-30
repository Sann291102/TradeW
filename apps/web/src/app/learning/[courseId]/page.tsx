import { CoursePathClient } from './CoursePathClient';

export const metadata = { title: 'Course — TradeW Learning' };

/** A generated learning path. `courseId` selects the course. */
export default function CoursePage({ params }: { params: { courseId: string } }) {
  return <CoursePathClient courseId={params.courseId} />;
}
