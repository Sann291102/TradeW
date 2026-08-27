'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isSpeaking,
  listenOnce,
  speak,
  speechRecognitionSupported,
  speechSynthesisSupported,
  stopSpeaking,
  type ListenHandle,
} from './speech';
import { createWakeDetector, type WakeDetector } from './wake-word';

/**
 * The voice interface, as one hook (`AI-VOICE.md`).
 *
 * Both activation modes: push-to-talk always, wake word when the user has
 * turned it on. Whichever fires, the transcript goes down the same path as
 * typed text — there is no voice-only branch, which is what keeps the
 * guardrails identical across modalities.
 */

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

const WAKE_PREF_KEY = 'tradew_wake_word_enabled';
const VOICE_OUT_PREF_KEY = 'tradew_voice_out_enabled';

function readPref(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  return raw === null ? fallback : raw === '1';
}

export interface UseVoiceOptions {
  /** The user's persona name — the wake word. */
  name: string;
  /** Called with a settled transcript, from either activation mode. */
  onTranscript(text: string): void;
}

export function useVoice({ name, onTranscript }: UseVoiceOptions) {
  const [state, setState] = useState<VoiceState>('idle');
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Wake word defaults OFF: it needs standing microphone permission, and in
  // today's browsers it also streams audio remotely (wake-word.ts). Opt-in
  // only, never silently enabled.
  const [wakeEnabled, setWakeEnabled] = useState(false);
  const [voiceOutEnabled, setVoiceOutEnabled] = useState(true);

  const listenRef = useRef<ListenHandle | null>(null);
  const detectorRef = useRef<WakeDetector | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // Read prefs after mount — localStorage is unavailable during SSR, and
  // reading it in useState's initializer would hydrate-mismatch.
  useEffect(() => {
    setWakeEnabled(readPref(WAKE_PREF_KEY, false));
    setVoiceOutEnabled(readPref(VOICE_OUT_PREF_KEY, true));
  }, []);

  const supported = useMemo(
    () => ({
      recognition: speechRecognitionSupported(),
      synthesis: speechSynthesisSupported(),
    }),
    [],
  );

  const stopListening = useCallback(() => {
    listenRef.current?.abort();
    listenRef.current = null;
    setPartial('');
    setState((s) => (s === 'listening' ? 'idle' : s));
  }, []);

  /** Capture one utterance. Used by the mic button, the hotkey, and post-wake. */
  const startListening = useCallback(() => {
    if (listenRef.current) return;
    setError(null);
    // Barge-in: the user talking always wins over the assistant talking.
    stopSpeaking();
    setState('listening');
    setPartial('');

    listenRef.current = listenOnce({
      onPartial: setPartial,
      onFinal: (text) => {
        listenRef.current = null;
        setPartial('');
        setState('thinking');
        onTranscriptRef.current(text);
      },
      onError: (e) => {
        listenRef.current = null;
        setError(e === 'not-allowed' ? 'Microphone permission is off.' : e);
        setState('idle');
      },
      onEnd: () => {
        listenRef.current = null;
        setState((s) => (s === 'listening' ? 'idle' : s));
      },
    });

    if (!listenRef.current) setState('idle');
  }, []);

  /** Speak a reply, if voice-out is on. */
  const say = useCallback(
    (text: string) => {
      if (!voiceOutEnabled || !supported.synthesis) {
        setState('idle');
        return;
      }
      setState('speaking');
      speak(text, {
        onEnd: () => setState((s) => (s === 'speaking' ? 'idle' : s)),
      });
    },
    [voiceOutEnabled, supported.synthesis],
  );

  const shutUp = useCallback(() => {
    stopSpeaking();
    setState((s) => (s === 'speaking' ? 'idle' : s));
  }, []);

  // ---- wake word ---------------------------------------------------------
  useEffect(() => {
    detectorRef.current?.stop();
    detectorRef.current = null;

    if (!wakeEnabled || !name) return;

    const detector = createWakeDetector({
      name,
      allowRemoteAudio: true, // the toggle IS the informed consent; see settings copy
      onWake: () => {
        // Acknowledge before any network work — the acknowledgement's latency
        // is the whole feel of the feature (AI-VOICE.md §4.1).
        if (voiceOutEnabled && speechSynthesisSupported()) speak("I'm listening.");
        startListening();
      },
      onError: (e) => {
        if (e === 'not-allowed' || e === 'service-not-allowed') {
          setWakeEnabled(false);
          setError('Microphone permission is off, so the wake word is disabled.');
        }
      },
    });

    detector.start();
    detectorRef.current = detector;

    return () => {
      detector.stop();
      detectorRef.current = null;
    };
  }, [wakeEnabled, name, startListening, voiceOutEnabled]);

  // Stop the wake listener while we are actively listening or speaking, so it
  // cannot hear the assistant say the user's own wake word and re-trigger.
  useEffect(() => {
    const detector = detectorRef.current;
    if (!detector || !wakeEnabled) return;
    if (state === 'listening' || state === 'speaking') detector.stop();
    else if (!detector.running) detector.start();
  }, [state, wakeEnabled]);

  useEffect(() => () => {
    listenRef.current?.abort();
    detectorRef.current?.stop();
    stopSpeaking();
  }, []);

  const toggleWake = useCallback((on: boolean) => {
    setWakeEnabled(on);
    if (typeof window !== 'undefined') window.localStorage.setItem(WAKE_PREF_KEY, on ? '1' : '0');
  }, []);

  const toggleVoiceOut = useCallback((on: boolean) => {
    setVoiceOutEnabled(on);
    if (!on) stopSpeaking();
    if (typeof window !== 'undefined') window.localStorage.setItem(VOICE_OUT_PREF_KEY, on ? '1' : '0');
  }, []);

  return {
    state,
    partial,
    error,
    supported,
    wakeEnabled,
    voiceOutEnabled,
    /** True while the microphone is open for any reason — drives the indicator. */
    micLive: state === 'listening' || wakeEnabled,
    /** True when wake detection sends audio off-device. Must be disclosed in UI. */
    wakeUsesRemoteAudio: detectorRef.current?.usesRemoteAudio ?? false,
    startListening,
    stopListening,
    say,
    shutUp,
    isSpeaking,
    toggleWake,
    toggleVoiceOut,
    setIdle: () => setState('idle'),
  };
}
