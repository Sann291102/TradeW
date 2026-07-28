import { create } from 'zustand';
import {
  DisciplineBreachError,
  DisciplineSessionDto,
  DisciplineTodayDto,
  StartSessionRequest,
  fetchToday,
  startSession,
} from '../discipline';

/**
 * Discipline session state.
 *
 * Server truth, never persisted — the same contract as `sessionStore`, and for
 * a stronger reason here: whether the panel appears is decided by whether a
 * `DisciplineSession` row exists for today, which is the one fact a client
 * flag must never be allowed to contradict. There is deliberately no
 * "already seen today" value in localStorage. Backgrounding the app, reopening
 * it, refreshing, or switching device all resolve the same way, because they
 * all ask the server the same question.
 *
 * Three things re-ask that question after the initial mount:
 *
 *   1. `visibilitychange` — the app coming back to the foreground is the
 *      natural moment to notice the day rolled over or the market opened.
 *   2. A scheduled boundary timer — see `scheduleBoundaryRefresh`. This is what
 *      makes a tab left open from 09:00 through 09:15 IST get the panel at
 *      open instead of never.
 *   3. `refresh()` called explicitly after an order, so the budget view is
 *      not stale.
 */

export type DisciplineStatus = 'idle' | 'loading' | 'ready' | 'error';

/** What the app shell should do right now. */
export type DisciplineGate =
  /** Still asking the server. Render neither the app nor the panel. */
  | 'checking'
  /** A session is required before the app is usable. */
  | 'blocked'
  /** Nothing is required — render the app. */
  | 'clear';

interface DisciplineState {
  status: DisciplineStatus;
  today: DisciplineTodayDto | null;
  /** Set when the last fetch failed. The shell fails OPEN — see `gate`. */
  error: string | null;
  submitting: boolean;
  /** Rejection reason from the last failed panel submit, if any. */
  submitError: string | null;

  /** The open friction prompt, or null. */
  breach: DisciplineBreachError | null;
  /** Client-side start of the mandatory wait — see `openBreach`. */
  breachOpenedAt: number | null;
  /** Preserved across a refused retry so the trader does not retype. */
  breachDraft: string;

  init: () => void;
  teardown: () => void;
  /** Ask the server, resetting the retry backoff chain. */
  refresh: () => Promise<void>;
  /** One attempt plus its backoff chain. Internal — callers want `refresh`. */
  attempt: () => Promise<void>;
  submit: (input: StartSessionRequest) => Promise<DisciplineSessionDto | null>;

  openBreach: (breach: DisciplineBreachError) => void;
  setBreachDraft: (draft: string) => void;
  closeBreach: () => void;

  gate: () => DisciplineGate;
}

const IST_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 09:15 IST — mirrors MARKET_OPEN_MINUTE in the API's discipline service. */
const MARKET_OPEN_MINUTE = 9 * 60 + 15;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Don't re-ask more than this often on rapid tab switching. */
const VISIBILITY_THROTTLE_MS = 30_000;

/** Milliseconds until the next moment the answer could change: today's 09:15
 *  IST if it has not passed, otherwise the next IST midnight. */
function msUntilNextBoundary(now: Date = new Date()): number {
  const [h, m, s] = IST_TIME.format(now).split(':').map(Number);
  const msIntoIstDay = ((h * 60 + m) * 60 + s) * 1000;
  const msUntilOpen = MARKET_OPEN_MINUTE * MINUTE_MS - msIntoIstDay;
  // +2s so the refresh lands after the server's own boundary, not exactly on it.
  return (msUntilOpen > 0 ? msUntilOpen : DAY_MS - msIntoIstDay) + 2_000;
}

/**
 * Backoff for a failed refresh: five attempts across ~109s.
 *
 * A brief API blip must not cost a trader their whole session's limits. The
 * gate fails open immediately (see `gate`) so the app stays usable, but the
 * store keeps asking in the background — and the moment an attempt succeeds
 * with `needsPanel: true`, the panel appears. Giving up on the first failure
 * would mean a one-second outage at 09:15 silently produced an unlimited
 * session for the rest of the day.
 */
const RETRY_BACKOFF_MS = [2_000, 5_000, 12_000, 30_000, 60_000];

let boundaryTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Index into RETRY_BACKOFF_MS for the next attempt in the current chain. */
let retryIndex = 0;
let onVisibility: (() => void) | null = null;
let lastVisibilityRefresh = 0;
let started = false;

function clearRetryChain(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryIndex = 0;
}

