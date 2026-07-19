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
      },
      borderRadius: {
        card: '12px',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
      },
      transitionDuration: {
        micro: 'var(--dur-micro)',
        panel: 'var(--dur-panel)',
        route: 'var(--dur-route)',
      },
      ringColor: {
        focus: 'var(--focus-ring)',
      },
    },
  },
};

export default preset;
