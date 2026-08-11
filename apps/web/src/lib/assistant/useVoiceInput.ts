'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice input for the assistant — `TRADEW-ASSISTANT.md` §1's "voice input
 * (speech-to-text before the same routing)".
 *
 * ── WHY THE BROWSER, NOT A SERVICE ─────────────────────────────────────────
 *
 * The blueprint draws speech-to-text as a step inside `services/tradew-ai`.
 * This does it in the browser via the Web Speech API instead, for the same
 * reason navigation intents skip the LLM: a round trip that ships the user's
 * microphone audio to a server, to produce text that a regex then matches
 * against a fixed command grammar, is cost and latency and a privacy surface
 * bought for nothing. Audio never leaves the device here; only the transcript
 * reaches the resolver, and the resolver is the same one the text box uses.
 *
 * If a later phase needs better accuracy on Indian-English symbol names than
 * the platform recogniser gives, THAT is the moment to add a server path —
 * behind this same hook's interface.
 *
 * ── SUPPORT IS NOT UNIVERSAL, AND THE UI MUST NOT PRETEND OTHERWISE ────────
 *
 * `SpeechRecognition` ships prefixed in Chrome/Edge and unprefixed in recent
 * Safari; Firefox does not implement it. `supported` is therefore false on a
 * real share of visits, and the caller is expected to HIDE the control rather
 * than render a button that does nothing. It is resolved in an effect, not at
 * module scope, because the server has no `window` and a mismatched first
 * render would be a hydration error.
 */

/** Minimal shape of the parts of the spec this hook touches. */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
}

type Ctor = new () => SpeechRecognitionLike;

function getConstructor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: Ctor;
    webkitSpeechRecognition?: Ctor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface VoiceInput {
  /** False on Firefox and on the server — hide the mic entirely when false. */
  supported: boolean;
  listening: boolean;
  /** Live partial transcript, for showing the user they're being heard. */
  interim: string;
  /** Set when the browser refused (usually a denied mic permission). */
  error: string | null;
  start: () => void;
  stop: () => void;
}

/**
 * @param onFinal called once with the settled transcript. The caller decides
 *   whether that submits immediately or just fills the input.
 */
export function useVoiceInput(onFinal: (text: string) => void): VoiceInput {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  // Held in a ref so changing the callback doesn't tear down an in-flight
  // recognition session — the user is mid-sentence.
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    setSupported(getConstructor() !== null);
  }, []);

  // Stop the microphone if the component unmounts mid-listen. Without this the
  // recogniser keeps the mic indicator lit after the dock closes, which reads
  // as the app listening in the background.
  useEffect(() => {
    return () => {
      recRef.current?.abort();
      recRef.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    recRef.current?.stop();
    setListening(false);
    setInterim('');
  }, []);

  const start = useCallback(() => {
    const Ctor = getConstructor();
    if (!Ctor) return;

    // Restarting while already listening throws InvalidStateError.
    recRef.current?.abort();
    setError(null);
    setInterim('');

    const rec = new Ctor();
    // en-IN, not en-US: every instrument in the grammar is an Indian ticker,
    // and "BANKNIFTY"/"RELIANCE"/"SENSEX" are recognised far better by the
    // Indian-English model.
    rec.lang = 'en-IN';
    rec.continuous = false;
    rec.interimResults = true;

    rec.onresult = (e: any) => {
      let finalText = '';
      let partial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else partial += r[0].transcript;
      }
      if (partial) setInterim(partial);
      if (finalText.trim()) {
        setInterim('');
        onFinalRef.current(finalText.trim());
      }
    };

    rec.onerror = (e: any) => {
      // 'aborted' is what our own stop() produces — not worth showing.
      if (e?.error === 'aborted') return;
      setError(
        e?.error === 'not-allowed'
          ? // Actionable, because "blocked" alone leaves the user with no idea
            // that the fix is three clicks away in their own browser. Chrome
            // remembers a denial per-origin, so this persists until changed.
            'Microphone is blocked. Click the icon at the left of the address bar → Site settings → allow Microphone, then reload.'
          : e?.error === 'no-speech'
            ? "I didn't catch that — try again."
            : e?.error === 'audio-capture'
              ? 'No microphone found. Check that one is connected and selected in your system settings.'
              : e?.error === 'network'
                ? 'Speech recognition needs a network connection and could not reach it.'
                : 'Voice input failed.',
      );
      setListening(false);
    };

    rec.onend = () => {
      setListening(false);
      setInterim('');
    };

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setError('Voice input could not start.');
      setListening(false);
    }
  }, []);

  return { supported, listening, interim, error, start, stop };
}