export const useDisciplineStore = create<DisciplineState>()((set, get) => ({
  status: 'idle',
  today: null,
  error: null,
  submitting: false,
  submitError: null,
  breach: null,
  breachOpenedAt: null,
  breachDraft: '',

  init: () => {
    if (started) return;
    started = true;

    void get().refresh();

    onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastVisibilityRefresh < VISIBILITY_THROTTLE_MS) return;
      lastVisibilityRefresh = now;
      void get().refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    scheduleBoundaryRefresh(get);
  },

  teardown: () => {
    if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
    onVisibility = null;
    if (boundaryTimer) clearTimeout(boundaryTimer);
    boundaryTimer = null;
    clearRetryChain();
    started = false;
  },

  /**
   * Ask the server. Any caller-initiated refresh (mount, foreground, boundary,
   * post-override) starts a FRESH backoff chain — a new trigger deserves the
   * full set of attempts rather than inheriting an exhausted chain from an
   * outage ten minutes ago.
   */
  refresh: async () => {
    clearRetryChain();
    await get().attempt();
  },

  /**
   * One request, plus the backoff chain on failure.
   *
   * Failure does NOT blank the app: the gate reads 'clear' the moment status
   * becomes 'error', so the trader keeps working while this retries behind
   * them. The budget card shows its error copy throughout. If an attempt then
   * succeeds with `needsPanel: true`, the panel appears — a few seconds after
   * load rather than never, which is the trade this backoff exists to make.
   */
  attempt: async () => {
    // Only the very first load shows the checking state. A background refresh
    // or retry must not blank the app the trader is already looking at.
    if (get().status === 'idle') set({ status: 'loading' });
    try {
      const today = await fetchToday();
      clearRetryChain();
      set({ status: 'ready', today, error: null });
    } catch (err) {
      set({
        status: 'error',
        error: err instanceof Error ? err.message : 'Could not reach the server',
      });
      const delay = RETRY_BACKOFF_MS[retryIndex];
      // Chain exhausted — settle. The gate is already 'clear'; a later
      // foreground or boundary event will start a fresh chain.
      if (delay === undefined) return;
      retryIndex += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void get().attempt();
      }, delay);
    }
  },

  submit: async (input) => {
    set({ submitting: true, submitError: null });
    try {
      const session = await startSession(input);
      // A successful write proves the API is reachable; any chain still running
      // from an earlier blip is stale.
      clearRetryChain();
      set({
        submitting: false,
        status: 'ready',
        error: null,
        today: {
          needsPanel: false,
          reason: 'session_exists',
          tradingDate: session.tradingDate,
          session,
        },
      });
      return session;
    } catch (err) {
      set({
        submitting: false,
        submitError:
          err instanceof Error ? err.message : 'Could not save your limits. Check your connection and try again.',
      });
      return null;
    }
  },

  /**
   * Open the friction prompt, or replace the one already open.
   *
   * A refused retry arrives as a NEW 409 carrying a fresh token and a
   * `priorAttempt`. Replacing in place restarts the wait against the new token
   * — which is correct, because the server will measure the dwell from that
   * token's issue time — while keeping the words the trader already typed.
   * Wiping their draft on a rejection would punish them for the server's
   * answer.
   */
  openBreach: (breach) => set({ breach, breachOpenedAt: Date.now() }),

  setBreachDraft: (breachDraft) => set({ breachDraft }),

  closeBreach: () => set({ breach: null, breachOpenedAt: null, breachDraft: '' }),

  /**
   * Fail OPEN on an unreachable server — but not silently, and not for good.
   *
   * A discipline panel that cannot be filled in because the API is down would
   * lock the trader out of an app whose limits are self-imposed in the first
   * place. So 'error' reads as 'clear' and the app stays usable.
   *
   * That is only half the answer. Failing open and stopping there would mean a
   * one-second blip at 09:15 cost the trader their whole session's limits, with
   * nothing to enforce because no session row was ever created. `attempt` keeps
   * a backoff chain running behind this, so the panel arrives late rather than
   * never; the budget card shows its error copy meanwhile.
   */
  gate: () => {
    const { status, today } = get();
    if (status === 'idle' || status === 'loading') return 'checking';
    if (status === 'error') return 'clear';
    return today?.needsPanel ? 'blocked' : 'clear';
  },
}));

/** Re-ask at the next boundary, then reschedule from wherever that lands. */
function scheduleBoundaryRefresh(get: () => DisciplineState): void {
  if (boundaryTimer) clearTimeout(boundaryTimer);
  boundaryTimer = setTimeout(() => {
    void get().refresh();
    scheduleBoundaryRefresh(get);
  }, msUntilNextBoundary());
}
