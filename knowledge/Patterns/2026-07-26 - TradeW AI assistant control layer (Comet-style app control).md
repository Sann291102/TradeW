# TradeW AI assistant control layer (Comet-style app control)

Phase 1 of turning the `FloatingAI` dock from a visual scaffold into a working
agent that **takes control of the application on command** — the product
reference the user named is Perplexity's Comet browser. Implements the
Navigation-intent half of [`TRADEW-ASSISTANT.md`](../../docs/product-architecture/TRADEW-ASSISTANT.md)
§2/§3/§5. Related: [[2026-07-18 - M3 dockable workspace (zustand store, dock engine, command palette)]]
(the store and palette this drives), [[2026-07-21 - Full platform and product audit]].

## The decision that shaped everything: no LLM in the control path

Navigation and app control resolve **deterministically** — pure functions, no
network, no model call. `TRADEW-ASSISTANT.md` §2 already called for this
("resolved to a route/action without invoking an LLM analysis agent at all"),
and it pays off three ways:

1. Commands are instant and free.
2. The whole grammar is testable without mounting React or holding an API key.
3. There is no generative surface for a jailbreak to steer in Phase 1.

Consequence: `lib/assistant/` splits **resolution** (pure) from **execution**
(React). `router.ts`/`commands.ts`/`instruments.ts`/`domain-guard.ts` import
nothing from React or Next; `useAssistant.ts` is the only file that touches the
router or the store. Keep that seam — it's what makes the grammar verifiable.

## The deep link already existed

The single biggest finding: **no new rendering path was needed** for
"open NIFTY 24300 call of 21st July". `components/trade/TradeWorkspace.tsx`
already reads `symbol` / `strike` / `type` / `expiry` off the query string and
renders that contract's own chart. The assistant only had to *resolve* the
utterance to:

```
/trade?symbol=NIFTY&strike=24300&type=CE&expiry=2026-07-21
```

Check for an existing deep link before building an assistant action.

## Parsing gotchas that produced real bugs

**Index names contain digits.** "NIFTY **50** 24300 call" — a naive
digit-grab yields 50. `findStrike` strips the matched alias text *and* anything
date-shaped before looking for numbers, then takes the largest remaining
candidate.

**Nearest occurrence, not next occurrence.** First version resolved a bare
"21st July" to the next *future* 21 July. Said on 26 Jul 2026 that produced a
**2027** expiry — a contract with no liquidity that the user obviously hadn't
asked for. Now `yearForNearestOccurrence` picks whichever of last/this/next
year is closest in absolute days, and `expiryPast` makes the reply say "that
expiry has already passed, so this contract is settled, not live" instead of
presenting a dead contract as live. Caught only by running the real command in
the browser — the logic reads fine on the page.

**Longest-alias-first ordering is load-bearing.** "bank nifty" must be tested
before "nifty", or `open bank nifty` silently opens the wrong instrument. Same
for symbols (BANKNIFTY before NIFTY) and nav labels.

**`call for 21st July` is not a request for a tip.** An early advice-refusal
pattern included `calls?\s+(for|on|today)` and refused a legitimate contract
command. `call`/`put` are deliberately absent from `ADVICE_RE` — the
directive framings ("should i", "recommend", "sure shot") carry the signal
without colliding with contract syntax.

**Everyday words are not domain signals.** With `open` in the market-term
allowlist, "open the pod bay doors" counted as in-domain and the remit fence
became meaningless. Bare `open`/`close`/`high`/`low`/`range` are excluded;
specific forms (`ohlc`, `gap up`, `trading range`) carry the same signal.

## Tabs are not panels — the "command succeeded but nothing changed" bug

The first version resolved "show the option chain" to
`restorePanel('optionChain')`. That flipped a store flag **nothing reads**: the
`optionChain`/`depth` PanelKinds were folded into `ChartPanel` as *tabs*, and
`TradeWorkspace` renders only three dock panels (`blotter`, `sentinel`,
`news`) — there is no `isVisible('optionChain') && <OptionChainPanel/>`. The
assistant reported "Option Chain panel is open" and the screen did not move.

Fix: `ChartPanel` gained an `initialView` prop and `TradeWorkspace` a validated
`?view=` param, so tab-like targets route to `/trade?view=optionChain`.
`VIEW_ALIASES` (tabs) and `PANEL_ALIASES` (real panels, restricted to the three
that render) are now separate tables.

