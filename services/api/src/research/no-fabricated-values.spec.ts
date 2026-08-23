import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * THE REGRESSION GATE.
 *
 * `docs/audits/SIDEBAR-FEATURE-REALITY-AUDIT.md` §4.8 recorded exactly what the
 * old `/research` rendered: an "AI summary" with a fabricated confidence score
 * and quality ratings, a fixed set of fundamentals identical for every symbol,
 * two contradictory market-cap figures on one screen, and a price that fell back
 * to a hardcoded literal.
 *
 * Those values are gone. This test exists so they cannot come back — not by a
 * revert, not by a copy-paste from the archived file, not by someone "restoring
 * the old design" from a screenshot. It reads the research render path off disk
 * and fails on the literals themselves.
 *
 * ── WHY A SOURCE SCAN AND NOT A RENDER ASSERTION ───────────────────────────
 *
 * A render assertion can only cover the states a test happens to drive. The
 * defect being guarded is a CONSTANT — it does not depend on state, which is
 * precisely what made it survive every manual review of the old page. Scanning
 * the source catches it in any branch, including one that only renders when a
 * provider is down.
 */

const ROOT = resolve(__dirname, '../../../..');

/** Everything that renders, serves or shapes the research surface. */
const SCANNED_DIRS = [
  'apps/web/src/app/(workspace)/research',
  'apps/web/src/components/research',
  'apps/web/src/lib/research',
  'services/api/src/research',
  'packages/market-data/src/providers/fundamentals',
];

/**
 * The literals from the old page. Each is paired with what it was, so a future
 * failure explains itself without anyone needing to find the audit.
 *
 * Regex, not substring, so a reformat (`19,73,284` → `1973284`) does not slip
 * through, and so a legitimate use in prose (a comment quoting the audit) can be
 * excluded deliberately rather than by accident.
 */
const FORBIDDEN: Array<{ pattern: RegExp; was: string }> = [
  { pattern: /19[,_]?73[,_]?284/, was: 'the header market cap, ₹19,73,284 Cr' },
  { pattern: /19[,_]?81[,_]?568/, was: 'the Key Metrics market cap, ₹19,81,568 Cr — the contradictory second figure' },
  { pattern: /\b2945\.20\b/, was: "the hardcoded RELIANCE price fallback" },
  { pattern: /\b2820\.00\b|₹2,820\.00/, was: 'the fabricated analyst target' },
  { pattern: /\b9\.2\s*\/\s*10\b/, was: 'the "Business Quality 9.2/10" score' },
  { pattern: /\b8\.8\s*\/\s*10\b/, was: 'the "Financial Health 8.8/10" score' },
  { pattern: /Confidence\s*8?7\s*%/i, was: 'the "Confidence 87%" figure' },
  { pattern: /\b24\.62\b/, was: 'the hardcoded P/E' },
  { pattern: /\b14\.28\s*%/, was: 'the hardcoded ROE' },
  { pattern: /\b17\.62\s*%/, was: 'the hardcoded ROCE' },
  { pattern: /119\.61/, was: 'the hardcoded EPS' },
  { pattern: /\b50\.13\s*%/, was: 'the hardcoded promoter holding' },
  { pattern: /\b24\.71\s*%/, was: 'the hardcoded FII holding' },
  { pattern: /\b15\.36\s*%/, was: 'the hardcoded DII holding' },
];

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a directory that does not exist yet is not a failure
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out = out.concat(walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Files allowed to NAME the old values — this test, and the audit fixtures. */
function isAllowlisted(file: string): boolean {
  return file.endsWith('no-fabricated-values.spec.ts');
}

/**
 * Strip comments before matching.
 *
 * The rule is about values this code RENDERS, not values it discusses. Several
 * files deliberately quote the old figures in their docstrings so a reader knows
 * what was removed and why — that documentation is the opposite of the defect,
 * and a guard that forbade it would push the explanation out of the code.
 *
 * String literals are preserved: a fabricated value pasted into JSX text is
 * exactly what must still be caught.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line.replace(/(^|[^:])\/\/.*$/, '$1')))
    .join('\n');
}

const files = SCANNED_DIRS.flatMap((d) => walk(join(ROOT, d))).filter((f) => !isAllowlisted(f));

describe('the fabricated research values cannot reappear', () => {
  it('scans a non-empty set of files (the guard must not pass vacuously)', () => {
    // Without this, deleting or renaming the research directories would make
    // every assertion below trivially true.
    expect(files.length).toBeGreaterThan(5);
  });

  for (const { pattern, was } of FORBIDDEN) {
    it(`does not contain ${was}`, () => {
        const offenders = files.filter((file) => pattern.test(code(file)));
      expect(
        offenders.map((f) => f.replace(`${ROOT}/`, '')),
        `${was} reappeared in the research render path`,
      ).toEqual([]);
    });
  }

  it('has no hardcoded rupee/dollar magnitude literals in the web render path', () => {
    // Currency amounts on this surface must arrive from the API. A literal like
    // `₹19,73,284 Cr` or `$1,500.00` in a component is, by construction, a
    // number no provider produced.
    const webFiles = files.filter((f) => f.includes('apps/web'));
    const currencyLiteral = /['"`][^'"`]*[₹$]\s?\d[\d,]{3,}[^'"`]*['"`]/;
    const offenders = webFiles.filter((file) => currencyLiteral.test(code(file)));
    expect(offenders.map((f) => f.replace(`${ROOT}/`, ''))).toEqual([]);
  });

  it('has no numeric fallback operator against a rendered value in the web render path', () => {
    // `value ?? 0` and `value || 24.3` are how an absent metric becomes a
    // confident zero. The research UI must branch on presence instead.
    const webFiles = files.filter((f) => f.includes('apps/web'));
    const numericFallback = /(\?\?|\|\|)\s*-?\d+(\.\d+)?\s*[;,)\]}]/;
    const offenders = webFiles.filter((file) => numericFallback.test(code(file)));
    expect(
      offenders.map((f) => f.replace(`${ROOT}/`, '')),
      'a numeric fallback in the research UI turns "not reported" into a number',
    ).toEqual([]);
  });

  it('the old page component is gone from the route', () => {
    const page = code(join(ROOT, 'apps/web/src/app/(workspace)/research/page.tsx'));
    // The old page was a 'use client' component that held all of the above
    // inline. The route is now a server component delegating to a client.
    expect(page).not.toContain('POPULAR_STOCKS');
    expect(page).not.toContain('TradeW AI Summary');
    expect(page).not.toMatch(/activeTab/);
  });
});
