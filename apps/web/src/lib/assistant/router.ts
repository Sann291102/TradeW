import { resolveCommand } from './commands';
import { guardDomain, guardHardBoundaries } from './domain-guard';
import { analysisPlan, commandPlan, type AssistantPlan } from './types';

/**
 * The assistant's single entry point: utterance in, plan out.
 *
 * Pipeline order is the contract (TRADEW-ASSISTANT.md §2 adds one routing
 * branch upstream of the analysis agents):
 *
 *   1. capability question   — "what can you do"
 *   2. hard boundaries       — orders, Sentinel's reasoning, trade advice
 *   3. command resolution    — navigation / app control, executed immediately
 *   4. remit fence           — markets + this app only
 *   5. analysis              — parked for Phase 2
 *
 * Boundaries sit above command resolution so no phrasing can reach a
 * prohibited capability. The remit fence sits below it, because a resolved
 * in-app command is in-domain by construction.
 */

const CAPABILITY_RE = /\b(what can you do|what do you do|who are you|your capabilities|what are you able|help me|how can you help|commands?\b.*\b(list|available)|what should i ask)\b/i;

const CAPABILITY_REPLY = [
  "I'm TradeW AI — I run this application for you and I explain the markets. Two things:",
  '',
  '**I take control of the app.** Tell me where to go and I go:',
  '• "open NIFTY 24300 call of 21st July" — opens that exact contract\'s chart',
  '• "open RELIANCE chart", "open Research", "open Settings"',
  '• "show the option chain", "hide the order ticket", "apply the scalping layout"',
  '• "switch to light mode", "open the command palette"',
  '',
  '**I explain markets** — structure, levels, option data, news, and how anything in TradeW works. Indian markets first, plus forex, commodities and crypto.',
  '',
  "What I won't do: place or cancel orders, give you trade calls or targets, relay Sentinel's premium analysis, or talk about anything outside markets and this app.",
].join('\n');

/** Resolve one utterance into an executable, displayable plan. */
export function resolveUtterance(text: string, today = new Date()): AssistantPlan {
  const t = text.trim();

  if (!t) {
    return commandPlan('Say what you need — a screen, a chart, a contract, or a question about the market.', []);
  }

  if (CAPABILITY_RE.test(t)) {
    return commandPlan(CAPABILITY_REPLY, []);
  }

  const boundary = guardHardBoundaries(t);
  if (boundary) return boundary;

  const command = resolveCommand(t, today);
  if (command) return command;

  const outOfDomain = guardDomain(t);
  if (outOfDomain) return outOfDomain;

  // In-domain, but not a command — this is an analysis question. The reasoning
  // agents (chart read, support/resistance, option-chain interpretation) are
  // the next phase; say so rather than improvising an answer, which is exactly
  // the failure mode TRADEW-AI.md §4 exists to prevent.
  return analysisPlan(
    "That's a market question I'm built for, but my analysis engine isn't wired up yet — that's the next phase. Right now I can navigate and control the app; ask me to open something and I'll take you straight there.",
    ['Classified → market analysis', 'Analysis agents not yet connected (Phase 2)'],
  );
}
