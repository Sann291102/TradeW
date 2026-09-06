import { describe, expect, it } from 'vitest';
import { NAV_ALIASES, NAV_ITEMS } from '@/components/shell/nav-config';
import { DESTINATIONS, matchDestination } from './destinations';
import { resolveUtterance } from './router';

/**
 * The regression this file exists for.
 *
 * "Open crypto" was answered with "my analysis engine isn't wired up yet" —
 * a sentence about a missing feature, produced because a sidebar refactor had
 * quietly removed Crypto from `NAV_ITEMS`, which was the only thing the
 * navigation grammar read. Nothing failed. Nothing logged. The route still
 * worked if you typed it, and the server's own allowlist still contained it.
 *
 * The first two tests below are the ones that make that class of silent
 * capability loss impossible to reintroduce: every redirect the app declares,
 * and every market venue, must be reachable by speaking its name.
 */

describe('the destination registry covers everything the app declares', () => {
  it('makes every NAV_ALIASES route addressable', () => {
    // NAV_ALIASES is the repo's own record of "this URL still resolves,
    // somewhere else". Each key is a word a user can reasonably say.
    for (const from of Object.keys(NAV_ALIASES)) {
      const word = from.replace(/^\//, '');
      const hit = matchDestination(word);
      expect(hit, `"${word}" names nothing the assistant can reach`).not.toBeNull();
    }
  });

  it('makes every market venue addressable', () => {
    for (const venue of ['crypto', 'forex', 'indices', 'commodities']) {
      const hit = matchDestination(venue);
      expect(hit, `venue "${venue}" is unreachable`).not.toBeNull();
      expect(hit!.dest.href).toContain('/markets?cat=');
    }
  });

  it('still makes every sidebar page addressable', () => {
    for (const item of NAV_ITEMS) {
      const hit = matchDestination(item.label.toLowerCase());
      expect(hit, `page "${item.label}" is unreachable`).not.toBeNull();
    }
  });

  it('gives every destination a unique id', () => {
    const ids = DESTINATIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('resolveUtterance — the failing utterances from the bug report', () => {
  it('opens the crypto board instead of claiming the analysis engine is missing', () => {
    const plan = resolveUtterance('Open crypto');
    expect(plan.intent).toBe('command');
    expect(plan.actions).toEqual([{ type: 'navigate', href: '/markets?cat=crypto' }]);
    // The exact wording of the old failure, which must never come back for this.
    expect(plan.reply).not.toMatch(/analysis engine/i);
  });

  it('opens forex the same way', () => {
    const plan = resolveUtterance('show me forex');
    expect(plan.intent).toBe('command');
    expect(plan.actions).toEqual([{ type: 'navigate', href: '/markets?cat=forex' }]);
  });

  it('resolves a crypto instrument by ticker', () => {
    const plan = resolveUtterance('open BTC chart');
    expect(plan.intent).toBe('command');
    expect(plan.actions).toContainEqual({ type: 'selectSymbol', symbol: 'BTCUSDT' });
  });

  it('resolves a crypto instrument by name', () => {
    const plan = resolveUtterance('open bitcoin chart');
    expect(plan.actions).toContainEqual({ type: 'selectSymbol', symbol: 'BTCUSDT' });
  });

  it('leaves the existing NSE behaviour alone', () => {
    const plan = resolveUtterance('open NIFTY 50 chart');
    expect(plan.intent).toBe('command');
    expect(plan.actions).toContainEqual({ type: 'selectSymbol', symbol: 'NIFTY' });
  });

  it('does not navigate on a bare mention that is plainly a question', () => {
    // The verb requirement from the original matchNav, preserved.
    const plan = resolveUtterance('how does the dashboard work');
    expect(plan.actions).toEqual([]);
  });
});
