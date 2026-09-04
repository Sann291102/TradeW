'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, AnimatePresence } from 'framer-motion';
import { Mascot } from './Mascot';
import { ASSISTANT_NAME, ASSISTANT_DISCLAIMER } from '@/lib/assistant/identity';
import { useVoiceOutput } from '@/lib/assistant/useVoiceOutput';
import { SpeakerIcon, SpeakerOffIcon } from '@/components/shell/icons';
import type { AuthMode } from '@/lib/auth-mode';

/**
 * Tara introduces herself on the landing page, and answers real questions.
 *
 * ── WHY THIS IS NOT THE LLM ────────────────────────────────────────────────
 *
 * The in-app assistant reaches `services/tradew-ai` through an authenticated
 * endpoint. This surface is the opposite: every visitor is anonymous by
 * definition, so wiring it to the model would put an unauthenticated,
 * unmetered LLM endpoint on the public internet — a cost and abuse problem
 * that has nothing to do with the thing being demonstrated.
 *
 * So the answers here are WRITTEN, not generated. That is not a downgrade for
 * this job: the questions a prospective user asks are a small, stable set
 * ("what is Sentinel", "can it place trades", "what does it cost"), the
 * answers must be exactly right because they are commitments, and every one is
 * already stated on the page below. What the visitor learns about Tara — that
 * she is there, that she has a name and a voice, that she answers plainly and
 * says what she will not do — is entirely true.
 *
 * The one thing this must never do is imply she is answering freely. There is
 * no open text input: only the questions she can genuinely answer are offered,
 * and the last card tells the reader where the real conversation happens.
 *
 * ── PRICES ARE NOT REPEATED HERE ───────────────────────────────────────────
 *
 * The cost answer deliberately points at the pricing section rather than
 * quoting figures. `packages/types/src/pricing.ts` is the single source of
 * truth and a third hand-typed copy in a chat script is exactly the drift that
 * change was made to end.
 */

interface Exchange {
  q: string;
  a: string;
}

/**
 * Every answer here is a claim the product must stand behind, so each one is
 * traceable: the boundaries come from `ARCHITECTURE.md` §1/§4 and
 * `SENTINEL.md` §5, the surfaces from `TRADEW-OS.md`, the paper-trading
 * default from `SUBSCRIPTIONS.md` §1.
 */
const EXCHANGES: Exchange[] = [
  {
    q: 'What is TradeW?',
    a: "One workspace for markets, research, risk and learning. Charts, option chains, your portfolio and order entry sit in the same place as the research and the lessons — so moving between analysing something and acting on it isn't a context switch.",
  },
  {
    q: 'What is Sentinel?',
    a: "The premium layer. It watches market structure and your own trading behaviour together — chasing, revenge trades, low-conviction breakouts — and says something before the mistake rather than in the monthly review. It shows the evidence behind every card, and it never blocks or delays an order.",
  },
  {
    q: 'Can you place trades for me?',
    a: "No — and not as a setting either. I can open any screen, read you a price and rearrange your workspace, but there is no order action anywhere in what I'm able to do. Converting anything into a trade is always something you do by hand.",
  },
  {
    q: 'Will you tell me what to buy?',
    a: "No. I describe what the market is doing and cite the evidence — 'volume is below the 20-day average and open interest is declining' — and stop there. No entries, no targets, no calls. If you want a signal service, this isn't one.",
  },
  {
    q: 'What does it cost?',
    a: "A free account gets you the workspace, research and paper trading — no card. The paid plans are listed further down this page. Payments aren't switched on yet, so nothing can be charged today.",
  },
  {
    q: 'Do I need a broker to start?',
    a: 'No. You start on paper trading against live prices, and connecting a broker is a separate step you take when you decide to. Until then nothing you do can move real money.',
  },
];

const GREETING = `Hi, I'm ${ASSISTANT_NAME} — TradeW's AI. I run this platform for the people who use it. Ask me anything about it.`;

/** See `LandingHeaderProps.onAuthIntent` — this CTA offers account creation. */
export type TaraGreeterProps = { onAuthIntent?: (mode: AuthMode) => void };

