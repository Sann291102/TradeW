import type { Config } from 'tailwindcss';

/**
 * TradeW Tailwind preset — maps the CSS custom properties in
 * ./styles/tokens.css to Tailwind theme keys, so every app consumes the
 * SAME design tokens (`bg-card`, `text-muted`, `border-border2`, `text-teal`…)
 * instead of raw hex. Tokens resolve at runtime from CSS vars, so the same
 * class set works in both light and dark themes automatically.
 *
 * Colors are `var(--token)` (not rgb channels), so Tailwind's `/opacity`
 * modifiers are intentionally not supported on these tokens — the design
 * system is token-driven, not opacity-driven. Use the dedicated `*-bg`
 * (tint) tokens for translucent-looking surfaces.
 */
const preset: Partial<Config> = {
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        card: 'var(--card)',
        border: 'var(--border)',
        border2: 'var(--border2)',
        text: 'var(--text)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        teal: {
          DEFAULT: 'var(--teal)',
          bg: 'var(--teal-bg)',
        },
        // green/red are reserved strictly for market-data direction & sentiment
        // (DESIGN-SYSTEM.md §1) — never decorative.
        up: {
          DEFAULT: 'var(--green)',
          bg: 'var(--green-bg)',
        },
        down: {
          DEFAULT: 'var(--red)',
          bg: 'var(--red-bg)',
        },
        amber: {
          DEFAULT: 'var(--amber)',
          bg: 'var(--amber-bg)',
        },
        navy: 'var(--navy)',
        hover: 'var(--hover)',
        // v2 — glass surfaces (explicit rgba tokens; opacity modifiers don't
        // apply to var(...) colors, so glass needs its own token per theme)
        cardGlass: 'var(--card-glass)',
        cardGlass2: 'var(--card-glass-2)',
        glassBorder: 'var(--glass-border)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'Arial',
          'sans-serif',
        ],
        // numeric/price data renders monospaced (DESIGN-SYSTEM.md §2)
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          '"Liberation Mono"',
          'monospace',
        ],
      },
      boxShadow: {
        card: 'var(--shadow)',
        // v2 — progressive elevation ramp for "glass + elevation hierarchy"
        elev1: 'var(--elev-1)',
        elev2: 'var(--elev-2)',
        elev3: 'var(--elev-3)',
        elev4: 'var(--elev-4)',
        glowTeal: 'var(--glow-teal)',
        glowUp: 'var(--glow-up)',
        glowDown: 'var(--glow-down)',
      },
      backdropBlur: {
        glass: 'var(--glass-blur)',
      },
      // v2 typography scale — deliberately NOT named xs/sm/base/lg/xl/2xl/3xl:
      // those are Tailwind's own default fontSize keys, and theme.extend
      // would silently override every existing text-sm/text-lg/etc. class
      // already used across the app. Prefixed so it's additive-only.
      fontSize: {
        fs2xs: 'var(--fs-2xs)',
        fsXs: 'var(--fs-xs)',
        fsSm: 'var(--fs-sm)',
        fsBase: 'var(--fs-base)',
        fsMd: 'var(--fs-md)',
        fsLg: 'var(--fs-lg)',
        fsXl: 'var(--fs-xl)',
        fs2xl: 'var(--fs-2xl)',
        fs3xl: 'var(--fs-3xl)',
      },
      lineHeight: {
        tight2: 'var(--lh-tight)',
        normal2: 'var(--lh-normal)',
      },
      letterSpacing: {
        tightTrack: 'var(--tracking-tight)',
        wideTrack: 'var(--tracking-wide)',
      },
      spacing: {
        icon_sm: 'var(--icon-sm)',
        icon_md: 'var(--icon-md)',
        icon_lg: 'var(--icon-lg)',
      },
      borderRadius: {
        card: '12px',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
        spring: 'var(--ease-spring)',
      },
      transitionDuration: {
        micro: 'var(--dur-micro)',
        panel: 'var(--dur-panel)',
        route: 'var(--dur-route)',
        tick: 'var(--dur-tick)',
      },
      ringColor: {
        focus: 'var(--focus-ring)',
      },
    },
  },
};

export default preset;
