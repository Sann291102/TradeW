'use client';

/**
 * Browser speech primitives — recognition in, synthesis out (`AI-VOICE.md`).
 *
 * Thin, typed wrappers over two Web APIs that are still vendor-prefixed and
 * unevenly implemented. Kept separate from React so the capability checks can
 * be reasoned about (and stubbed) without mounting anything.
 *
 * ## The privacy fact that shapes the design
 *
 * `webkitSpeechRecognition` in Chrome is NOT on-device — it streams microphone
 * audio to a remote Google service. That is acceptable for push-to-talk, where
 * the user has just deliberately pressed a button to speak one utterance. It
 * is NOT acceptable as an always-on wake-word listener, which would upload the
 * microphone continuously for a whole trading session. `wake-word.ts` carries
 * that distinction; this file only provides the primitive.
 */

// ---------------------------------------------------------------------------
// Types — the DOM lib does not ship these
// ---------------------------------------------------------------------------

export interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechRecognitionSupported(): boolean {
  return recognitionCtor() !== null;
}

export function speechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Indian English where available. Falls back to the browser default, which is
 * usually the OS locale — better than forcing en-US onto an Indian user, whose
 * ticker names ("Nifty", "Reliance") are recognised markedly better under
 * en-IN.
 */
export const PREFERRED_LANG = 'en-IN';

// ---------------------------------------------------------------------------
// Recognition — one utterance at a time (push-to-talk)
// ---------------------------------------------------------------------------

export interface ListenHandle {
  stop(): void;
  abort(): void;
}

export interface ListenCallbacks {
  /** Fired repeatedly as the user speaks, for live captioning. */
  onPartial?(text: string): void;
  /** Fired once with the settled transcript. */
  onFinal(text: string): void;
  onError?(error: string): void;
  onEnd?(): void;
}

/**
 * Capture a single spoken utterance.
 *
 * `continuous: false` so recognition endpoints itself on natural end-of-speech
 * — the user should not have to press anything to stop talking.
 */
export function listenOnce(callbacks: ListenCallbacks): ListenHandle | null {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    callbacks.onError?.('unsupported');
    return null;
  }

  const recognition = new Ctor();
  recognition.lang = PREFERRED_LANG;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let settled = false;

  recognition.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) final += text;
      else interim += text;
    }
    if (interim) callbacks.onPartial?.(interim.trim());
    if (final.trim()) {
      settled = true;
      callbacks.onFinal(final.trim());
    }
  };

  recognition.onerror = (e) => {
    // `no-speech` and `aborted` are normal outcomes of a user who pressed the
    // button and changed their mind — not worth surfacing as errors.
    if (e.error !== 'no-speech' && e.error !== 'aborted') callbacks.onError?.(e.error);
  };

  recognition.onend = () => {
    if (!settled) callbacks.onEnd?.();
    else callbacks.onEnd?.();
  };

  try {
    recognition.start();
  } catch {
    // start() throws if a recognition is already running on some builds.
    callbacks.onError?.('already-started');
    return null;
  }

  return {
    stop: () => recognition.stop(),
    abort: () => recognition.abort(),
  };
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/**
 * Strip the markdown the assistant writes for the screen before speaking it.
 * Reading "asterisk asterisk buyers asterisk asterisk" aloud is worse than not
 * speaking at all.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[-•]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let currentUtterance: SpeechSynthesisUtterance | null = null;

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  onEnd?(): void;
  onStart?(): void;
}

/** Speak text, cancelling anything already in flight (barge-in, `AI-VOICE.md` §4). */
export function speak(text: string, options: SpeakOptions = {}): void {
  if (!speechSynthesisSupported()) return;
  const clean = speakableText(text);
  if (!clean) return;

  stopSpeaking();

  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = PREFERRED_LANG;
  utterance.rate = options.rate ?? 1.05;
  utterance.pitch = options.pitch ?? 1;

  const preferred = window.speechSynthesis
    .getVoices()
    .find((v) => v.lang === PREFERRED_LANG || v.lang?.startsWith('en-IN'));
  if (preferred) utterance.voice = preferred;

  utterance.onstart = () => options.onStart?.();
  utterance.onend = () => {
    currentUtterance = null;
    options.onEnd?.();
  };

  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (!speechSynthesisSupported()) return;
  window.speechSynthesis.cancel();
  currentUtterance = null;
}

export function isSpeaking(): boolean {
  return speechSynthesisSupported() && (window.speechSynthesis.speaking || currentUtterance !== null);
}