export function TaraGreeter({ onAuthIntent }: TaraGreeterProps = {}) {
  const reduce = useReducedMotion();
  const [typed, setTyped] = useState(reduce ? GREETING : '');
  const [asked, setAsked] = useState<Exchange[]>([]);
  const [speechOn, setSpeechOn] = useState(false);
  const speech = useVoiceOutput(speechOn);
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * Type the greeting in. Deliberately fast (18ms/char) — a slow typewriter on
   * a landing page is a thing the reader has to wait through, and the whole
   * point is that she feels responsive. Skipped entirely under
   * prefers-reduced-motion, where the text is simply present.
   */
  useEffect(() => {
    if (reduce) return;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setTyped(GREETING.slice(0, i));
      if (i >= GREETING.length) clearInterval(id);
    }, 18);
    return () => clearInterval(id);
  }, [reduce]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [asked]);

  function ask(x: Exchange) {
    if (asked.some((a) => a.q === x.q)) return;
    setAsked((prev) => [...prev, x]);
    speech.speak(x.a);
  }

  const remaining = EXCHANGES.filter((x) => !asked.some((a) => a.q === x.q));

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:items-start lg:gap-14">
      <div className="text-center lg:sticky lg:top-24 lg:text-left">
        <Mascot size={180} className="mx-auto lg:mx-0" />
        <p className="mt-6 text-fs2xs font-semibold uppercase tracking-wideTrack text-teal">
          Meet {ASSISTANT_NAME}
        </p>
        <h2 className="mt-3 text-balance text-fs2xl font-bold tracking-tightTrack text-navy">
          She runs the platform. Ask her about it.
        </h2>
        <p className="mt-4 text-fsXs leading-normal2 text-muted">
          {ASSISTANT_NAME} is the same assistant you get inside TradeW — in the corner of every
          screen, by text or by voice.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 sm:p-7">
        <div className="flex items-center gap-2 border-b border-border pb-3">
          <span className="text-fsSm font-bold text-text">{ASSISTANT_NAME}</span>
          <span className="flex items-center gap-1 text-[11px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-up" /> Online
          </span>
          {speech.supported && speech.hasVoice && (
            <button
              type="button"
              onClick={() => {
                if (speechOn) speech.cancel();
                setSpeechOn(!speechOn);
              }}
              aria-label={speechOn ? `Mute ${ASSISTANT_NAME}` : `Let ${ASSISTANT_NAME} speak`}
              aria-pressed={speechOn}
              className={`ml-auto rounded-lg p-1.5 transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                speechOn ? 'text-teal hover:bg-hover' : 'text-faint hover:bg-hover hover:text-text'
              }`}
            >
              {speechOn ? <SpeakerIcon className="h-4 w-4" /> : <SpeakerOffIcon className="h-4 w-4" />}
            </button>
          )}
        </div>

        <div ref={scrollRef} className="max-h-[22rem] space-y-3 overflow-y-auto py-4">
          <p className="rounded-card rounded-tl-sm border border-border bg-bg px-4 py-3 text-fsXs leading-normal2 text-text">
            {typed}
            {!reduce && typed.length < GREETING.length && (
              <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-teal align-middle" />
            )}
          </p>

          <AnimatePresence initial={false}>
            {asked.map((x) => (
              <motion.div
                key={x.q}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="space-y-2"
              >
                <p className="ml-auto w-fit max-w-[85%] rounded-card rounded-br-sm bg-teal px-3.5 py-2 text-fsXs text-white">
                  {x.q}
                </p>
                <p className="rounded-card rounded-tl-sm border border-border bg-bg px-4 py-3 text-fsXs leading-normal2 text-text">
                  {x.a}
                </p>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Only answerable questions are offered. There is deliberately no free
            text box: an input that silently ignores what you type would imply a
            conversation this surface cannot have. */}
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          {remaining.map((x) => (
            <button
              key={x.q}
              type="button"
              onClick={() => ask(x)}
              className="rounded-full border border-border2 px-3 py-1.5 text-fs2xs font-semibold text-muted transition-colors duration-micro hover:border-teal hover:text-teal focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {x.q}
            </button>
          ))}
          {remaining.length === 0 && (
            <a
              href="#auth"
              onClick={() => onAuthIntent?.('signup')}
              className="rounded-full bg-teal px-4 py-1.5 text-fs2xs font-semibold text-bg transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              That&rsquo;s everything I can answer out here — create an account to really talk to me →
            </a>
          )}
        </div>

        <p className="mt-3 text-[10px] leading-tight text-faint">{ASSISTANT_DISCLAIMER}</p>
      </div>
    </div>
  );
}
