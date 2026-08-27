# AI Voice — Product Blueprint

Status: design, pre-implementation. Introduced by the direction update of 2026-08-10, which expands the single line "voice input" in [`TRADEW-ASSISTANT.md`](TRADEW-ASSISTANT.md) §1 into a full duplex voice layer. Governed by [`TRADEW-OS.md`](TRADEW-OS.md) §1. The name the wake word uses comes from [`AI-PERSONA.md`](AI-PERSONA.md).

## 1. The principle

**Voice is an interface to the assistant, not a separate assistant.** Wake word, speech-to-text, intent resolution, orchestration, response, speech-out and UI actions are one pipeline whose middle is identical to the typed path (`TRADEW-ASSISTANT.md` §9). Anything the user can say, they can type; anything typed, they can say. There is no voice-only capability and no voice-only guardrail.

## 2. Two activation modes, both in v1

| Mode | Trigger | Always available |
|---|---|---|
| **Push-to-talk** | Mic button in the dock, or a global keyboard shortcut | Yes — the baseline, works everywhere, no standing mic permission |
| **Wake word** | "Hey \<Name\>" spoken aloud | Opt-in per device (§3), off until the user turns it on |

Push-to-talk is the floor and never degrades. Wake word is the ambient layer on top, and every path below falls back to push-to-talk when wake detection is unavailable, unsupported, or declined.

## 3. Wake word: on-device only

**Constraint that drives this whole section:** Chrome's `webkitSpeechRecognition` streams microphone audio to a remote recognition service. Using it for an always-listening wake word would mean continuously uploading the user's microphone to a third party for the entire trading session. That is not acceptable, so browser speech recognition is used **only after wake** (§4), never to detect it.

Wake detection therefore runs entirely in the browser:

```
Microphone (AudioWorklet)
      │
      ▼
VAD gate — is anyone speaking at all?          ~0 cost when silent
      │  (silence → discard, never buffered)
      ▼
Small on-device ASR (WASM, restricted grammar) rolling ~2s window
      │
      ▼
Literal match against users.ai_persona_name    (§5, AI-PERSONA.md §5)
      │
      ▼
WAKE  ──►  "I'm listening."  ──►  capture the utterance (§4)
```

- **Audio never leaves the device before wake.** Pre-wake frames are processed in a rolling buffer and discarded; nothing is uploaded, stored, or written to disk.
- A voice-activity gate runs first so the ASR model is only invoked when there is speech, rather than burning CPU and battery on an empty room.
- **The free-text-name decision (`AI-PERSONA.md` §3) rules out pre-trained keyword models.** Porcupine and openWakeWord need a model trained per keyword, which cannot be done at runtime for a name the user just invented. A small general ASR with local string matching is the design that supports arbitrary names — at the cost of a multi-megabyte model download and lower accuracy than a trained keyword spotter.
- **Accuracy on unusual names will be imperfect**, and the product should not pretend otherwise: matching is fuzzy (phonetic, not exact-string), the sensitivity is user-adjustable, and if a name proves undetectable the settings surface says so and points at push-to-talk rather than leaving the user talking to a device that never answers.
- Wake word is **opt-in per device and off by default.** It requires standing microphone permission, so it is never enabled silently, and a persistent, always-visible indicator shows when the microphone is live.

## 4. After wake: the capture path

1. **Acknowledge immediately** — "I'm listening." Spoken and shown. Latency here is the whole feel of the feature; the acknowledgement must not wait on any network call.
2. **Capture the utterance** with endpointing (stop on natural end-of-speech, hard cap on length).
3. **Transcribe.** Browser speech recognition where available, server-side STT via `services/api` otherwise. This is post-wake, scoped to one utterance, and the user has just deliberately addressed the assistant.
4. **Hand the transcript to the same resolver the typed path uses** (`TRADEW-ASSISTANT.md` §9). From here, voice is indistinguishable from typing.
5. **Barge-in:** if the user speaks while the assistant is talking, speech-out stops instantly and the new utterance takes over. An assistant that talks over you is worse than one that stays quiet.

## 5. Voice out

- **v1: the browser's `SpeechSynthesis`.** Free, offline, zero infrastructure. Voice quality varies by platform and Indian-English voices are frequently poor — accepted for v1, and the reason §9 keeps cloud TTS open.
- **Spoken responses are short.** The spoken answer is a summary; the detail goes to the panel (`TRADEW-ASSISTANT.md` §10). Reading a full market analysis aloud is unusable, and the constraint improves the written answer too.
- **Not everything is spoken.** Navigation acknowledgements are brief or silent; analysis answers are spoken. The disclaimer (`TRADEW-AI.md` §4) is rendered visually and is not read aloud every time — repeating it in speech on every turn trains users to ignore it, and it remains present on the surface where the claim actually lives.
- The persona name is escaped before reaching the synthesizer, never interpolated into markup (`AI-PERSONA.md` §5).

## 6. Privacy

- **Raw audio is never persisted** — not pre-wake, not post-wake, not as a "standing recording." It exists in memory for the length of one utterance.
- **Transcripts are messages.** This refines `TRADEW-ASSISTANT.md` §7, written when conversations were not stored at all: a spoken question becomes a message in the conversation exactly as a typed one does, and lives under the retention rules in `AI-CONVERSATION-LIFECYCLE.md` §8. The original *audio* is still discarded, which is what that rule was protecting.
- Microphone state is always visible, and revoking permission or toggling wake word off takes effect immediately, without a reload.
- No voice biometrics, no speaker identification, no passive analysis of ambient audio. The microphone answers to the wake word and to the mic button, and does nothing else.

## 7. Accessibility

- Voice is an addition, never a requirement — every capability stays reachable by keyboard and pointer.
- Speech-out respects `prefers-reduced-motion`'s intent by pairing with visible text, and is independently mutable.
- Transcripts of what the assistant said stay in the thread, so a spoken answer is never lost to a user who missed it.
- Autoplay policy means the pre-auth naming moment (`AI-PERSONA.md` §2) cannot assume it may speak on load — it needs a user gesture first, which is an open item there.

## 8. Where this runs

Client-side: VAD, wake detection, capture, barge-in, speech synthesis. Server-side (`services/api` → `services/tradew-ai`): STT fallback, intent, orchestration.

No new service (`TRADEW-ASSISTANT.md` §8's reasoning is unchanged): STT and intent are request-scoped and stateless, and belong in the existing request path rather than a `services/voice` that would add a hop for nothing.

## 9. Open items

- Which WASM ASR ships for wake detection (Vosk, whisper.cpp, Moonshine) — a measured choice on model size, latency, and accuracy against Indian-English names, not a guess made here.
- Cloud TTS provider and whether voice quality justifies the per-character cost and the privacy surface of sending response text off-platform.
- Whether wake word should auto-disable during a live order-entry flow, so an overheard phrase cannot pull focus mid-order.
- Mobile behaviour (`apps/mobile`) — background microphone access has materially different platform rules and is out of scope for the web v1.
