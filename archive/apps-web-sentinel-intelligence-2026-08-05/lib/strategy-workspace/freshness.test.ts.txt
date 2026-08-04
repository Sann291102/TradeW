import { describe, expect, it } from 'vitest';
import { freshnessLabel } from './freshness';

describe('freshnessLabel', () => {
  it('reports not-yet-loaded before any fetch has completed', () => {
    expect(freshnessLabel(null)).toBe('not yet loaded');
  });

  it('rounds sub-5s deltas to "just now"', () => {
    expect(freshnessLabel(1000, 1000)).toBe('just now');
    expect(freshnessLabel(1000, 4999)).toBe('just now');
  });

  it('reports seconds under a minute', () => {
    expect(freshnessLabel(0, 12_000)).toBe('12s ago');
    expect(freshnessLabel(0, 59_000)).toBe('59s ago');
  });

  it('reports minutes under an hour', () => {
    expect(freshnessLabel(0, 60_000)).toBe('1m ago');
    expect(freshnessLabel(0, 45 * 60_000)).toBe('45m ago');
  });

  it('reports hours beyond that', () => {
    expect(freshnessLabel(0, 3 * 3_600_000)).toBe('3h ago');
  });

  it('never reports a negative age from clock skew', () => {
    expect(freshnessLabel(10_000, 5_000)).toBe('just now');
  });
});
