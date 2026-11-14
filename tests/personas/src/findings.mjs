// Findings model. A step ends in exactly one of three states, and the
// distinction is the whole point of this file:
//
//   pass     — the step ran and what the customer would expect happened.
//   finding  — the step ran and something the customer would notice is WRONG:
//              a product problem Claude can act on.
//   blocked  — the step could NOT run because the test environment lacks
//              something (no live market feed, no email). Never a pass and
//              never a product finding: it says nothing about the app.
//
// A run that cannot reach a step must not look like it succeeded.

import { createHash } from 'node:crypto';

export const SEVERITY = {
  S1: 'broken — the customer cannot do what they came to do, or the app crashed',
  S2: 'wrong or confusing — works, but misleads or surprises the customer',
  S3: 'polish — small, but a real customer would notice',
};

/** Words that identify a failure as the environment's, not the product's. */
const ENVIRONMENT_PATTERNS = [
  // Antivirus web-protection scripts injected into the page (not part of the app).
  /kaspersky-labs\.com/i,
  // /feed/* is the web app's proxy to the market-data bridge (port 4600); a 5xx there means the bridge is not running.
  /\/feed\/(stream|quotes|optionchain|candles|instrument)/i,
  // The app's own dev API is restarting or down (its watcher recompiles on file changes).
  /ERR_CONNECTION_REFUSED/i,
  /could not reach dhan/i,
  /connection problem, not a statement/i,
  /market-data bridge could not be reached/i,
  /live feed not connected/i,
  /market data api not connected/i,
  /market data is temporarily unavailable/i,
  /live[- ]feed/i,
  /bridge/i,
  /could not resolve instrument/i,
  /no live (quote|price)/i,
  /feed (is )?(down|unavailable|not)/i,
  /ECONNREFUSED.*:4600/i,
  /:4600/,
];

export function isEnvironmentFailure(text) {
  return ENVIRONMENT_PATTERNS.some((re) => re.test(text ?? ''));
}

/** Strip the parts of a message that change between runs (ids, numbers, times). */
function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Stable across runs, so a day-to-day comparison can say "still there / fixed / new". */
export function findingId({ persona, route, kind, message }) {
  return createHash('sha1')
    .update([persona, route, kind, normalise(message)].join('|'))
    .digest('hex')
    .slice(0, 10);
}

/** IST wall clock — market hours and the 15:15 square-off change what is correct. */
export function istStamp(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '';
  const hh = g('hour') === '24' ? '00' : g('hour');
  const minute = Number(hh) * 60 + Number(g('minute'));
  const weekend = ['Sat', 'Sun'].includes(g('weekday'));
  let session = 'market closed';
  if (!weekend && minute >= 555 && minute < 930) session = 'market session open (09:15–15:30)';
  if (!weekend && minute >= 915 && minute < 930) session = 'square-off window (15:15–15:30)';
  return {
    iso: d.toISOString(),
    ist: `${g('year')}-${g('month')}-${g('day')} ${hh}:${g('minute')} IST (${g('weekday')})`,
    session,
  };
}
