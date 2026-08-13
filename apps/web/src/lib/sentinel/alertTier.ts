import type { BadgeTone } from '@tradew/ui';

/**
 * How a Sentinel alert is labelled and coloured in the notification bell.
 *
 * Sentinel writes a `tier` into every notification's metadata
 * (services/sentinel-py/app/notify/dispatcher.py), and until now the drawer
 * ignored it: "a condition is forming" and "the level you projected was
 * reached" rendered as the same teal SENTINEL pill. The tier is the whole
 * point of the tiering — it is what tells the user whether to look now.
 *
 * ## Why the metadata and not the title
 *
 * The titles are fixed strings ("Wait & Watch", "Side in Focus", …) and could
 * be matched on, but they are user-facing copy: rewording one would silently
 * turn its alerts grey. The metadata field is the contract.
 *
 * ## Colour meaning
 *
 * `positive`/`negative` are reserved for gains and losses (DESIGN-SYSTEM.md
 * §1), so only the two in-trade events that ARE a gain or a loss get them. A
 * confirmed setup is brand-toned, not green: nothing has been gained yet.
 */

export interface AlertTier {
  /** Stable key for tests and styling, not shown to the user. */
  key: 'wait_and_watch' | 'side_in_focus' | 'milestone' | 'invalidation' | 'projected' | 'structure' | 'in_trade';
  label: string;
  tone: BadgeTone;
}

/** The shape the bell needs; a superset of what `/notifications` returns. */
export interface AlertLike {
  category: string;
  metadata?: unknown;
}

const TIERS: Record<AlertTier['key'], AlertTier> = {
  wait_and_watch: { key: 'wait_and_watch', label: 'Wait & Watch', tone: 'warning' },
  side_in_focus: { key: 'side_in_focus', label: 'Side in Focus', tone: 'brand' },
  milestone: { key: 'milestone', label: 'Progress', tone: 'positive' },
  invalidation: { key: 'invalidation', label: 'Invalidation reached', tone: 'negative' },
  projected: { key: 'projected', label: 'Projected level reached', tone: 'positive' },
  structure: { key: 'structure', label: 'Structure shifting', tone: 'warning' },
  in_trade: { key: 'in_trade', label: 'In trade', tone: 'neutral' },
};

function readMetadata(alert: AlertLike): Record<string, unknown> | null {
  const meta = alert.metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  return meta as Record<string, unknown>;
}

/**
 * The tier for a notification, or null when it is not a tiered Sentinel alert
 * — a non-Sentinel category, or one of the older Sentinel notifications
 * written before tiers existed. Callers fall back to the category badge, which
 * is what every notification showed before this.
 */
export function alertTier(alert: AlertLike): AlertTier | null {
  if (alert.category !== 'sentinel') return null;
  const meta = readMetadata(alert);
  if (!meta) return null;

  const tier = typeof meta.tier === 'string' ? meta.tier : null;
  if (tier === 'wait_and_watch') return TIERS.wait_and_watch;
  if (tier === 'side_in_focus') return TIERS.side_in_focus;
  if (tier !== 'in_trade') return null;

  // In-trade alerts all share one tier; the event is what separates "you are
  // up 2R" from "the level you called wrong was reached".
  switch (typeof meta.event === 'string' ? meta.event : '') {
    case 'milestone': {
      const milestone = typeof meta.milestone === 'string' ? meta.milestone : null;
      // "1R" → "1:1 reached", the same phrasing the alert body uses.
      return milestone
        ? { ...TIERS.milestone, label: `${milestone.replace(/R$/, ':1')} reached` }
        : TIERS.milestone;
    }
    case 'invalidation_reached':
      return TIERS.invalidation;
    case 'projected_level_reached':
      return TIERS.projected;
    case 'structure_break':
      return TIERS.structure;
    default:
      return TIERS.in_trade;
  }
}

/**
 * The measured R-multiple an in-trade alert carries, for the small mono chip
 * beside the tier. null whenever the producer did not send a number — never a
 * zero standing in for "unknown".
 */
export function alertRMultiple(alert: AlertLike): number | null {
  const meta = readMetadata(alert);
  const value = meta?.rMultiple;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The watch a Sentinel alert came from, so the bell can deep-link to it. */
export function alertWatchId(alert: AlertLike): string | null {
  const meta = readMetadata(alert);
  return typeof meta?.watchSessionId === 'string' ? meta.watchSessionId : null;
}
