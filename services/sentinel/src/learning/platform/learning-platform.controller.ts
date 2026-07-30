import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ServiceTokenGuard } from '../../app.controller';
import { AiTeacherService } from './ai-teacher.service';
import { ConceptSourceService } from './concept-source.service';
import { CourseGeneratorService } from './course-generator.service';
import { FlashcardGeneratorService } from './flashcard-generator.service';
import { LessonCacheService } from './lesson-cache.service';
import { LessonGeneratorService } from './lesson-generator.service';
import { QuizGeneratorService } from './quiz-generator.service';

/**
 * Internal HTTP surface for the AI Learning Platform. Service-token guarded —
 * only services/api calls it. Everything here is generated on demand from the
 * knowledge graph + strategy registry and cached; nothing is stored content.
 *
 * Entitlement and per-user progress are NOT decided here — they belong to
 * services/api, which owns user data and the entitlement engine. This service
 * only generates the (user-independent) teaching material.
 */
@UseGuards(ServiceTokenGuard)
@Controller('learning')
export class LearningPlatformController {
  constructor(
    private readonly courses: CourseGeneratorService,
    private readonly lessons: LessonGeneratorService,
    private readonly quizzes: QuizGeneratorService,
    private readonly flashcards: FlashcardGeneratorService,
    private readonly teacher: AiTeacherService,
    private readonly cache: LessonCacheService,
    private readonly conceptSource: ConceptSourceService,
  ) {}

  /** All generated courses with dynamic lesson counts. */
  @Get('courses')
  listCourses() {
    return { courses: this.cache.getOrCompute('courses', () => this.courses.listCourses()) };
  }

  /** One course with its ordered lesson stubs. */
  @Get('courses/:id')
  getCourse(@Param('id') id: string) {
    const course = this.cache.getOrCompute(`course:${id}`, () => this.courses.getCourse(id));
    return course ? { found: true, course } : { found: false };
  }

  /** A generated flashcard deck for an entire course. */
  @Get('courses/:id/flashcards')
  courseFlashcards(@Param('id') id: string) {
    const deck = this.cache.getOrCompute(`course-deck:${id}`, () => this.flashcards.forCourse(id));
    return deck ? { found: true, deck } : { found: false };
  }

  /** A fully generated, structured lesson (`courseId::conceptId`). */
  @Get('lessons/:lessonId')
  getLesson(@Param('lessonId') lessonId: string) {
    const lesson = this.cache.getOrCompute(`lesson:${lessonId}`, () => this.lessons.generate(lessonId));
    return lesson ? { found: true, lesson } : { found: false };
  }

  /** The lesson's live-practice exercise, if the concept supports one. */
  @Get('lessons/:lessonId/practice')
  getPractice(@Param('lessonId') lessonId: string) {
    const lesson = this.cache.getOrCompute(`lesson:${lessonId}`, () => this.lessons.generate(lessonId));
    return lesson?.practice ? { found: true, practice: lesson.practice } : { found: false };
  }

  /** An auto-generated quiz for a lesson (MCQ / true-false / scenario). */
  @Get('lessons/:lessonId/quiz')
  getQuiz(@Param('lessonId') lessonId: string) {
    const quiz = this.cache.getOrCompute(`quiz:${lessonId}`, () => this.quizzes.generate(lessonId));
    return quiz ? { found: true, quiz } : { found: false };
  }

  /** Auto-generated flashcards for a single lesson. */
  @Get('lessons/:lessonId/flashcards')
  getFlashcards(@Param('lessonId') lessonId: string) {
    const deck = this.cache.getOrCompute(`deck:${lessonId}`, () => this.flashcards.forLesson(lessonId));
    return deck ? { found: true, deck } : { found: false };
  }

  /** Ask Sentinel a question about the current lesson (grounded in internal knowledge). */
  @Post('teacher')
  ask(@Body() body: { lessonId: string; question: string }) {
    return this.teacher.ask(body.lessonId, body.question ?? '');
  }

  /** Admin: re-read the knowledge base from disk and clear the generation cache. */
  @Post('refresh')
  refresh() {
    const reloaded = this.conceptSource.reload();
    const cleared = this.cache.invalidateAll();
    return { reloaded, cacheCleared: cleared };
  }

  /** Admin diagnostics: cache stats + concept-source size. */
  @Get('platform/stats')
  stats() {
    return { cache: this.cache.stats(), concepts: this.conceptSource.size(), lastLoadedAt: this.conceptSource.lastLoadedAt() };
  }
}
