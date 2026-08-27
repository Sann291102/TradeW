'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@tradew/ui';
import {
  fetchSuggestions,
  readLocalPersonaName,
  validatePersonaName,
  writeLocalPersonaName,
} from '@/lib/assistant/persona';
import { speak, speechSynthesisSupported } from '@/lib/voice/speech';

/**
 * The naming moment — the first thing on the landing page, before signup
 * (`AI-PERSONA.md` §2).
 *
 * The AI introduces itself and asks to be named. The answer is held locally
 * until signup carries it onto the account: no server-side record is created
 * for someone who may never sign up.
 *
 * ## Why it does not speak on load
 *
 * Browsers block autoplay audio without a user gesture, so an assistant that
 * "speaks first" would either be silently swallowed or require a permission
 * prompt before the user knows what the product is. It offers to speak instead,
 * and speaks from the button press onward — which is a gesture. This is the
 * open item in `AI-PERSONA.md` §9, resolved as text-first.
 */

const GREETING = 'Welcome to TradeW. What would you like to call me?';

export function NameYourAI({ onNamed }: { onNamed?: (name: string) => void }) {
  const [name, setName] = useState('');
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setConfirmed(readLocalPersonaName());
    void fetchSuggestions().then(setSuggestions);
  }, []);

  async function submit(candidate: string) {
    const trimmed = candidate.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await validatePersonaName(trimmed);
      if (!result.ok) {
        setError(result.message ?? 'Try a different name.');
        inputRef.current?.focus();
        return;
      }
      const accepted = result.name ?? trimmed;
      writeLocalPersonaName(accepted);
      setConfirmed(accepted);
      setName('');
      onNamed?.(accepted);
      if (speechSynthesisSupported()) {
        // The click is the gesture that unlocks audio, so this one is allowed.
        speak(`${accepted}. I like it. Let's get you set up.`);
      }
    } finally {
      setBusy(false);
    }
  }

  if (confirmed) {
    return (
      <div className="rounded-card border border-teal bg-card p-4">
        <p className="text-sm text-text">
          I’m <strong className="font-bold text-teal">{confirmed}</strong>. Create an account below
          and I’ll be there when you land.
        </p>
        <button
          type="button"
          onClick={() => {
            setConfirmed(null);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className="mt-2 text-[11px] font-semibold text-muted underline underline-offset-2 hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          Call me something else
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-card border border-border bg-card p-4">
      <p className="text-sm font-semibold text-text">{GREETING}</p>
      <p className="mt-1 text-[11px] text-muted">
        Whatever you pick is what I answer to — including out loud, once you’re inside.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(name);
        }}
        className="mt-3 flex items-center gap-2"
      >
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          maxLength={24}
          aria-label="Name your AI"
          aria-invalid={error ? true : undefined}
          placeholder="Type a name…"
          className={cn(
            'flex-1 rounded-lg border bg-bg px-3 py-2 text-sm text-text placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
            error ? 'border-amber' : 'border-border2',
          )}
        />
        <button
          type="submit"
          disabled={!name.trim() || busy}
          className="rounded-lg bg-teal px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {busy ? '…' : 'That’s you'}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-2 text-[11px] text-amber">
          {error}
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-faint">or</span>
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void submit(s)}
              className="rounded-full border border-border2 px-2.5 py-1 text-[11px] font-semibold text-muted transition-colors duration-micro hover:border-teal hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
