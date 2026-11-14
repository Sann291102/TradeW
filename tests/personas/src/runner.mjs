import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { attachObserver, scanScreen } from './observer.mjs';
import { findingId, isEnvironmentFailure } from './findings.mjs';

/** Thrown by a journey when what the customer sees is not what they should see. */
export class Expectation extends Error {
  constructor(message, { expected, actual, severity = 'S2', envDependent = false } = {}) {
    super(message);
    // True only when the expectation cannot be judged without a working market
    // feed. Everything else stays a finding even if the feed is also down.
    this.envDependent = envDependent;
    this.expected = expected;
    this.actual = actual ?? message;
    this.severity = severity;
  }
}

/** Thrown after a critical step fails, so the rest of the journey is reported as not reached. */
class StopJourney extends Error {}

/** Thrown by a journey when it cannot proceed for a reason that is the environment's. */
export class Blocked extends Error {}

/**
 * Runs one persona's journey. Each `step` is recorded with a status of
 * pass | finding | blocked, a screenshot, and every observer event that fired
 * while it ran. Nothing here decides a step "passed" because it did not throw
 * alone: a step that never reached its expectation says so.
 */
export async function runPersona(persona, { browser, baseUrl, outDir, accounts }) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 820 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  // The dev server compiles a route the first time it is visited; navigation is allowed to take that long.
  page.setDefaultNavigationTimeout(90_000);

  const steps = [];
  let current = null;
  attachObserver(page, (event) => {
    if (current) current.events.push(event);
  });

  const shotDir = join(outDir, 'screenshots');
  mkdirSync(shotDir, { recursive: true });

  const ctx = {
    page,
    baseUrl,
    persona,
    accounts,
    /** Record something the journey itself noticed (not a thrown failure). */
    observe(event) {
      if (current) current.events.push(event);
    },
    route: () => {
      try {
        return new URL(page.url()).pathname;
      } catch {
        return page.url();
      }
    },
    async step(name, fn, { critical = false } = {}) {
      const startedAt = Date.now();
      const record = { persona: persona.name, step: name, status: 'pass', events: [], notes: [], error: null };
      current = record;
      try {
        await fn(ctx);
      } catch (err) {
        record.error = err;
      }
      // Let late responses and toasts land before reading the screen.
      await page.waitForTimeout(400).catch(() => {});
      let screen = null;
      try {
        screen = await scanScreen(page);
      } catch {
        /* page may have navigated away or closed */
      }
      record.route = ctx.route();
      record.screen = screen;
      record.durationMs = Date.now() - startedAt;
      const shot = `${String(steps.length + 1).padStart(2, '0')}-${persona.name}-${slug(name)}.png`;
      try {
        await page.screenshot({ path: join(shotDir, shot), fullPage: false });
        record.screenshot = `screenshots/${shot}`;
      } catch {
        record.screenshot = null;
      }
      current = null;
      steps.push(classify(record));
      // A journey cannot meaningfully continue after e.g. a failed sign-in;
      // pressing on would only produce findings caused by the failure itself.
      if (critical && record.status !== 'pass') throw new StopJourney(name);
      return record;
    },
  };

  try {
    await persona.run(ctx);
  } catch (err) {
    if (err instanceof StopJourney) {
      // already recorded as the failed step; the unreached steps are added below
    } else
    // A journey-level crash is itself a result, never a silent stop.
    steps.push({
      persona: persona.name,
      step: '(journey aborted)',
      status: 'finding',
      route: ctx.route(),
      events: [],
      notes: [],
      findings: [
        {
          kind: 'journey-aborted',
          severity: 'S1',
          message: `The ${persona.name} journey stopped: ${err.message}`,
          expected: 'The journey completes or reports which step could not run.',
          actual: err.message,
        },
      ],
      screenshot: null,
    });
  } finally {
    await context.close();
  }

  // Steps the journey never reached are listed, so a short run cannot look complete.
  const reached = new Set(steps.map((s) => s.step));
  for (const planned of persona.plannedSteps ?? []) {
    if (!reached.has(planned)) {
      steps.push({
        persona: persona.name,
        step: planned,
        status: 'not-reached',
        route: null,
        events: [],
        notes: [],
        findings: [],
        screenshot: null,
        environmentReason: 'An earlier step stopped the journey.',
      });
    }
  }
  return steps;
}

function classify(record) {
  const findings = [];
  const environment = [];

  const sort = (event) => {
    if (isEnvironmentFailure(event.message)) environment.push(event.message);
    else findings.push({ ...event, expected: event.expected ?? 'No errors a customer would notice.', actual: event.actual ?? event.message });
  };
  record.events.forEach(sort);

  const screen = record.screen;
  if (screen) {
    for (const text of [...screen.alerts, ...screen.errorTexts]) {
      if (isEnvironmentFailure(text)) environment.push(text);
      else
        findings.push({
          kind: 'visible-error',
          severity: 'S2',
          message: text.slice(0, 300),
          where: record.route,
          expected: 'No error message on a screen the customer reached normally.',
          actual: `Screen shows: "${text.slice(0, 200)}"`,
        });
    }
  }

  let status = 'pass';
  if (record.error instanceof Blocked) {
    status = 'blocked';
    record.environmentReason = record.error.message;
  } else if (record.error instanceof Expectation) {
    if (record.error.envDependent && environment.length > 0) {
      // The expectation failed while the screen was saying the environment is
      // missing something. That explains it; it does not indict the product.
      status = 'blocked';
      record.environmentReason = environment[0];
    } else {
      status = 'finding';
      findings.unshift({
        kind: 'expectation-failed',
        severity: record.error.severity,
        message: record.error.message,
        where: record.route,
        expected: record.error.expected ?? record.error.message,
        actual: record.error.actual,
      });
    }
  } else if (record.error) {
    // An unexpected exception is usually a missing element: the screen is not
    // what the journey assumed. Report it as a finding rather than swallowing it.
    if (environment.length > 0) {
      status = 'blocked';
      record.environmentReason = environment[0];
    } else {
      status = 'finding';
      findings.unshift({
        kind: 'journey-step-failed',
        severity: 'S2',
        message: `${record.error.message}`.split('\n')[0].slice(0, 300),
        where: record.route,
        expected: `The "${record.step}" step can be completed.`,
        actual: `${record.error.message}`.split('\n')[0].slice(0, 300),
      });
    }
  }
  if (status === 'pass' && findings.length > 0) status = 'finding';

  record.environmentNotes = [...new Set(environment)];
  record.findings = findings.map((f) => ({ ...f, id: findingId({ persona: record.persona, route: f.where ?? record.route, kind: f.kind, message: f.message }) }));
  record.status = status;
  delete record.events;
  delete record.error;
  return record;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
