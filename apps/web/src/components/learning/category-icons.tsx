import type { ComponentType, SVGProps } from 'react';

/**
 * Category glyphs for course tiles — same hand-rolled stroke-SVG convention
 * as apps/web/src/components/shell/icons.tsx (1.7 stroke, currentColor, no
 * fill), kept local to Learning since these are Learning-specific concepts,
 * not app chrome.
 */
type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  width: 20,
  height: 20,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const BasicsIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z" />
    <path d="M4 18.5V5.5M8 8h8M8 11h8" strokeWidth={1.3} />
  </svg>
);

export const TechnicalIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 18V9M10 18V5M16 18v-7M4 18h16" />
  </svg>
);

export const OptionsIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="12" r="6" />
    <circle cx="15" cy="12" r="6" strokeDasharray="2.5 2.5" />
  </svg>
);

export const RiskIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3l7 3v6c0 5-3.2 7.7-7 9-3.8-1.3-7-4-7-9V6z" strokeWidth={1.6} />
    <path d="M9 12l2 2 4-4" strokeWidth={1.6} />
  </svg>
);

export const PsychologyIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M9 3a4 4 0 0 0-4 4c0 1.2.5 2 1 2.5C5 10.5 4.5 12 5 13.5c.4 1.2 1.4 1.7 2 1.8V19a2 2 0 0 0 2 2h2v-3" strokeWidth={1.4} />
    <path d="M13 19v-3.5c1.6-.3 2.5-1.3 2.7-2.3.3-1.3-.2-2.2-.9-2.9.6-.6 1.2-1.6 1.2-2.8A4 4 0 0 0 12 3.5" strokeWidth={1.4} />
  </svg>
);

export const StrategyIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
  </svg>
);

export const BookIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M3 7l9-4 9 4-9 4-9-4z" />
    <path d="M7 9v5c0 1.1 2.2 2 5 2s5-.9 5-2V9" />
  </svg>
);

export const FlameIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 2.5c1.5 2.5-.5 4-1 5.5-.6 1.8.5 2.7 1.5 2.2 1-.5 1-2 .7-3 2 1.5 3.3 4 3.3 6.3A5.5 5.5 0 0 1 6 13.5c0-3.8 3-6.5 6-11z" strokeLinejoin="round" />
  </svg>
);

export const CalendarIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="5" width="17" height="16" rx="1.8" />
    <path d="M3.5 9.5h17M8 3v4M16 3v4" strokeWidth={1.4} />
  </svg>
);

type IconComponent = ComponentType<IconProps>;

const KEYWORD_ICON: Array<{ test: RegExp; Icon: IconComponent }> = [
  { test: /basic|beginner|fundamental|intro/i, Icon: BasicsIcon },
  { test: /technical|chart|pattern|indicator|price action/i, Icon: TechnicalIcon },
  { test: /option|call|put|derivative/i, Icon: OptionsIcon },
  { test: /risk|money management|capital/i, Icon: RiskIcon },
  { test: /psycholog|emotion|discipline|mindset/i, Icon: PsychologyIcon },
  { test: /strateg|backtest|system/i, Icon: StrategyIcon },
];

/**
 * Deterministic icon-by-course-name mapping — NOT random. Picks the first
 * keyword match in the real course name/summary; falls back to a generic
 * book glyph. Purely decorative categorization derived from real data, never
 * a fabricated field.
 */
export function iconForCourse(name: string): IconComponent {
  const hit = KEYWORD_ICON.find((k) => k.test.test(name));
  return hit?.Icon ?? BookIcon;
}