**The general lesson:** an assistant action must be verified against what the
page actually *renders*, not against what the store can *represent*. A store
flag with no reader makes a command that lies. Check the render tree before
adding an action.

Note `ChartPanel` line ~271: the Option Chain tab only exists when the symbol
is `optionable`, and an `optionChain` view falls back to `charts` when it
isn't — so this deep link degrades gracefully when the Dhan bridge is down.

## Guard ordering is a contract

```
capability question → hard boundaries → command resolution → remit fence → analysis
```

Hard boundaries (orders, Sentinel, advice) sit **above** command resolution so
no phrasing reaches a prohibited capability by matching a command pattern. The
remit fence sits **below** it, because a resolved in-app command is in-domain
by construction — checking it first refuses legitimate commands whose wording
carries no market vocabulary ("switch to light mode").

## Sentinel: navigable, not narratable

Direction call of 2026-07-26: Sentinel is *the* premium feature, so the free
assistant **navigates to** Sentinel but never explains, relays or summarises
what it is doing. Paraphrasing Sentinel's reasoning through the assistant would
give away the thing users pay for. `guardHardBoundaries` refuses only when
`sentinel` **and** an explain-verb co-occur, so "open Sentinel" still works.
This narrows `TRADEW-ASSISTANT.md` §6 (auto-escalation to Sentinel) — that
section is now aspirational, not the current intent; see the note added there.

## The client-side fence is NOT a guardrail past Phase 1

`domain-guard.ts` carries this warning in the file, and it belongs here too:
it is a **deterministic pre-filter**, adequate now only because Phase 1
generates no free-form prose. Once the analysis agents land, real enforcement
must live server-side in `services/api` / `services/tradew-ai` (system prompt,
output checks, refusal handling) — anything client-side is user-editable. Do
not put Phase 2 generation behind that file alone.

## Not built (deliberately, stated rather than faked)

- **Analysis half** — chart reads, support/resistance, option-chain
  interpretation. Classified and parked with an honest "not wired up yet".
  The voice to use when it lands already exists in the repo:
  `chart-tabs/ContractAnalysisDrawer.tsx`'s `generateObservations()` is
  deterministic, rule-based, and describes what the numbers show without a
  buy/sell/entry/exit call.
- **Voice input** — `TRADEW-ASSISTANT.md` §2 specs speech-to-text. The
  number-words parser (`wordsToNumber`) is already in place for it, since STT
  emits "twenty four thousand three hundred" rather than digits.
- **Settings sub-topics** — "open settings → *particular topic*" can only
  reach `/settings`. `SettingsClient.tsx` has no section ids or anchors to
  target; adding them is a prerequisite, not an assistant change.
- **Forex/crypto structure talk** — in the stated remit, but every real feed
  is Dhan (Indian instruments). The vocabulary admits them; there is no data
  behind them yet, so analysis on those markets would be improvisation.

## Files

| File | Role |
|---|---|
| `apps/web/src/lib/assistant/types.ts` | `AssistantAction` union (no order-placement variant), plan shapes |
| `apps/web/src/lib/assistant/instruments.ts` | symbol universe + aliases, number-words, expiry, contract → deep link |
| `apps/web/src/lib/assistant/commands.ts` | command grammar; nav derived from `NAV_ITEMS` |
| `apps/web/src/lib/assistant/domain-guard.ts` | hard boundaries + remit fence |
| `apps/web/src/lib/assistant/router.ts` | the pipeline above |
| `apps/web/src/lib/assistant/useAssistant.ts` | execution + transcript (only React-aware file) |
| `apps/web/src/components/shell/FloatingAI.tsx` | dock: transcript, action trace, refusal styling |

Superseded scaffold: `archive/web-floating-ai-visual-scaffold.tsx.txt`.

## Verified

14 utterances driven through the real dock in-browser: contract open (both a
past and a future expiry), bare-symbol open, nav, panel show, layout apply,
theme switch, compound "open Research and explain", plus four refusal classes
(order, Sentinel, advice, out-of-domain). Contract commands produced the exact
expected URL and the chart header rendered `BANKNIFTY 52000 PE · 30 JUL
EXPIRY`. Console errors during the run were all Dhan-bridge-unreachable (the
API service wasn't running), none from the assistant.
