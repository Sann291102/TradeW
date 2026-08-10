import type { Tone } from '@/lib/sentinel/dashboardModel';

/**
 * Maps a semantic tone to the design-system token classes. Green/red are
 * reserved for market direction & risk sentiment per the design system; teal
 * is the Sentinel brand accent; amber is caution. Kept in one place so every
 * dashboard card colours identically.
 */
export const toneText: Record<Tone, string> = {
  up: 'text-up',
  down: 'text-down',
  amber: 'text-amber',
  teal: 'text-teal',
  neutral: 'text-muted',
};

export const toneBg: Record<Tone, string> = {
  up: 'bg-up-bg text-up',
  down: 'bg-down-bg text-down',
  amber: 'bg-amber-bg text-amber',
  teal: 'bg-teal-bg text-teal',
  neutral: 'bg-hover text-muted',
};

export const toneBar: Record<Tone, string> = {
  up: 'bg-up',
  down: 'bg-down',
  amber: 'bg-amber',
  teal: 'bg-teal',
  neutral: 'bg-muted',
};
