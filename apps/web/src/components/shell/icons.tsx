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
/** Tara is speaking / is muted — the voice-output toggle on the assistant dock. */
export const SpeakerIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);
export const SpeakerOffIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="m16 9 5 6M21 9l-5 6" />
  </svg>
);

/** Voice input on the assistant dock. */
export const MicIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
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

/* -------------------------- Option Chain quick actions ------------------- */

export const BookmarkIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M6 4h12v16l-6-4-6 4V4z" strokeLinejoin="round" />
  </svg>
);
export const LayersIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3l8 4-8 4-8-4 8-4z" strokeLinejoin="round" />
    <path d="M4 12l8 4 8-4M4 16l8 4 8-4" strokeLinejoin="round" />
  </svg>
);

/** Crypto — a coin. Deliberately generic rather than a Bitcoin glyph: the
 *  board covers many assets, not one. */
export const CryptoIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M9.5 8.5h4a2 2 0 0 1 0 4h-4h4a2 2 0 0 1 0 4h-4" />
    <path d="M11 6.5v11" />
  </svg>
);

/** Forex — two currencies exchanging. */
export const ForexIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 8h13l-3-3" />
    <path d="M20 16H7l3 3" />
  </svg>
);

/** Market News — a newspaper. */
export const NewsIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 5h13v14H5.5A1.5 1.5 0 0 1 4 17.5V5z" />
    <path d="M17 8h3v9.5a1.5 1.5 0 0 1-3 0V8z" />
    <path d="M7 8.5h7M7 11.5h7M7 14.5h4" />
  </svg>
);

/** Expand to full screen — the four-corner bracket every charting package uses.
 *  Reads as "[ ]" at small sizes, which is the affordance traders look for. */
export const ExpandIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5" />
  </svg>
);

/* --------------------- Canonical sidebar (2026-08-22) -------------------- */

/** Orders — a document with lines, the order book. */
export const OrdersIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M6 3.5h9L19 7v13.5H6z" strokeLinejoin="round" />
    <path d="M14.5 3.5V7H19" />
    <path d="M9 12h7M9 15.5h7" />
  </svg>
);

/** Positions — a map pin: where you currently stand in the market. */
export const PositionsIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 21s6-5.4 6-10a6 6 0 1 0-12 0c0 4.6 6 10 6 10z" strokeLinejoin="round" />
    <circle cx="12" cy="11" r="2.2" />
  </svg>
);

/** Backtesting — a clock turned back over a chart line. */
export const BacktestingIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3.5 4.5v4h4" />
    <path d="M12 8v4.5l3 1.8" />
  </svg>
);

/** Reports — a bar chart on a page. */
export const ReportsIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M5.5 3.5h13v17h-13z" strokeLinejoin="round" />
    <path d="M9 16v-3.5M12 16V9M15 16v-5.5" />
  </svg>
);

/** Alerts — a bell with a ring, distinct from the plain BellIcon used by the
 *  top bar so the sidebar entry and the notification button do not read as the
 *  same control. */
export const AlertsIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M7 10a5 5 0 0 1 10 0c0 3.2.8 4.6 1.5 5.5h-13C6.2 14.6 7 13.2 7 10z" strokeLinejoin="round" />
    <path d="M10.2 18.5a2 2 0 0 0 3.6 0" />
  </svg>
);

/** Calendar. */
export const CalendarIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="5" width="17" height="15" rx="1.5" />
    <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
  </svg>
);

/** Community — two people. */
export const CommunityIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
    <path d="M16 6.2a3 3 0 0 1 0 5.6M17 14.8c2 .6 3.5 2.4 3.5 4.7" />
  </svg>
);

/** Shield — privacy & security. */
export const ShieldIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3.5 19 6v5.5c0 4.3-3 7.4-7 9-4-1.6-7-4.7-7-9V6l7-2.5z" strokeLinejoin="round" />
  </svg>
);

/** Plug — integrations. */
export const PlugIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M9 3.5v5M15 3.5v5" />
    <path d="M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0v-3z" strokeLinejoin="round" />
    <path d="M12 17v3.5" />
  </svg>
);

/** Crown — subscription / plan. */
export const CrownIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 17.5 5.5 7l4.5 4L12 5.5 14 11l4.5-4L20 17.5z" strokeLinejoin="round" />
    <path d="M4 20h16" />
  </svg>
);

/** Question mark in a circle — help & support. */
export const HelpIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.7 9.6a2.4 2.4 0 0 1 4.6.8c0 1.6-2.3 1.9-2.3 3.3" />
    <path d="M12 17.2h.01" />
  </svg>
);

/** Scales — legal. */
export const LegalIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 4.5v15M7 19.5h10" />
    <path d="M12 7 4.5 9m0 0 2.2 4.5H2.3L4.5 9zM12 7l7.5 2m0 0 2.2 4.5h-4.4L19.5 9z" strokeLinejoin="round" />
  </svg>
);

/** "i" in a circle — about. */
export const InfoIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.7h.01" />
  </svg>
);

/** Sliders — preferences. */
export const SlidersIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M5 6.5h14M5 12h14M5 17.5h14" />
    <circle cx="9" cy="6.5" r="1.8" />
    <circle cx="15" cy="12" r="1.8" />
    <circle cx="8" cy="17.5" r="1.8" />
  </svg>
);

/** Paintbrush — appearance. */
export const PaletteIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.4-1-1.7-1-2.7 0-.8.7-1.4 1.6-1.4h1.7A4.4 4.4 0 0 0 20.5 10c0-3.6-3.8-6.5-8.5-6.5z" strokeLinejoin="round" />
    <circle cx="8" cy="10" r="1.1" />
    <circle cx="12" cy="7.6" r="1.1" />
    <circle cx="16" cy="10" r="1.1" />
  </svg>
);

/** Download / export. */
export const DownloadIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 4v10M8 10.5l4 4 4-4" />
    <path d="M4.5 18.5h15" />
  </svg>
);

/** Trash — destructive actions. */
export const TrashIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4.5 6.5h15M9.5 6.5V4.5h5v2" />
    <path d="M6.5 6.5 7.5 20h9l1-13.5" strokeLinejoin="round" />
  </svg>
);

/** Key — password / credentials. */
export const KeyIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="12" r="3.5" />
    <path d="M11.5 12H20M17 12v3M14.5 12v2.2" />
  </svg>
);

/** Monitor — active sessions / devices. */
export const DeviceIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="5" width="17" height="11" rx="1.5" />
    <path d="M9 19.5h6M12 16v3.5" />
  </svg>
);

/** Book — documentation / how to use. */
export const BookIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4.5 5.5A2 2 0 0 1 6.5 3.5H19v14H6.5a2 2 0 0 0-2 2v-14z" strokeLinejoin="round" />
    <path d="M4.5 19.5A2 2 0 0 1 6.5 17.5H19v3H6.5a2 2 0 0 0-2 -1z" strokeLinejoin="round" />
  </svg>
);
