'use client';

import { PREFERRED_LANG, type SpeechRecognitionLike } from './speech';

/**
 * Wake-word detection — "Hey <Name>" (`AI-VOICE.md` §3).
 *
 * ## Read this before changing anything here
 *
 * The design constraint is a privacy one, not a technical one. Chrome's
 * `webkitSpeechRecognition` streams microphone audio to a remote service. An
 * always-on listener built on it uploads the user's microphone for the entire
 * trading session — unacceptable as a default, whatever the feature's appeal.
 *
 * The correct implementation is a small on-device model (Vosk / whisper.cpp /
 * Moonshine, compiled to WASM) behind a voice-activity gate, matching a
 * transcript locally against the user's chosen name. That is what
 * `LocalModelWakeDetector` is a slot for. It needs a model binary shipped with
 * the app, which is a build-pipeline decision (`AI-VOICE.md` §9) and is NOT
 * done here.
 *
 * What IS here:
 *   - the detector interface and the fuzzy name matcher, both complete
 *   - `CloudRecognitionWakeDetector`, which works in today's browsers and is
 *     gated behind explicit, informed opt-in with the upload disclosed
 *   - `NullWakeDetector` for unsupported browsers
 *
 * So wake word is functional today, honestly labelled, and the private
 * implementation drops in without touching callers. Shipping the cloud one
 * silently as "on-device" would have been the dishonest option.
 */

export type WakeDetectorKind = 'local-model' | 'cloud-recognition' | 'none';

export interface WakeDetector {
  readonly kind: WakeDetectorKind;
  /** True when audio leaves the device to detect the wake word. */
  readonly usesRemoteAudio: boolean;
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export interface WakeDetectorOptions {
  /** The user's chosen persona name. Compared as a literal, never compiled into a regex. */
  name: string;
  onWake(heard: string): void;
  onError?(error: string): void;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const WAKE_PREFIXES = ['hey', 'hi', 'hello', 'ok', 'okay', 'yo'];

/**
 * Levenshtein distance, iterative and bounded by the shorter string.
 * Speech-to-text mangles invented names constantly ("Nova" -> "Noah",
 * "over"), so exact matching would make the feature useless for exactly the
 * free-text names the product promises.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** Tolerance scaled to name length: short names need tighter matching. */
function tolerance(name: string): number {
  if (name.length <= 3) return 0;
  if (name.length <= 5) return 1;
  return 2;
}

/**
 * Whether a transcript contains the wake phrase.
 *
 * Accepts the bare name and any of the usual prefixes. Deliberately generous
 * about what precedes it, because recognition prepends filler constantly.
 */
export function matchesWakeWord(transcript: string, name: string): boolean {
  const cleanName = name.trim().toLowerCase();
  if (!cleanName) return false;

  // Strip punctuation without unicode property escapes: this file compiles
  // under the web app's ES5-era target, where the `u` flag is unavailable.
  // Keeping letters/digits/whitespace of any script by excluding only ASCII
  // punctuation is sufficient here — the comparison is fuzzy anyway.
  const tokens = transcript
    .toLowerCase()
    .replace(/[!-/:-@[-`{-~]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;

  const nameTokens = cleanName.split(/\s+/);
  const limit = tolerance(cleanName.replace(/\s+/g, ''));

  for (let i = 0; i < tokens.length; i += 1) {
    const window = tokens.slice(i, i + nameTokens.length).join(' ');
    if (!window) continue;
    if (editDistance(window, cleanName) <= limit) {
      // Bare name counts; so does a prefix immediately before it.
      const before = i > 0 ? tokens[i - 1] : null;
      if (before === null || WAKE_PREFIXES.includes(before) || i === 0) return true;
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

export class NullWakeDetector implements WakeDetector {
  readonly kind = 'none' as const;
  readonly usesRemoteAudio = false;
  readonly running = false;
  start(): void {}
  stop(): void {}
}

/**
 * Continuous recognition as a wake listener.
 *
 * **Sends microphone audio to the browser vendor's recognition service while
 * running.** Callers must disclose this and default it off — `useVoice` does,
 * and the settings copy says it in plain words. Present because it makes the
 * feature real in today's browsers, not because it is the design.
 */
export class CloudRecognitionWakeDetector implements WakeDetector {
  readonly kind = 'cloud-recognition' as const;
  readonly usesRemoteAudio = true;

  private recognition: SpeechRecognitionLike | null = null;
  private wantRunning = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: WakeDetectorOptions) {}

  get running(): boolean {
    return this.wantRunning;
  }

  start(): void {
    if (this.wantRunning) return;
    this.wantRunning = true;
    this.spin();
  }

  stop(): void {
    this.wantRunning = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    try {
      this.recognition?.abort();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
  }

  private spin(): void {
    if (!this.wantRunning || typeof window === 'undefined') return;
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      this.options.onError?.('unsupported');
      this.wantRunning = false;
      return;
    }

    const recognition = new Ctor();
    recognition.lang = PREFERRED_LANG;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const heard = event.results[i][0]?.transcript ?? '';
        if (heard && matchesWakeWord(heard, this.options.name)) {
          // Hand off immediately: the utterance after the wake word is
          // captured by a fresh single-shot recognition, so the wake listener
          // never has to also be the transcriber.
          this.stop();
          this.options.onWake(heard.trim());
          return;
        }
      }
    };

    recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wantRunning = false;
        this.options.onError?.(e.error);
      }
      // Everything else (no-speech, network, aborted) is transient: onend
      // restarts.
    };

    recognition.onend = () => {
      // Browsers stop continuous recognition after silence or ~60s. Respin
      // with a small delay so a hard failure cannot become a tight loop.
      if (this.wantRunning) {
        this.restartTimer = setTimeout(() => this.spin(), 400);
      }
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch {
      this.restartTimer = setTimeout(() => this.spin(), 800);
    }
  }
}

/**
 * Pick the best available detector.
 *
 * Returns the cloud detector only when the caller has explicitly accepted the
 * upload — there is no code path that starts remote-audio detection without
 * `allowRemoteAudio` being true at the call site.
 */
export function createWakeDetector(
  options: WakeDetectorOptions & { allowRemoteAudio: boolean },
): WakeDetector {
  if (typeof window === 'undefined') return new NullWakeDetector();

  // Slot for the on-device model. When a WASM detector is bundled, construct
  // it here and it takes precedence over everything below, with no caller
  // change and no opt-in required — because nothing leaves the device.

  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const hasRecognition = Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);

  if (options.allowRemoteAudio && hasRecognition) {
    return new CloudRecognitionWakeDetector(options);
  }
  return new NullWakeDetector();
}
