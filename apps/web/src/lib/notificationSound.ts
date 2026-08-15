/**
 * The TradeW notification mark — a short, synthesized two-note chime.
 *
 * WHY SYNTHESIZED, NOT AN AUDIO FILE
 * A .mp3/.wav would be one more asset to host, cache-bust and clear through the
 * app's CSP. The mark is only two notes, so the Web Audio API produces it in a
 * few lines with zero network cost and a byte-identical sound every time —
 * which is the point: the same rising interval every time is what makes it
 * *recognisable as TradeW* rather than a generic OS blip.
 *
 * THE GESTURE RULE
 * Browsers refuse to start an AudioContext until the user has interacted with
 * the page at least once (autoplay policy). We therefore create it lazily and
 * `resume()` on every play — before the first click nothing sounds, and that is
 * correct: an unsolicited noise on page load is exactly what the policy exists
 * to stop. Once the user has clicked anything, the chime works for the session.
 *
 * Every failure path is swallowed: a notification must never turn into an
 * unhandled promise rejection because a tab was backgrounded or audio was
 * blocked.
 */

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/** One bell-like note: a sine tone with a fast attack and a gentle exponential
 *  decay, so it reads as a soft "ding" rather than a flat beep. */
function note(ac: AudioContext, freq: number, startAt: number, duration: number, peak: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

/**
 * Play the TradeW mark: two ascending notes (a perfect-fifth-ish lift,
 * ~988 Hz → ~1319 Hz) — bright, short, and consistent so it becomes identifiable
 * as "that's TradeW."
 */
export function playNotificationSound(): void {
  const ac = audioContext();
  if (!ac) return;
  const go = () => {
    const t = ac.currentTime;
    note(ac, 987.77, t, 0.16, 0.14); // B5
    note(ac, 1318.51, t + 0.11, 0.28, 0.16); // E6
  };
  // resume() returns a promise on some engines, void on others — normalise.
  try {
    const maybe = ac.resume?.();
    if (maybe && typeof (maybe as Promise<void>).then === 'function') {
      (maybe as Promise<void>).then(go).catch(() => undefined);
    } else {
      go();
    }
  } catch {
    /* audio blocked / context closed — a silent notification is fine */
  }
}
