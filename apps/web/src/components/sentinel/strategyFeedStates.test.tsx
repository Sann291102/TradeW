/**
 * The Strategy Feed must render a CARD in every state it can be in.
 *
 * The bug this pins, reported as "the strategy feed is missing": the panel
 * began `if (loading) return null`, and the "Strategy Feed" heading lives
 * inside its shell. So while the watch list was in flight the dashboard band
 * showed a card, a card, and a hole — and a request that never settles
 * (sentinel-py down behind a timeout) was indistinguishable from a feature
 * that does not exist.
 *
 * The second half is worse than a hole. `useWatchSessions` has always returned
 * `fault`/`reconnecting` and the panel ignored both, so a failed
 * `/sentinel-py/watch` fell back to `watches: []` and the feed said "Start
 * watching a strategy to see live updates" — telling the user to create a
 * watch when the truth was that the service could not be reached, and hiding
 * the watches they may already have had running.
 *
 * Asserted against the real component with the data hooks stubbed, because the
 * property is about which branch renders, not about network behaviour.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StrategyTimelineFeed } from './StrategyTimelineFeed';
import type { SentinelUnavailable } from '@/lib/sentinel/faults';
import type { WatchSession } from '@/lib/sentinel/strategyApi';
import { DEFAULT_SELECTION, resolveWatchContext } from '@/lib/sentinel/watchState';

const watchesState = vi.hoisted(() => ({
  current: {
    watches: [] as WatchSession[],
    loading: false,
    fault: null as SentinelUnavailable | null,
    reconnecting: null as SentinelUnavailable | null,
    refresh: async () => {},
    start: async () => ({}) as WatchSession,
    markEntered: async () => ({}) as WatchSession,
    markClosed: async () => ({}) as WatchSession,
  },
}));

vi.mock('@/lib/sentinel/useStrategyWorkspace', () => ({
  useWatchSessions: () => watchesState.current,
}));

// The feed reads the canonical selection and publishes to it; neither is what
// is under test here, so it is stubbed to the default rather than wrapped in a
// provider (which would pull in the live chain and expiry polls).
vi.mock('@/lib/sentinel/WatchContext', () => ({
  useSentinelWatch: () => ({
    selection: DEFAULT_SELECTION,
    instruments: resolveWatchContext(DEFAULT_SELECTION),
    adoptWatch: () => {},
    syncWatches: () => {},
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: null, error: null, state: { status: 'success' } }),
}));

vi.mock('@/lib/store/sessionStore', () => ({
  useSessionStore: () => 'user-1',
}));

function render() {
  return renderToStaticMarkup(<StrategyTimelineFeed showFocusPanel={false} />);
}

function set(over: Partial<typeof watchesState.current>) {
  watchesState.current = { ...watchesState.current, ...over };
}

afterEach(() => {
  set({ watches: [], loading: false, fault: null, reconnecting: null });
});

describe('the Strategy Feed always renders its card', () => {
  it('renders the panel — not nothing — while the watch list is loading', () => {
    set({ loading: true });
    const html = render();
    // The regression: this returned '' and the dashboard column collapsed.
    expect(html).not.toBe('');
    expect(html).toContain('Strategy Feed');
    expect(html).toContain('Checking which strategies you have running');
  });

  it('renders the panel when the watch list could not be loaded', () => {
    set({ fault: { kind: 'api-unreachable' } });
    const html = render();
    expect(html).toContain('Strategy Feed');
    expect(html).toContain('could not be reached');
  });

  it('renders the panel for a genuine empty list', () => {
    const html = render();
    expect(html).toContain('Strategy Feed');
    expect(html).toContain('Start watching a strategy');
  });
});

describe('a feed fault is never presented as an empty feed', () => {
  it('says the service could not be reached instead of "start watching"', () => {
    set({ fault: { kind: 'api-unreachable' } });
    const html = render();
    // The dishonest message: it instructs the user to create a watch when the
    // truth is nothing could be read — and they may already have several.
    expect(html).not.toContain('Start watching a strategy');
  });

  it('names an entitlement fault as such rather than as "no watches"', () => {
    set({ fault: { kind: 'entitlement-required' } });
    const html = render();
    expect(html).toContain('Sentinel Pro');
    expect(html).not.toContain('Start watching a strategy');
  });

  it('names an authentication fault as such', () => {
    set({ fault: { kind: 'unauthenticated' } });
    const html = render();
    expect(html).toContain('Sign in');
    expect(html).not.toContain('Start watching a strategy');
  });

  it('offers a retry rather than leaving the panel dead', () => {
    set({ fault: { kind: 'api-unreachable' } });
    expect(render()).toContain('Try again');
  });
});

describe('a transient reconnect is reported, not hidden', () => {
  it('says the list on screen is the last one that loaded', () => {
    // A transient failure KEEPS the cached rows, so the honest thing is to
    // show them and say they may be stale — not to blank the panel.
    set({ reconnecting: { kind: 'api-unreachable' } });
    const html = render();
    expect(html).toContain('Reconnecting');
    expect(html).toContain('last loaded copy');
  });

  it('does not claim to be reconnecting when nothing is failing', () => {
    expect(render()).not.toContain('Reconnecting');
  });
});
