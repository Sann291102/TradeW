---
name: learning-homepage-premium-redesign-2026-08-05
description: Presentation-layer redesign of the /learning homepage to match a course-platform reference screenshot, with a worked pattern for handling reference-UI fields the backend doesn't have
metadata:
  type: pattern
---

# Learning homepage premium redesign (honest data-gap handling)

**Read before touching `apps/web/src/components/learning/LearningClient.tsx`, its new sibling components, or `apps/web/src/lib/learning-platform/types.ts`.**

## What changed

Pure presentation-layer redesign of `/learning`'s homepage to match a reference course-platform screenshot (donut progress ring, weekly streak calendar, category tiles, featured-courses list, a "continue where you left off" carousel, quick-practice links, header streak/completed badges). Same `learningApi.courses()` call, same `services/api` `LearningController` → `LearningProgressService` underneath — nothing in `services/api`, `services/sentinel`, or Prisma touched. `apps/web/src/app/learning/page.tsx` is unchanged; only the component it renders got new visuals.

New files, all under `apps/web/src/components/learning/`: `RadialProgress.tsx` (pure-SVG donut, no chart lib — matches `@tradew/ui`'s `Sparkline` convention), `StreakStrip.tsx`, `CourseCarousel.tsx` (hand-rolled scroll-snap, no carousel lib installed), `CourseTile.tsx`, `category-icons.tsx`. The previous plain list/grid `LearningClient.tsx` is archived at `archive/web-learning-homepage-pre-premium-redesign-2026-08-05.tsx.txt` per [[../../CLAUDE.md]] Rule 1.

## The load-bearing decision: don't fabricate what the backend doesn't have

The reference screenshot has five widgets with no backing data anywhere in the backend — confirmed via `services/api/src/learning/learning-progress.service.ts`'s `StoredProgress`/`summary()` shapes:

- **XP / points** — not modeled at all.
- **Certificates Earned** — not modeled at all.
- **Hours Learned** — not modeled at all.
- **Upcoming Live Sessions** — no live-session entity/endpoint exists in `services/api` or `services/sentinel`.
- **Video thumbnails** — lessons are structured text (`Lesson` interface: intro/objectives/examples/tips), no video asset field.

Per the user's explicit brief ("every widget must display live data, not mock... otherwise leave a clearly marked integration point without breaking the application"), these render as honest "Coming soon" states / empty states with a code comment marking the integration point — never an invented number. The header's XP badge became a **Completed Courses** badge instead (real `courses.filter(pct===100).length`) rather than omitting the second badge slot entirely — same visual weight, real data. The "Continue Learning" video thumbnail became a decorative gradient + category-icon tile, not a fake play button.

## The surprising part: some "missing" data was actually derivable

Two fields looked like they'd need the same "coming soon" treatment but didn't:

1. **Weekly streak calendar.** The backend only stores `streak` (an integer day-count) and `lastActivityAt` (a date) — no daily history array. But those two fields *mathematically* fix which of the last `streak` calendar days were active (count backward from `lastActivityAt`), so `StreakStrip.tsx` derives a fully honest Mon–Sun grid with zero new backend fields. Timezone-matched to the rest of the app (`Asia/Kolkata`, same as `DashboardHero`'s greeting).

2. **"Next lesson" / Continue Learning deep link.** `CoursesResponse['progress']['continueLearning']`'s frontend type only had `{ courseId }` — but the real API response (and `LearningProgressService.summary()`'s return type) always includes `lessonId` too; the frontend type was just stale. Before finding this, the first pass guessed "next lesson" by picking the lowest-`order` lesson in the course, which produced a wrong and slightly embarrassing result verified live: after completing lesson 1 ("Liquidity"), the UI said "Next: Liquidity" — pointing at the lesson just finished. Fixed by correcting the type (`{ lessonId: string; courseId: string }`) and using the real pointer.

   That surfaced a second, smaller honesty issue: `pickContinue()` in `learning-progress.service.ts` doesn't actually return "the first incomplete lesson" despite its own comment saying so — it returns the **anchor** (most recently completed/quizzed lesson), which may itself be done. Rather than assume incompleteness the UI doesn't know is true, the label reads **"Resume: {title}"** (accurate regardless of completion state) instead of **"Next: {title}"** (a claim the data doesn't support), with a **"Start with: {title}"** fallback only for the `inProgress[0]`-guessed case where no real `continueLearning` signal exists at all. See `resumeIsRealAnchor` in `LearningClient.tsx`.

## Verification method

No demo account worked (`founder@tradew.local` / `sentinel-demo` from `packages/database/prisma/seed.ts` 401'd — likely the known `bcrypt.hash is not a function` seed bug, see [[../Gotchas/2026-07-23 - Sentinel not working was four stacked config+build faults]] for a similar seed-time bug class). Verified instead with a throwaway local signup (`qa-verify@tradew.local`) against the running dev `services/api`, both empty-state (0 courses started) and populated-state (after a real `POST /learning/progress/lesson-complete` call) — the populated-state pass is what caught the "Next: Liquidity" bug above. Responsive breakpoints (375/768/1440px) checked via computed `grid-template-columns` + `body.scrollWidth` rather than visual screenshots — the Browser pane's screenshot compositor was unavailable for most of this session ("pane is not displayed" from the harness side, not a page bug); one screenshot did succeed mid-session and showed the intended dark/teal premium look rendering correctly.

## Related

[[../Decisions/2026-07-17 - Genesis v2 blueprint added as new product-architecture docs]] (`docs/product-architecture/LEARNING-HUB.md` §4's `lessons`/`learning_paths`/`learning_progress`/`learning_bookmarks` schema is still "design, pre-implementation" — certificates/XP/live-sessions would need new tables there, not a frontend workaround).
