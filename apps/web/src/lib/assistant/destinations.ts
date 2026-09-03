import { NAV_ITEMS, NAV_ALIASES } from '@/components/shell/nav-config';

/**
 * Everywhere the assistant can take you, and what each place is called.
 *
 * ── THE BUG THIS FILE EXISTS TO FIX ────────────────────────────────────────
 *
 * `commands.ts#matchNav` derived its entire vocabulary from `NAV_ITEMS`. The
 * instinct was right — one source of truth, so adding a page to the sidebar
 * makes it commandable automatically — but the source was wrong. `NAV_ITEMS`
 * is a *presentation* concern: it gets reorganised for product reasons.
 *
 * On the day Crypto and Forex stopped being sidebar entries and became venue
 * tabs inside Markets, they vanished from the assistant's vocabulary with no
 * test failing and nothing logged. "Open crypto" then fell through the whole
 * command cascade and was answered with the analysis fallback — a sentence
 * claiming the analysis engine was unbuilt, when the truth was that the word
 * "crypto" no longer named anything the resolver could see. The destination
 * had not been removed: `/crypto` still resolves, `NAV_ALIASES` still maps it
 * to `/markets?cat=crypto`, and the server's own route allowlist still listed
 * it. Only the client grammar lost it.
 *
 * So the agent gets its own registry, of which `NAV_ITEMS` is one contributor
 * among several. A sidebar refactor can no longer silently delete a capability,
 * and `destinations.test.ts` asserts exactly that: every `NAV_ALIASES` key and
 * every market venue must be addressable here.
 */

export type DestinationKind = 'page' | 'venue' | 'view';

export interface Destination {
  /** Stable id. Plans name this, never a raw href — a destination id cannot be
   *  an open redirect, and it survives the href changing underneath it. */
  id: string;
  kind: DestinationKind;
  /** What the assistant calls it when confirming: "Opened Crypto." */
  label: string;
  href: string;
  /** Spoken and typed forms. Matched longest-first. */
  aliases: string[];
}

/**
 * Market venues — boards inside the Markets workspace.
 *
 * These are the entries `NAV_ITEMS` cannot supply, because a venue is a tab and
 * not a page. The `?cat=` values are load-bearing URLs (see `CATEGORY_BY_PARAM`
 * in `MarketsWorkspace`), not internal state.
 */
const VENUES: Destination[] = [
  {
    id: 'venue.crypto',
    kind: 'venue',
    label: 'Crypto',
    href: '/markets?cat=crypto',
    aliases: ['crypto', 'cryptocurrency', 'crypto board', 'crypto market', 'coins', 'digital assets'],
  },
  {
    id: 'venue.forex',
    kind: 'venue',
    label: 'Forex',
    href: '/markets?cat=forex',
    aliases: ['forex', 'fx', 'currencies', 'currency pairs', 'foreign exchange'],
  },
  {
    id: 'venue.indices',
    kind: 'venue',
    label: 'Indices',
    href: '/markets?cat=indices',
    aliases: ['indices', 'index board', 'indexes'],
  },
  {
    id: 'venue.stocks',
    kind: 'venue',
    label: 'Stocks',
    href: '/markets?cat=stocks',
    aliases: ['stocks board', 'equities', 'stock board'],
  },
  {
    id: 'venue.etfs',
    kind: 'venue',
    label: 'ETFs',
    href: '/markets?cat=etfs',
    aliases: ['etfs', 'etf board', 'exchange traded funds'],
  },
  {
    id: 'venue.commodities',
    kind: 'venue',
    label: 'Commodities',
    href: '/markets?cat=commodities',
    aliases: ['commodities', 'commodity board', 'mcx'],
  },
];

/** Pages, derived from the sidebar exactly as before — one contributor now. */
function pageDestinations(): Destination[] {
  return NAV_ITEMS.map((item) => ({
    id: `page.${item.href.replace(/^\//, '')}`,
    kind: 'page' as const,
    label: item.label,
    href: item.href,
    aliases: [item.label.toLowerCase()],
  }));
}

/**
 * Routes that redirect rather than render.
 *
 * `NAV_ALIASES` is the repo's own record of "this URL still resolves, somewhere
 * else". Every one of them is a phrase a user can reasonably say, so every one
 * of them is folded in here — including the two that started this whole
 * investigation. Where a venue already claims the words, the venue wins and the
 * alias contributes nothing: `destinations.test.ts` checks reachability, not
 * that a second entry exists.
 */
function aliasDestinations(taken: Set<string>): Destination[] {
  const out: Destination[] = [];
  for (const [from, to] of Object.entries(NAV_ALIASES)) {
    const word = from.replace(/^\//, '');
    if (taken.has(word)) continue;
    out.push({
      id: `alias.${word}`,
      kind: 'page',
      label: word.charAt(0).toUpperCase() + word.slice(1),
      href: to,
      aliases: [word],
    });
  }
  return out;
}

/** The registry, assembled once. Venues first so they win the shared words. */
export const DESTINATIONS: readonly Destination[] = (() => {
  const list = [...VENUES, ...pageDestinations()];
  const taken = new Set(list.flatMap((d) => d.aliases));
  return [...list, ...aliasDestinations(taken)];
})();

export function destinationById(id: string): Destination | null {
  return DESTINATIONS.find((d) => d.id === id) ?? null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every (phrase, destination) pair, longest phrase first so a two-word name
 *  can never be shadowed by a one-word one — the ordering `matchNav` already
 *  relied on, now applying across venues and aliases too. */
const NEEDLES: ReadonlyArray<{ needle: string; dest: Destination }> = DESTINATIONS
  .flatMap((dest) => dest.aliases.map((needle) => ({ needle: needle.toLowerCase(), dest })))
  .sort((a, b) => b.needle.length - a.needle.length);

export interface DestinationMatch {
  dest: Destination;
  /** The phrase that matched — surfaced in the trace. */
  matched: string;
}

/**
 * Find the destination named in `text`, or null.
 *
 * Deliberately does NOT decide whether the utterance is a command: a bare
 * mention ("how does the dashboard work") is a question about the app, not a
 * request to navigate. That judgement stays in `commands.ts`, which owns the
 * verb requirement. This function answers one question only — is a place named
 * here, and which one.
 */
export function matchDestination(text: string): DestinationMatch | null {
  const lower = text.toLowerCase();
  for (const { needle, dest } of NEEDLES) {
    if (new RegExp(`\\b${escapeRe(needle)}\\b`).test(lower)) return { dest, matched: needle };
  }
  return null;
}
