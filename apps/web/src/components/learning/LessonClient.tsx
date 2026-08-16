'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { cn } from '@tradew/ui';
import { learningApi, lessonIdOf } from '@/lib/learning-platform/api';
import { useCompleteLesson, useRecordQuiz } from '@/lib/query/useLearning';
import type { Flashcard, Lesson, Quiz, TeacherAnswer } from '@/lib/learning-platform/types';

/**
 * Restored 2026-08-04 from archive/apps-web-learning-course-platform-superseded
 * (verbatim except import paths — see LearningClient.tsx for context).
 *
 * Lesson viewer — renders the generated, structured lesson and its interactive
 * tools (Ask Sentinel, quiz, flashcards, live practice). Everything is fetched
 * from the API; nothing is authored here.
 */
export function LessonClient({ courseId, conceptId }: { courseId: string; conceptId: string }) {
  const lessonId = lessonIdOf(courseId, conceptId);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const completeLesson = useCompleteLesson();

  useEffect(() => {
    let cancelled = false;
    setLesson(null);
    setError(null);
    learningApi
      .lesson(lessonId)
      .then((r) => {
        if (cancelled) return;
        if (r.found && r.lesson) setLesson(r.lesson);
        else setError('Lesson not found.');
      })
      .catch((e) => !cancelled && setError(e?.status === 403 ? 'This course requires Sentinel Pro.' : 'Could not load this lesson.'));
    return () => {
      cancelled = true;
    };
  }, [lessonId]);

  // Completing a lesson changes the catalogue's progress counts, which the
  // Learning hub and the course path both render. The mutation invalidates
  // that shared query, so the tick and the progress ring update the moment the
  // user goes back rather than whenever the catalogue happens to be refetched.
  async function markComplete() {
    try {
      await completeLesson.mutateAsync(lessonId);
      setCompleted(true);
    } catch {
      /* non-fatal */
    }
  }

  if (error)
    return (
      <Shell>
        <Link href={`/learning/${courseId}`} className="text-[12px] text-teal hover:underline">← Back to course</Link>
        <div className="mt-4 rounded-card border border-border bg-card p-6 text-center text-[13px] text-muted">{error}</div>
      </Shell>
    );
  if (!lesson)
    return <Shell><p className="text-[13px] text-muted">Loading lesson…</p></Shell>;

  return (
    <Shell>
      <Link href={`/learning/${courseId}`} className="text-[12px] text-teal hover:underline">← Back to course</Link>
      <h1 className="mt-2 text-lg font-bold text-text">{lesson.title}</h1>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{lesson.introduction}</p>

      <Section title="Learning objectives">
        <ul className="space-y-1.5">
          {lesson.learningObjectives.map((o, i) => (
            <Bullet key={i}>{o}</Bullet>
          ))}
        </ul>
      </Section>

      <Section title="AI explanation">
        <p className="text-[13px] leading-relaxed text-text">{lesson.aiExplanation}</p>
      </Section>

      {lesson.visualConcepts.length > 0 && (
        <Section title="Visual concepts — how to spot it">
          <ul className="space-y-1.5">{lesson.visualConcepts.map((v, i) => <Bullet key={i}>{v}</Bullet>)}</ul>
        </Section>
      )}

      {lesson.tradingExamples.length > 0 && (
        <Section title="Trading examples">
          <div className="space-y-2.5">
            {lesson.tradingExamples.map((e, i) => (
              <div key={i} className="rounded-lg bg-bg p-3">
                <div className="text-[12.5px] font-semibold text-text">{e.title}{e.date ? ` · ${e.date}` : ''}</div>
                <div className="mt-0.5 text-[12px] text-muted">{e.context}</div>
                <div className="mt-0.5 text-[12px] text-muted"><span className="text-faint">Outcome:</span> {e.outcome}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {lesson.realMarketExamples.length > 0 && (
        <Section title="Real market examples">
          <ul className="space-y-1.5">{lesson.realMarketExamples.map((e, i) => <Bullet key={i}>{e}</Bullet>)}</ul>
        </Section>
      )}

      {lesson.commonMistakes.length > 0 && (
        <Section title="Common mistakes">
          <ul className="space-y-1.5">{lesson.commonMistakes.map((m, i) => <Bullet key={i} tone="down">{m}</Bullet>)}</ul>
        </Section>
      )}

      {lesson.practicalTips.length > 0 && (
        <Section title="Practical tips">
          <ul className="space-y-1.5">{lesson.practicalTips.map((t, i) => <Bullet key={i} tone="up">{t}</Bullet>)}</ul>
        </Section>
      )}

      <Section title="Summary">
        <p className="text-[13px] leading-relaxed text-text">{lesson.summary}</p>
      </Section>

      <Section title="Key takeaways">
        <ul className="space-y-1.5">{lesson.keyTakeaways.map((k, i) => <Bullet key={i}>{k}</Bullet>)}</ul>
      </Section>

      <AskSentinel lessonId={lessonId} />

      <QuizPanel lessonId={lessonId} />

      <FlashcardsPanel lessonId={lessonId} />

      {lesson.practice && (
        <Section title="Practice on the live market">
          <div className="rounded-lg border border-teal/40 bg-teal-bg/40 p-4">
            <div className="text-[13px] font-semibold text-text">{lesson.practice.title}</div>
            <p className="mt-1 text-[12.5px] text-muted">{lesson.practice.task}</p>
            <div className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-faint">You’re looking for</div>
            <ul className="mt-1 space-y-1">{lesson.practice.successCriteria.map((s, i) => <Bullet key={i}>{s}</Bullet>)}</ul>
            <div className="mt-3 flex flex-wrap gap-2">
              {lesson.practice.suggestedSymbols.map((sym) => (
                <Link key={sym} href={`/sentinel`} className="rounded-lg border border-border bg-card px-2.5 py-1 text-[12px] font-semibold text-teal hover:border-teal">
                  Practice on live {sym} →
                </Link>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-faint">{lesson.practice.disclaimer}</p>
          </div>
        </Section>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <button
          type="button"
          onClick={markComplete}
          disabled={completed}
          className={cn(
            'rounded-lg px-4 py-2 text-[13px] font-semibold transition-colors',
            completed ? 'bg-teal-bg text-teal' : 'bg-teal text-white hover:opacity-90',
          )}
        >
          {completed ? '✓ Completed' : 'Mark complete'}
        </button>
        {lesson.nextLesson && (
          <Link
            href={`/learning/${courseId}/${encodeURIComponent(lesson.nextLesson.conceptId)}`}
            className="rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-semibold text-text transition-colors hover:border-teal"
          >
            Next: {lesson.nextLesson.title} →
          </Link>
        )}
      </div>
    </Shell>
  );
}

// --------------------------------------------------------------- Ask Sentinel
function AskSentinel({ lessonId }: { lessonId: string }) {
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<TeacherAnswer | null>(null);
  const [loading, setLoading] = useState(false);

  async function ask() {
    if (!q.trim()) return;
    setLoading(true);
    setAnswer(null);
    try {
      setAnswer(await learningApi.ask(lessonId, q.trim()));
    } catch {
      setAnswer({ answer: 'Sentinel could not answer right now.', usedInternalKnowledge: false, sources: [], lessonConceptId: null });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Section title="Ask Sentinel">
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder="Ask a question about this lesson…"
          className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        />
        <button type="button" onClick={ask} disabled={loading} className="rounded-lg bg-teal px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-60">
          {loading ? '…' : 'Ask'}
        </button>
      </div>
      {answer && (
        <div className="mt-3 rounded-lg bg-bg p-3.5">
          <p className="text-[13px] leading-relaxed text-text">{answer.answer}</p>
          {answer.sources.length > 0 && (
            <p className="mt-2 text-[11px] text-faint">
              Grounded in {answer.sources.length} internal source{answer.sources.length === 1 ? '' : 's'} · {answer.usedInternalKnowledge ? 'knowledge graph + Brain' : 'general'}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------- Quiz
function QuizPanel({ lessonId }: { lessonId: string }) {
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [open, setOpen] = useState(false);
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const recordQuiz = useRecordQuiz();

  async function load() {
    setOpen(true);
    if (quiz) return;
    try {
      const r = await learningApi.quiz(lessonId);
      if (r.found && r.quiz) setQuiz(r.quiz);
    } catch {
      /* ignore */
    }
  }

  const score = quiz ? quiz.questions.filter((q) => picks[q.id] === q.answerIndex).length : 0;

  // Recording a quiz score moves the catalogue's progress the same way
  // completing a lesson does, so it invalidates the same shared query.
  async function finish() {
    setSubmitted(true);
    if (quiz) {
      try {
        await recordQuiz.mutateAsync({ lessonId, score, total: quiz.questions.length });
      } catch {
        /* non-fatal */
      }
    }
  }

  if (!open)
    return (
      <Section title="Quiz">
        <button type="button" onClick={load} className="rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-semibold text-teal hover:border-teal">
          Take the quiz
        </button>
      </Section>
    );

  if (!quiz) return <Section title="Quiz"><p className="text-[12.5px] text-muted">Loading quiz…</p></Section>;

  return (
    <Section title="Quiz">
      <div className="space-y-4">
        {quiz.questions.map((question, qi) => {
          const pick = picks[question.id];
          return (
            <div key={question.id} className="rounded-lg bg-bg p-3.5">
              <div className="text-[13px] font-semibold text-text">{qi + 1}. {question.prompt}</div>
              <div className="mt-2 space-y-1.5">
                {question.options.map((opt, oi) => {
                  const chosen = pick === oi;
                  const isCorrect = oi === question.answerIndex;
                  const show = submitted || pick != null;
                  return (
                    <button
                      key={oi}
                      type="button"
                      disabled={submitted}
                      onClick={() => setPicks((p) => ({ ...p, [question.id]: oi }))}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors',
                        !show && 'border-border bg-card hover:border-teal',
                        show && isCorrect && 'border-up/50 bg-up/5 text-text',
                        show && chosen && !isCorrect && 'border-down/50 bg-down/5 text-text',
                        show && !isCorrect && !chosen && 'border-border bg-card text-muted',
                      )}
                    >
                      <span className={cn('font-mono text-[11px]', show && isCorrect ? 'text-up' : show && chosen ? 'text-down' : 'text-faint')}>
                        {String.fromCharCode(65 + oi)}
                      </span>
                      {opt}
                    </button>
                  );
                })}
              </div>
              {pick != null && (
                <p className="mt-2 text-[12px] leading-relaxed text-muted"><span className="font-semibold text-text">Why:</span> {question.explanation}</p>
              )}
            </div>
          );
        })}
        <div className="flex items-center gap-3">
          {!submitted ? (
            <button type="button" onClick={finish} className="rounded-lg bg-teal px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90">
              Finish quiz
            </button>
          ) : (
            <span className="text-[13px] font-semibold text-text">Score: {score}/{quiz.questions.length}</span>
          )}
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- Flashcards
function FlashcardsPanel({ lessonId }: { lessonId: string }) {
  const [cards, setCards] = useState<Flashcard[] | null>(null);
  const [open, setOpen] = useState(false);
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});

  async function load() {
    setOpen(true);
    if (cards) return;
    try {
      const r = await learningApi.flashcards(lessonId);
      setCards(r.found && r.deck ? r.deck.cards : []);
    } catch {
      setCards([]);
    }
  }

  if (!open)
    return (
      <Section title="Flashcards">
        <button type="button" onClick={load} className="rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-semibold text-teal hover:border-teal">
          Review flashcards
        </button>
      </Section>
    );

  if (!cards) return <Section title="Flashcards"><p className="text-[12.5px] text-muted">Loading…</p></Section>;
  if (cards.length === 0) return <Section title="Flashcards"><p className="text-[12.5px] text-muted">No flashcards for this lesson.</p></Section>;

  return (
    <Section title="Flashcards">
      <div className="grid gap-2.5 sm:grid-cols-2">
        {cards.map((card) => {
          const isFlipped = flipped[card.id];
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => setFlipped((f) => ({ ...f, [card.id]: !f[card.id] }))}
              className="min-h-[90px] rounded-lg border border-border bg-card p-3.5 text-left transition-colors hover:border-teal"
            >
              <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">{card.category}{isFlipped ? ' · answer' : ' · tap to flip'}</div>
              <div className="mt-1 text-[13px] text-text">{isFlipped ? card.back : card.front}</div>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// --------------------------------------------------------------- primitives
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">{title}</h2>
      {children}
    </section>
  );
}

function Bullet({ children, tone }: { children: React.ReactNode; tone?: 'up' | 'down' }) {
  return (
    <li className="flex gap-2 text-[12.5px] leading-relaxed text-text">
      <span className={cn('mt-1.5 h-1 w-1 shrink-0 rounded-full', tone === 'up' ? 'bg-up' : tone === 'down' ? 'bg-down' : 'bg-teal')} />
      <span>{children}</span>
    </li>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[860px] p-4">{children}</div>;
}
