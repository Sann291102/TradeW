import type { SVGProps } from 'react';

/**
 * Stroke-based icon set for the app chrome, matching the canonical terminal's
 * inline-SVG style (1.6–1.8 stroke, currentColor, no fill). Kept as a small
 * local set rather than pulling an icon library — faithful to the source and
 * zero extra dependency. Each takes standard SVG props (size via width/height).
 */
type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  width: 18,
  height: 18,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const HomeIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 11.5 12 4l8 7.5" />
    <path d="M6 10v9h12v-9" />
  </svg>
);
export const MarketsIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M4 12h16M12 4c2.5 2.2 2.5 13.8 0 16M12 4c-2.5 2.2-2.5 13.8 0 16" strokeWidth={1.2} />
  </svg>
);
export const TradeIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 18V9M10 18V5M16 18v-7M4 18h16" />
  </svg>
);
export const PortfolioIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 9h16v9H4z" />
    <path d="M9 9V6.5A1.5 1.5 0 0 1 10.5 5h3A1.5 1.5 0 0 1 15 6.5V9" />
  </svg>
);
export const LearningIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M3 7l9-4 9 4-9 4-9-4z" />
    <path d="M7 9v5c0 1.1 2.2 2 5 2s5-.9 5-2V9" />
  </svg>
);
export const KnowledgeIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="6" cy="7" r="2.2" />
    <circle cx="18" cy="7" r="2.2" />
    <circle cx="12" cy="17" r="2.2" />
    <path d="M7.8 8.4 11 15m5.2-6.6L13 15m-5-8h8" strokeWidth={1.3} />
  </svg>
);
export const SentinelIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3l7 3v6c0 5-3.2 7.7-7 9-3.8-1.3-7-4-7-9V6z" strokeWidth={1.6} />
    <path d="M9 12l2 2 4-4" strokeWidth={1.6} />
  </svg>
);
export const SettingsIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2m0 14v2M5 5l1.5 1.5M17.5 17.5 19 19M3 12h2m14 0h2M5 19l1.5-1.5M17.5 6.5 19 5" strokeWidth={1.3} />
  </svg>
);
export const ProfileIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" />
  </svg>
);
export const BellIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M6 10a6 6 0 1 1 12 0c0 4 1.5 5 1.5 5h-15S6 14 6 10Z" strokeWidth={1.5} />
    <path d="M10 18a2 2 0 0 0 4 0" strokeWidth={1.5} />
  </svg>
);
export const SearchIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l5 5" />
  </svg>
);
export const SparkleIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3l1.8 4.9L19 9.6l-4.9 1.8L12 16l-2.1-4.6L5 9.6l5.2-1.7L12 3z" strokeWidth={1.4} />
  </svg>
);
export const MenuIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);
export const ChevronIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);
export const ResearchIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M6 3h9l3 3v15H6z" />
    <path d="M15 3v3h3M9 12h6M9 15.5h6M9 8.5h3" strokeWidth={1.3} />
  </svg>
);

/* -------------------------- Milestone 3 additions ------------------------ */

/** Drag grip — dock-panel move handle. */
export const GripIcon = (p: IconProps) => (
  <svg {...base} {...p} strokeWidth={0} fill="currentColor">
    {[7, 12, 17].flatMap((cx) => [8, 12, 16].map((cy) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.3} />))}
  </svg>
);
export const PinIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M9 4h6l-.7 6.2L18 13v2h-6v5l-1 2-1-2v-5H4v-2l3.7-2.8L9 4z" strokeLinejoin="round" />
  </svg>
);
export const CloseIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const ChevronUpIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M6 15l6-6 6 6" />
  </svg>
);
export const ChevronDownIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
export const PopOutIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M14 4h6v6M10 14 20 4" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h5" />
  </svg>
);
export const PlusIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const CommandIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M8 5.5A2.5 2.5 0 1 1 10.5 8H8V5.5zM8 16a2.5 2.5 0 1 0 2.5 2.5V16H8zm8-8a2.5 2.5 0 1 0-2.5-2.5V8H16zm0 8h2.5A2.5 2.5 0 1 1 16 18.5V16zM10.5 8h3v8h-3z" strokeWidth={1.3} />
  </svg>
);
export const SunIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
  </svg>
);
export const MoonIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" strokeLinejoin="round" />
  </svg>
);
export const ContrastIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
  </svg>
);
export const InboxIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 12h4l2 3h4l2-3h4" />
    <path d="M5.5 6h13L20 12v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6z" strokeLinejoin="round" />
  </svg>
);
export const CheckIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M5 12.5 10 17 19 7" />
  </svg>
);
export const LayoutIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="4" width="17" height="16" rx="1.5" />
    <path d="M3.5 9.5h17M9 9.5V20" />
  </svg>
);
