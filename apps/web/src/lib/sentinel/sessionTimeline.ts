/**
 * The session narrative, as the horizontal track the dashboard draws.
 *
 * ── THE ORDERING BUG THIS MODULE EXISTS TO FIX ─────────────────────────────
 * `MarketTimelineEngine` appends entries in the order it is TOLD about them
 * and returns them in that order, but the times it stamps them with are market
 * times, not append times: a strategy detection is placed at `detectedAt` (the
 * bar its rules matched on) while a guidance entry is placed at the poll
 * clock. Those are the two halves of the 2026-08-13 autonomy fix, and they are
 * both correct — but a detection recorded on the 10:20 poll can carry a 10:05
 * bar time and still be appended after a 10:18 guidance entry.
 *
 * The list therefore arrives *almost* sorted and is rendered left-to-right as
 * a chronological track, which is the worst combination: it looks right most
 * of the time, so the occasional entry sitting out of sequence reads as the
 * market having done something at a time it did not. Sorting on `at` — the
 * ISO instant, never the `HH:mm` label, which cannot order across a day
 * boundary and is a string — is the whole fix.
 *
 * Everything else here is presentation: the engine writes one prose sentence
 * per entry, and the reference layout wants a short phase label above a
 * detail line. The split is taken from the sentence's own punctuation, so no
 * text is invented and none is lost — a sentence that does not split keeps its
 * level's title and stays whole in the detail.
 */

import type { MarketStateValue, TimelineEntry, TimelineLevel } from './types';

export type Tone = 'up' | 'down' | 'amber' | 'teal' | 'neutral';

export interface TimelineDot {
  /** HH:mm IST, precomputed server-side so every surface renders it identically. */
  time: string;
  /** The ISO instant behind `time` — what ordering is actually done on. */
  at: string;
  /** Short phase label, e.g. "Market open" or "Session classified". */
  title: string;
  /** The rest of the sentence, or the whole of it when it did not split. */
  detail: string;
  /** One extra fact worth a line: the state reached, or the confidence scored. */
  meta: string;
  level: TimelineLevel;
  tone: Tone;
  /** The newest entry in the session — the phase the market is in right now. */
  latest: boolean;
}

const LEVEL_TONE: Record<TimelineLevel, Tone> = {
  info: 'teal',
  observation: 'teal',
  setup: 'amber',
  guidance: 'up',
  transition: 'neutral',
};

const LEVEL_TITLE: Record<TimelineLevel, string> = {
  info: 'Session note',
  observation: 'Observation',
  setup: 'Setup',
  guidance: 'Guidance',
  transition: 'State change',
};

/**
 * How long a leading clause may be before it stops being a label. Past this a
 * "title" is just the sentence wrapped twice, so the level's own title is used
 * and the sentence stays intact below it.
 */
const MAX_TITLE = 34;

/** Split the engine's sentence at its own first separator. */
function splitEvent(event: string, level: TimelineLevel): { title: string; detail: string } {
  const text = event.trim();
  if (!text) return { title: LEVEL_TITLE[level], detail: '' };

  // Longest separator first: " — " must win over ":" in
  // "Session classified as X — description", where both are present.
  for (const sep of [' — ', ' – ', ': ']) {
    const index = text.indexOf(sep);
    if (index > 0 && index <= MAX_TITLE) {
      return { title: text.slice(0, index).trim(), detail: text.slice(index + sep.length).trim() };
    }
  }

  return { title: LEVEL_TITLE[level], detail: text };
}

function humanizeState(state: MarketStateValue): string {
  return state
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The third line of a dot. Prefers the state the session reached over the
 * confidence, because a state is a fact about the session while a confidence
 * is a fact about one reading — and when both fit on one line the state is the
 * one a trader scanning a track is looking for.
 */
function metaLine(entry: TimelineEntry): string {
  if (entry.state) return humanizeState(entry.state);
  if (entry.confidence != null) return `${Math.round(entry.confidence)}% confidence`;
  return '';
}

/**
 * Entries → dots, oldest first (left to right), strictly ordered by the
 * instant each event happened at.
 *
 * Ties keep their original relative order: several detections genuinely share
 * one bar's timestamp (they matched on the same candle), and re-ordering them
 * against each other would assert a sequence the data does not contain.
 */
export function toTimelineDots(entries: TimelineEntry[] | undefined): TimelineDot[] {
  if (!entries?.length) return [];

  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const at = Date.parse(a.entry.at);
      const bt = Date.parse(b.entry.at);
      // An unparseable timestamp must not silently sort to the epoch and drag
      // an entry to the front of the session; it holds its position instead.
      if (Number.isNaN(at) || Number.isNaN(bt) || at === bt) return a.index - b.index;
      return at - bt;
    })
    .map(({ entry }) => entry);

  return ordered.map((entry, i) => {
    const { title, detail } = splitEvent(entry.event, entry.level);
    return {
      time: entry.time,
      at: entry.at,
      title,
      detail,
      meta: metaLine(entry),
      level: entry.level,
      tone: LEVEL_TONE[entry.level] ?? 'neutral',
      latest: i === ordered.length - 1,
    };
  });
}
