/**
 * Learning Hub mock content (LEARNING-HUB.md §2). Shared by the full
 * `/learning` page, the dockable LearningMiniPanel (Milestone 3), and the
 * Command Palette's learning search provider — one source, not three copies.
 */

export interface LearningCategory {
  name: string;
  lessons: number;
  tier: string;
}

export interface LearningPath {
  name: string;
  pct: number;
}

export const LEARNING_CATEGORIES: LearningCategory[] = [
  { name: 'Trading Basics', lessons: 12, tier: 'Beginner' },
  { name: 'Price Action', lessons: 9, tier: 'Intermediate' },
  { name: 'Indicators', lessons: 14, tier: 'Intermediate' },
  { name: 'Market Structure', lessons: 8, tier: 'Intermediate' },
  { name: 'Risk Management', lessons: 7, tier: 'All levels' },
  { name: 'Psychology', lessons: 6, tier: 'All levels' },
  { name: 'Backtesting', lessons: 5, tier: 'Advanced' },
  { name: 'Historical Case Studies', lessons: 11, tier: 'Advanced' },
];

export const LEARNING_PATHS: LearningPath[] = [
  { name: 'New Trader Foundations', pct: 35 },
  { name: 'Options Essentials', pct: 0 },
  { name: 'Disciplined Execution', pct: 12 },
];
