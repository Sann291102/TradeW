'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FEMALE_VOICE_HINTS, VOICE_LANG_PREFERENCE } from './identity';

/**
 * Tara's voice — layer 6 of the AI operating system, the output half
 * (AI-OPERATING-SYSTEM.md §8).
 *
 * Voice INPUT shipped 2026-08-11 (`useVoiceInput.ts`). This is the other
 * direction: the assistant reading her replies aloud. Reported simply as "the
 * AI is not talking", which was accurate — she could listen and could not
 * speak.
 *
 * ── ON-DEVICE, LIKE THE INPUT SIDE ─────────────────────────────────────────
 *
 * `speechSynthesis` runs in the browser. No audio is generated server-side, no
 * text is sent anywhere to be voiced, and it costs nothing per utterance —
 * which matters because the alternative (a cloud TTS API) would put a per-word
 * bill on something as ordinary as reading out a price.
 *
 * ── PICKING A VOICE IS BEST-EFFORT, ON PURPOSE ─────────────────────────────
 *
 * The Web Speech API exposes no gender field — `voice.name` is all there is —
 * and the installed set differs per OS, browser and even per user. So the
 * preference (English-first, female) is expressed as an ordered search and the
 * best available match wins. If nothing matches she still speaks in the
 * default voice rather than going silent: a wrong-sounding voice is a much
 * smaller failure than no voice.
 *
 * ── AND IT NEVER TALKS OVER THE PRODUCT ────────────────────────────────────
 *
 * Muted by default. Speech is opt-in per user and persisted by the caller,
 * because an app that starts talking unprompted in an open-plan office is one
 * the user turns off permanently. Silent narration mode also suppresses it —
 * see the caller — since "don't narrate" plainly includes "don't say it out
 * loud".
 */

export interface VoiceOutput {
  /** False where the browser has no speechSynthesis, or on the server. */
  supported: boolean;
  /**
   * True only once a usable voice has actually been found.
   *
   * `supported` and this are NOT the same thing, and conflating them is a real
   * bug: a browser can expose the whole speechSynthesis API and ship zero
   * voices. Measured in headless Chromium — `getVoices()` returns `[]`, yet
   * `speak()` still fires `onstart` and `onend`, so the code reports a
   * successful utterance while producing no sound at all. A toggle that says
   * she is speaking when nothing can be heard is worse than one that admits
   * she has no voice, so callers gate on this, not on `supported`.
   */
  hasVoice: boolean;
  speaking: boolean;
  /** The voice actually chosen, for display. Null until voices load. */
  voiceName: string | null;
  speak: (text: string) => void;
  cancel: () => void;
}

/**
 * Score a voice against the preference. Higher is better; -1 means unusable.
 * Language rank dominates, then the female-name hint, so an `en-IN` male voice
 * still beats a `de-DE` female one — she must be intelligible before she is
 * the right timbre.
 */
function scoreVoice(v: SpeechSynthesisVoice): number {
  const lang = (v.lang || '').toLowerCase().replace('_', '-');
  const langRank = VOICE_LANG_PREFERENCE.findIndex((p) =>
    p === 'en' ? lang.startsWith('en') : lang === p.toLowerCase(),
  );
  if (langRank === -1) return -1;

  const name = (v.name || '').toLowerCase();
  const female = FEMALE_VOICE_HINTS.some((h) => name.includes(h)) ? 1 : 0;

  // Language is weighted an order of magnitude above gender.
  return (VOICE_LANG_PREFERENCE.length - langRank) * 10 + female;
}

/** Strip the markup and trace glyphs the dock renders but nobody should hear. */
export function speakableText(raw: string): string {
  return raw
    .replace(/\*\*/g, '')
    .replace(/[✓✕›•💡]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function useVoiceOutput(enabled: boolean): VoiceOutput {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    setSupported(true);

    /**
     * `getVoices()` is famously empty on first call in Chrome — the list loads
     * asynchronously and fires `voiceschanged`. Reading it once at mount is the
     * single most common reason a voice picker silently falls back to the
     * default, so both paths are handled.
     */
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      let best: SpeechSynthesisVoice | null = null;
      let bestScore = -1;
      for (const v of voices) {
        const s = scoreVoice(v);
        if (s > bestScore) {
          bestScore = s;
          best = v;
        }
      }
      setVoice(best);
    };

    pick();
    window.speechSynthesis.addEventListener('voiceschanged', pick);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', pick);
      // Stop mid-sentence on unmount. Without this the browser keeps talking
      // after the dock closes, which is startling and looks like a bug.
      window.speechSynthesis.cancel();
    };
  }, []);

  const cancel = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!enabledRef.current) return;
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

      const body = speakableText(text);
      if (!body) return;

      // One voice at a time: a new reply replaces the old one rather than
      // queueing behind it, or a fast conversation stacks up minutes of audio.
      window.speechSynthesis.cancel();

      const u = new SpeechSynthesisUtterance(
        // Long replies are truncated for speech only. The full text stays on
        // screen; nobody wants a price table read out in full.
        body.length > 400 ? `${body.slice(0, 400)}…` : body,
      );
      if (voice) u.voice = voice;
      u.lang = voice?.lang || 'en-IN';
      u.rate = 1.02;
      u.pitch = 1.05;
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);

      setSpeaking(true);
      window.speechSynthesis.speak(u);
    },
    [voice],
  );

  return {
    supported,
    hasVoice: voice !== null,
    speaking,
    voiceName: voice?.name ?? null,
    speak,
    cancel,
  };
}
