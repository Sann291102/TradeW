import { describe, expect, it } from 'vitest';
import {
  archiveCandidates,
  archiveDay,
  datasetUrl,
  resolveDataset,
  NSE_DATASETS,
  NSE_DATASET_IDS,
} from './nse-datasets';

/**
 * The catalogue is the only thing standing between a caller-supplied string
 * and an outbound request from inside this network. These assertions pin that
 * boundary: nothing outside the catalogue resolves, no dataset points anywhere
 * but NSE, and the one path segment that is interpolated cannot be anything
 * other than eight digits.
 */

describe('resolveDataset — the allowlist', () => {
  it('resolves every catalogued id', () => {
    for (const id of NSE_DATASET_IDS) {
      expect(resolveDataset(id)?.id).toBe(id);
    }
  });

  it('refuses anything not in the catalogue', () => {
    for (const bad of ['', 'unknown', 'FII-DII-CASH', 'fii-dii', '../fii-dii-cash']) {
      expect(resolveDataset(bad)).toBeNull();
    }
  });

  it('refuses a near-miss rather than fuzzy-matching a neighbour', () => {
    // A prefix match here would silently fetch a different report than the
    // caller named, which is worse than failing.
    expect(resolveDataset('fii')).toBeNull();
    expect(resolveDataset('indices-all')).toBeNull();
  });

  it('refuses non-strings, including objects that stringify to a valid id', () => {
    for (const bad of [null, undefined, 42, {}, ['indices'], { toString: () => 'indices' }]) {
      expect(resolveDataset(bad)).toBeNull();
    }
  });
});

describe('the catalogue itself', () => {
  it('points only at NSE hosts', () => {
    for (const dataset of Object.values(NSE_DATASETS)) {
      const url = datasetUrl(dataset, '14082026');
      expect(url).not.toBeNull();
      expect(new URL(url!).hostname).toBe(dataset.host);
      expect(new URL(url!).hostname.endsWith('nseindia.com')).toBe(true);
    }
  });

  it('uses https everywhere', () => {
    for (const dataset of Object.values(NSE_DATASETS)) {
      expect(datasetUrl(dataset, '14082026')!.startsWith('https://')).toBe(true);
    }
  });

  it('marks the end-of-day publications as such', () => {
    // These describe a COMPLETED session. A consumer that renders them without
    // their date is asserting today's institutions have already acted.
    expect(NSE_DATASETS['fii-dii-cash'].endOfDay).toBe(true);
    expect(NSE_DATASETS['participant-oi'].endOfDay).toBe(true);
    expect(NSE_DATASETS.indices.endOfDay).toBe(false);
  });

  it('caches end-of-day datasets for far longer than live ones', () => {
    // Re-fetching a report that is published once a day, once a minute, would
    // make this platform a nuisance to a public exchange for no new data.
    expect(NSE_DATASETS['fii-dii-cash'].ttlMs).toBeGreaterThan(NSE_DATASETS.indices.ttlMs);
  });
});

describe('datasetUrl — the one interpolated segment', () => {
  const archive = NSE_DATASETS['participant-oi'];

  it('builds the archive filename from an eight-digit day', () => {
    expect(datasetUrl(archive, '14082026')).toContain('fao_participant_oi_14082026.csv');
  });

  it('refuses a day that is not exactly eight digits', () => {
    // The producer is `archiveCandidates`, but this is where a string becomes
    // part of a URL, so this is where it has to be certain.
    for (const bad of ['', '1408202', '140820266', '2026-08-14', '14082026/..', '../../etc']) {
      expect(datasetUrl(archive, bad)).toBeNull();
    }
  });

  it('refuses a missing day for a dated dataset', () => {
    expect(datasetUrl(archive)).toBeNull();
  });

  it('ignores a day supplied for an undated dataset', () => {
    expect(datasetUrl(NSE_DATASETS.indices, 'whatever')).toBe(NSE_DATASETS.indices.path);
  });
});

describe('archive day selection', () => {
  it('formats a date as DDMMYYYY', () => {
    expect(archiveDay(new Date(Date.UTC(2026, 7, 14)))).toBe('14082026');
    // Zero padding is the trap: "1082026" is a different, valid-looking file.
    expect(archiveDay(new Date(Date.UTC(2026, 0, 5)))).toBe('05012026');
  });

  it('skips weekends — there is no archive for a day the market did not trade', () => {
    // Sunday 16 Aug 2026 → Fri 14th, Thu 13th, Wed 12th…
    const days = archiveCandidates(new Date(Date.UTC(2026, 7, 16)), 3);
    expect(days).toEqual(['14082026', '13082026', '12082026']);
  });

  it('includes today when today is a weekday', () => {
    // The file may not exist yet (it lands after the close), which is handled
    // by walking to the next candidate — but it must be TRIED first.
    expect(archiveCandidates(new Date(Date.UTC(2026, 7, 14)), 2)).toEqual(['14082026', '13082026']);
  });

  it('returns the requested number of candidates', () => {
    expect(archiveCandidates(new Date(Date.UTC(2026, 7, 16)), 5)).toHaveLength(5);
  });
});
