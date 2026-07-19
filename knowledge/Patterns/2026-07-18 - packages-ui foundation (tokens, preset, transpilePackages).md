---
type: pattern
date: 2026-07-18
tags: [pattern, frontend, packages-ui, design-system, phase-1]
status: active
---

# Pattern: packages/ui foundation — how the shared design system is wired

## For future Claude
This is Phase 1, Milestone 1 of Genesis (HTML terminal → React). Read before adding any UI component or touching the design tokens. The foundation exists and builds; extend it, don't re-scaffold.

## Consumption model (important — no build step)
`packages/ui` is a **source-only** package consumed via Next.js `transpilePackages`, NOT compiled to dist:
- `apps/web/next.config.mjs` → `transpilePackages: ['@tradew/ui']`
- `@tradew/ui` package.json `main`/`types` point at `./src/index.ts`; exports map also exposes `./styles.css` and `./tailwind-preset`.
- `apps/web/tailwind.config.ts` → `presets: [tradewPreset]` (imported from `@tradew/ui/tailwind-preset`) + content globs include `../../packages/ui/src/**/*.{ts,tsx}` so the package's classes are emitted.
- Token CSS imported once in `apps/web/src/app/layout.tsx` as `import '@tradew/ui/styles.css'` BEFORE `import './globals.css'` (globals consumes the vars).

Add a new app that uses the design system → repeat those four wiring points.

## Design tokens (single source of truth)
`packages/ui/src/styles/tokens.css` holds the CSS custom properties extracted **verbatim** from `apps/terminal/index.html` (the canonical terminal, per DESIGN-SYSTEM.md — the design system, not inspiration). Light set on `:root`, dark override on `[data-theme="dark"]` (works on `<html>` or `<body>`). **Do not edit token values here to "improve" them** — change the canonical HTML reference first, then mirror. Tailwind preset (`tailwind-preset.ts`) maps them to theme keys: `bg`, `card`, `border`/`border2`, `text`/`muted`/`faint`, `teal`(+`teal-bg`), `up`/`down` (market direction — the ONLY green/red, never decorative, per DESIGN-SYSTEM §1), `amber`, `navy`, `hover`, `rounded-card`, `shadow-card`, `duration-micro/panel/route`, `ring-focus`.

## Dark-first decision (flag for review)
Both themes are defined; `apps/web/layout.tsx` sets `<html data-theme="dark">` so dark is the default applied theme (Genesis "dark-first" principle), while the canonical HTML was light-default. Token VALUES are byte-identical to the HTML, so visual familiarity is preserved either way; only the default toggle state differs. If the user wants light-default instead, it's a one-attribute change.

## Reusable-recipe pattern (avoid duplicated styling)
`Button` exports a `buttonClasses({variant,size,className})` recipe so a Next `<Link>` can be styled identically without duplicating the class set or inventing a fake prop — `<Link className={buttonClasses({variant:'outline'})}>`. Keeps the UI package framework-agnostic (no next/link dependency). Use this pattern for any "style element X like component Y" need.

## Motion
`packages/ui/src/motion/variants.ts` — shared Framer Motion tokens (durations in seconds: micro 0.15 / panel 0.25 / route 0.3) + variants (fade, fadeInUp, panelSlide, sidebarSlide, modalPop, stagger). CSS token layer zeroes durations under `prefers-reduced-motion`; component-level motion should also honor `useReducedMotion()`.

## Verification done
`npm run build -w @tradew/web` green (10 routes), `tsc --noEmit` on `@tradew/ui` clean, `next lint` clean (2 pre-existing exhaustive-deps warnings in profile/trade pages — NOT touched, Rule 1). Browser: computed styles confirmed dark tokens resolve live (body bg #0d1524, card #131e33, teal #14b8a6). One gotcha fixed: `CardProps` must `Omit<HTMLAttributes,'title'>` because the native `title` is string-only and we want ReactNode.

## Related
- [[../_INDEX.md]]
- [[../Decisions/2026-07-17 - Genesis v2 direction update (TRADEW-OS constitution + Research Vault)]]
- DESIGN-SYSTEM.md, TRADEW-OS.md §9 (maintainability, one design system)
