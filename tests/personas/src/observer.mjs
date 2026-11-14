// The shared observer: what any customer would notice, recorded for every
// persona without each journey having to remember to look.
//
// It only OBSERVES. It never clicks, retries or hides anything.

const SLOW_MS = 4000;

/** Requests that are noise for a customer's experience. */
const IGNORED_URL = [/_next\/static/, /\/_next\/image/, /hot-update/, /favicon/, /\/__nextjs/];

/** Text that a customer reads as "something broke". */
const ERROR_TEXT = /something went wrong|unexpected error|internal server error|failed to (load|fetch)|could not (load|reach)|application error|temporarily unavailable/i;

export function attachObserver(page, sink) {
  const seen = new Set();
  const once = (key, fn) => {
    if (seen.has(key)) return;
    seen.add(key);
    fn();
  };

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // A failed network request already produces its own console line; the
    // response listener below reports it with the URL, so skip the echo.
    if (/Failed to load resource/i.test(text)) return;
    once(`console:${text}`, () => sink({ kind: 'console-error', severity: 'S2', message: text.slice(0, 400), where: page.url() }));
  });

  page.on('pageerror', (err) => {
    once(`pageerror:${err.message}`, () =>
      sink({ kind: 'page-crash', severity: 'S1', message: `Uncaught error: ${err.message}`.slice(0, 400), where: page.url() }),
    );
  });

  page.on('requestfailed', (req) => {
    const url = req.url();
    if (IGNORED_URL.some((re) => re.test(url))) return;
    const reason = req.failure()?.errorText ?? 'failed';
    if (/ERR_ABORTED/.test(reason)) return; // navigation cancelled a pending request — normal
    once(`reqfail:${req.method()} ${url}`, () =>
      sink({ kind: 'request-failed', severity: 'S2', message: `${req.method()} ${trimUrl(url)} — ${reason}`, where: page.url() }),
    );
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (IGNORED_URL.some((re) => re.test(url))) return;
    const status = res.status();
    const timing = res.request().timing?.();
    if (status >= 400) {
      let body = '';
      try {
        body = (await res.text()).slice(0, 300);
      } catch {
        /* body may be gone after navigation */
      }
      // A 401 before the customer has signed in is the app working as designed.
      const severity = status >= 500 ? 'S1' : status === 401 || status === 403 ? 'S3' : 'S2';
      once(`http:${status} ${res.request().method()} ${trimUrl(url)}`, () =>
        sink({
          kind: 'http-error',
          severity,
          message: `${res.request().method()} ${trimUrl(url)} → ${status}${body ? ` — ${body}` : ''}`,
          where: page.url(),
          status,
        }),
      );
    }
    if (timing && timing.responseEnd > SLOW_MS && !/\/_next\//.test(url)) {
      once(`slow:${trimUrl(url)}`, () =>
        sink({ kind: 'slow-response', severity: 'S3', message: `${trimUrl(url)} took ${Math.round(timing.responseEnd)} ms`, where: page.url() }),
      );
    }
  });
}

function trimUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? '?…' : '');
  } catch {
    return url;
  }
}

/**
 * A snapshot of what is on screen right now that a customer would read as a
 * problem or a dead end. Called after every step.
 */
export async function scanScreen(page) {
  return page.evaluate((errorSource) => {
    const ERROR_TEXT = new RegExp(errorSource, 'i');
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

    const alerts = [...document.querySelectorAll('[role="alert"]')].filter(visible).map(text).filter(Boolean);
    const errorTexts = [...document.querySelectorAll('main *, [role="dialog"] *')]
      .filter((el) => el.children.length === 0 && visible(el))
      .map(text)
      .filter((t) => t.length < 240 && ERROR_TEXT.test(t));
    const disabledButtons = [...document.querySelectorAll('button:disabled, button[aria-disabled="true"]')]
      .filter(visible)
      .map((b) => ({ label: text(b).slice(0, 60) || b.getAttribute('aria-label') || '(no label)', reason: b.getAttribute('title') || '' }));
    const emptyStates = [...document.querySelectorAll('[class*="empty" i], [data-empty]')].filter(visible).map(text).filter(Boolean).slice(0, 3);
    const headings = [...document.querySelectorAll('h1, h2')].filter(visible).map(text).slice(0, 4);
    return { alerts, errorTexts: [...new Set(errorTexts)], disabledButtons, emptyStates, headings };
  }, ERROR_TEXT.source);
}
