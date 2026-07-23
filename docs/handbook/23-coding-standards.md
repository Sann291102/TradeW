# Chapter 23 — Coding Standards

**Status: 🟡.** The standards below are largely *observed* in the codebase — the code is unusually consistent and unusually well commented. They are **not enforced by tooling**: there is no ESLint configuration anywhere in the repository (TD-3), no Prettier config, and no pre-commit hooks. Enforcement is currently human, which is slower and less reliable than a linter.

---

## 23.1 The prime directive

> **Write code that reads like the code around it.** Match the surrounding comment density, naming, and idiom. A file with one function in a different style is harder to read than a file that is uniformly imperfect.

Everything below is an elaboration of that sentence.

---

## 23.2 TypeScript

### 23.2.1 Strictness

```jsonc
{
  "strict": true,                        // non-negotiable
  "noUncheckedIndexedAccess": true,      // 🔵 not yet on — should be
  "noImplicitOverride": true,            // 🔵
  "exactOptionalPropertyTypes": true     // 🔵
}
```

`strict: true` is on. The three 🔵 flags are worth enabling; `noUncheckedIndexedAccess` in particular would have caught several places where `candles[candles.length - 1]` is used without a guard.

### 23.2.2 `any` is a review failure

```ts
// ❌
function process(data: any) { … }

// ✅ unknown + narrowing
function process(data: unknown) {
  if (!isMarketTick(data)) throw new Error('unexpected payload');
  …
}

// ✅ a genuinely generic container
function first<T>(items: T[]): T | undefined { return items[0]; }
```

The one accepted `any` is at an external boundary, and it must be narrowed immediately:

```ts
const snapshot = (await res.json()) as BridgeSnapshot;   // acceptable: external JSON
```

### 23.2.3 Nullability is information

```ts
rsi14: number | null;      // null = not enough data to compute
oiTrend: 'rising' | 'falling' | 'flat' | 'unknown';
```

> **Never default a missing value to something that looks like data.**

`MarketTick`'s contract states the rule explicitly:

> *"A consumer must be able to tell 'not sent in this mode' from 'sent as zero', so absent fields are `undefined` rather than defaulted."*

`volume: 0` means no volume traded. `volume: undefined` means the feed mode does not carry volume. A consumer that defaults the second to the first computes a 20-bar average of zero, divides by it, and reports that breakout volume is `Infinity%` of average.

### 23.2.4 Discriminated unions over boolean flags

```ts
// ✅
export type ParsedPacket =
  | { kind: 'tick';       tick: MarketTick }
  | { kind: 'disconnect'; code: number; securityId: string }
  | { kind: 'unknown';    header: PacketHeader };

// ❌
interface ParsedPacket { isTick: boolean; isDisconnect: boolean; tick?: MarketTick }
```

The union makes the impossible states unrepresentable and gives exhaustiveness checking in the `switch`.

### 23.2.5 Interfaces for data, types for unions

```ts
export interface MarketTick { … }               // a data shape
export type FeedMode = 'ticker' | 'quote' | 'full';   // a union
export type PanelKind = 'watchlist' | 'chart' | …;
```

### 23.2.6 `readonly` on shared constants

```ts
export const RELATION_TYPES = ['is_a', 'part_of', …] as const;
export type RelationType = (typeof RELATION_TYPES)[number];
```

`as const` gives a literal union type derived from the array — one source of truth for both the runtime list and the compile-time type. Adding a relation updates both, or neither.

### 23.2.7 No enums except Prisma's

TypeScript `enum` emits runtime code and has surprising bidirectional-mapping semantics. Use `as const` + a derived union. Prisma-generated enums are the exception and are used directly.

---

## 23.3 Naming

### 23.3.1 The table

| Kind | Convention | Example |
|---|---|---|
| File — component | `PascalCase.tsx` | `TradeChart.tsx` |
| File — service | `kebab-case.service.ts` | `order.service.ts` |
| File — utility | `camelCase.ts` | `technicals.ts` |
| File — types | `types.ts` / `interfaces.ts` | |
| Class | `PascalCase` + role suffix | `OrderService`, `AuthGuard` |
| Interface | `PascalCase`, no `I` prefix | `MarketTick`, not `IMarketTick` |
| Function | `camelCase`, verb-first | `computeMargin`, `applyFill` |
| React hook | `useThing` | `useCandles` |
| Constant | `SCREAMING_SNAKE` | `POLL_MS`, `CHARGES_RATE` |
| Signal name | `snake_case` | `low_volume_breakout` |
| Concept id | `kebab-case` | `liquidity-sweep` |
| DB model | `PascalCase` singular | `Order`, not `Orders` |
| DB column | `camelCase` | `avgFillPrice` |
| Env var | `SCREAMING_SNAKE` | `SERVICE_TOKEN` |
| Package | `@tradew/kebab-case` | `@tradew/market-data` |

### 23.3.2 Domain terms win over consistency

```ts
/** Mark-to-market — the open position's P&L at the current price. Same
 *  number as unrealizedPnl; kept as a separate field because "MTM" is the
 *  term traders expect on a positions screen. */
mtm: number;
```

A redundant field, kept because renaming a domain term to save a field would make the API tidier and the product worse. Indian traders read "MTM" on every broker screen they have used.

### 23.3.3 Name the units

```ts
const POLL_MS = 3_000;
const QUOTES_CACHE_TTL_MS = 2_000;
const MIN_AGE_MS = 15 * 60_000;
const VOL_PER_MINUTE = 0.00055;
realizedVolPct: number | null;     // percent, per bar
gapMin: number;                    // minutes
```

`timeout = 30` is unreadable. `TIMEOUT_MS = 30_000` is not.

### 23.3.4 Numeric separators

```ts
const STARTING_BALANCE = 1_000_000;   // ₹10L
const SESSION_LENGTH_MIN = 375;
```

---

## 23.4 Comments — the ⭐ standard

> **Comments explain *why*, never *what*.**

This is the single most distinctive quality of the TradeW codebase, and it is the standard most worth defending.

### 23.4.1 The test

> **Would a competent engineer, reading this code six months from now, be tempted to "fix" it?**
>
> If yes, the comment explaining why it is deliberate is mandatory.

### 23.4.2 Worked examples from the codebase

```prisma
/// Plain slug references, not FKs — a concept may name its successor before
/// that successor has been authored, and a FK would make seed order matter.
supersededBy String?
```
*Looks like a missing foreign key. Is correct.*

```ts
// Dhan's quote-mode ticks frequently carry bid=ask=0 (no depth in this
// mode, especially after hours) — fall back to a small synthetic
// spread around LTP so LIMIT/SL fill logic always has something
// sensible to compare against, rather than treating 0 as a real,
// crossable price.
bid: quote.bid > 0 ? quote.bid : quote.ltp * 0.9995,
```
*Looks like unnecessary defensive code. Prevents every resting BUY limit filling instantly at zero.*

```ts
// anchorPrice moves on every live tick. It must NOT be an effect dependency —
// otherwise the series reloads (and the chart refits, wiping the user's zoom)
// several times a second, and the /candles route gets hammered.
const anchorRef = useRef(anchorPrice);
```
*Looks like a lint violation (missing dependency). Is the fix.*

```ts
// SL -> now a resting LIMIT at `order.price`. Re-check in the same
// tick (not next tick) in case the trigger and the limit are both
// satisfied by the same price move.
```
*Looks like redundant control flow. Prevents a 3-second artificial delay on SL fills.*

### 23.4.3 What not to comment

```ts
// ❌ increment i
i++;

// ❌ get the user
const user = await this.prisma.user.findUnique({ where: { id } });

// ❌ Order service
export class OrderService { }
```

### 23.4.4 Docstrings for non-obvious modules

Every substantial file opens with a docstring covering: what it is, why it exists, what it deliberately does not do, and what it replaced. `MarketPriceService`'s is 18 lines and every one earns its place.

### 23.4.5 Documented limitations

```ts
/**
 * Simplified simulated margin — NOT real SPAN/exposure margin. … Documented
 * here rather than silently presented as authoritative.
 */
```

```ts
/** Doesn't account for exchange holidays (no holiday calendar available —
 *  same known gap as `isMarketOpen` elsewhere in this app). */
```

**Naming a limitation at the point of implementation is worth more than a wiki page.** The next engineer finds it when they need it.

---

## 23.5 React

### 23.5.1 Component structure

```tsx
'use client';                                    // only when needed

import { … } from 'react';                       // 1. react
import { … } from 'next/…';                      // 2. framework
import { … } from '@tradew/ui';                  // 3. workspace packages
import { … } from '@/components/…';              // 4. local
import type { … } from '@tradew/types';          // 5. types last

export interface TradeChartProps { … }           // props interface, exported

function helper() { … }                          // module-scope helpers

export function TradeChart({ … }: TradeChartProps) {
  // 1. hooks, in a stable order
  // 2. derived values
  // 3. effects
  // 4. handlers
  // 5. early returns
  // 6. render
}
```

### 23.5.2 `'use client'` only where required

Server Components are the default. Add `'use client'` only for state, effects, browser APIs, or event handlers. Pushing it to the leaves keeps more of the tree server-rendered.

### 23.5.3 Selector discipline ⭐

```tsx
// ❌ re-renders when ANY quote changes
const quotes = useQuoteStore(s => s.quotes);

// ✅ re-renders only when THIS ltp changes
const ltp = useQuoteStore(s => s.quotes[symbol]?.ltp);
```

**Select the narrowest slice you need.** This is a performance rule (Chapter 20 §20.3.2) and a review standard.

### 23.5.4 The ref rule ⭐

```tsx
const liveRef = useRef(livePrice);
liveRef.current = livePrice;
useEffect(() => { /* reads liveRef.current */ }, [symbol, interval]);
```

**A tick-frequency value that is only *read* inside an effect belongs in a ref, not a dependency array.**

### 23.5.5 Cancellation is mandatory

```tsx
useEffect(() => {
  let cancelled = false;
  (async () => {
    const data = await fetchThing();
    if (cancelled) return;
    setData(data);
  })();
  return () => { cancelled = true; };
}, [deps]);
```

### 23.5.6 Hooks return `{ data, status }`

Never a bare value. The status must distinguish real data from a fallback (`'live' | 'preview'`), and the fallback state must be **visible in the UI** — the honesty principle at the component level.

### 23.5.7 Config-driven, not hardcoded

```ts
export const NAV_ITEMS: NavItem[] = [ … ];
export const PANEL_REGISTRY: Record<PanelKind, PanelRegistryEntry> = { … };
```

Adding a page is one row. Adding a panel is one row plus a union member. Both become searchable in the command palette for free, because the palette reads the same configs.

---

## 23.6 Backend

### 23.6.1 Controllers are thin

```ts
@UseGuards(AuthGuard)
@Post('orders')
place(@Req() req, @Body() dto: PlaceOrderDto) {
  return this.orders.placeOrder(req.user.sub, dto);
}
```

Validate (via the DTO), delegate, return. **Business logic in a controller cannot be reused or tested.**

### 23.6.2 ⭐ Identity from the token, always

```ts
req.user.sub    // ← the ONLY source of user identity
```

> ⚠️ If you write `@Body() { userId }`, stop. It is in the token. This single discipline eliminates the entire "user A operates on user B's account" class of bug.

### 23.6.3 Guards at the controller, never in a service

```ts
@UseGuards(AuthGuard, CapabilityGuard)
@RequiresCapability('sentinel')
```

The protection surface must be **greppable**. A permission check buried in a service is invisible to a reviewer scanning for unguarded routes.

### 23.6.4 DTOs declare every accepted field 🔒

`ValidationPipe({ whitelist: true })` strips anything undeclared. An undeclared field silently disappearing is the intended behaviour and is what makes mass assignment impossible.

### 23.6.5 Transactions for money

```ts
return this.prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ … });
  return this.executeFill(tx, order, …);   // ← tx threaded through
});
```

**Thread `tx` through helpers** rather than reaching for `this.prisma` inside them. That is what makes composition inside a transaction possible.

> ⚠️ **Never `await` a network call inside a transaction.** Fetch the price before opening it.

### 23.6.6 ⭐ Degrade, never fail

```ts
// enriching — the feature is absent, the response is complete
try { await enrich(); } catch (err) { this.logger.warn(`… (non-fatal): ${err}`); }

// fire-and-forget — never awaited, zero latency added
void backgroundWork().catch(() => undefined);

// additive
const extra = await optional().catch(() => undefined);

// ⚖️ compliance — non-fatal, but log LOUDLY
try { await audit(); } catch (err) { this.logger.error(`…: ${err}`); }
```

Four tiers, four idioms. Pick the one that matches the consequence of failure.

### 23.6.7 Expected absence is not logged

```ts
catch (err) {
  if (!(err instanceof ProviderNotAvailableError)) {
    this.logger.warn(`… failed: ${err}`);
  }
  return fallback;
}
```

`ProviderNotAvailableError` is the normal local-development state. A warning on every request is a warning nobody reads, and an ignored warning channel is worse than a silent one.

---

## 23.7 File and folder structure

```
   Group by FEATURE, not by type.

   ✅ services/api/src/sim/{controller,service,util}
   ❌ services/api/src/{controllers,services,utils}/sim*
```

| Rule | |
|---|---|
| One exported class or component per file | helpers may be private in the same file |
| Files under ~500 lines | `order.service.ts` at 428 is at the limit; a documented reason is required beyond it |
| Barrel `index.ts` only in packages | not inside apps or services — it defeats tree-shaking and creates import cycles |
| Types beside their consumer, or in `packages/types` if shared | |
| No file named `utils.ts` | name what it does: `ist-time.util.ts`, `technicals.ts` |

---

## 23.8 Error handling

### 23.8.1 The right exception type

```ts
throw new BadRequestException('Quantity must be a multiple of lot size 50');   // 400
throw new UnauthorizedException('Invalid credentials');                        // 401
throw new ForbiddenException({ message: 'Missing entitlement: sentinel', … }); // 403
throw new NotFoundException('Unknown instrument "FOO"');                       // 404
```

### 23.8.2 Error messages are user-facing copy

```ts
// ✅ tells the user what to do
'Quantity must be a multiple of lot size 50'
'Market data is temporarily unavailable — try again shortly'
'Option contract order placement is not available yet — underlyings only in this phase'

// ❌
'Invalid input'
'Error 500'
'Something went wrong'
```

### 23.8.3 🔒 Uniform auth errors

Unknown email and wrong password both return `'Invalid credentials'`. No user enumeration.

### 23.8.4 A domain rejection is data, not an exception

An insufficient-margin rejection **creates an `Order` row** with `status: REJECTED` and a `rejectReason`. It is a trading event and belongs in the user's history. A malformed request throws and creates nothing — it is a client bug.

---

## 23.9 ⚖️ Compliance in code

**Every engineer is responsible for ARCH-4.** These are review-blocking:

```
   ❌ any string containing Buy/Sell/Entry/Target/Stop-loss as an instruction
   ❌ any imperative about a trade ("consider selling", "reduce your size")
   ❌ any probability-of-profit claim
   ❌ any diagnosis of a user's emotional state
   ❌ any fabricated value for an unavailable dimension
   ❌ any AI response without a disclaimer
   ❌ any observation persisted without evidence and a category
   ❌ any tool that writes to a trading table
```

If you are writing user-facing copy or a prompt, read Chapter 6 §6.4 (the never-does contract) first, not after.

---

## 23.10 Git

### 23.10.1 Branching

```
   main ──────●────────●────────●────────●──────►   always deployable
               ╲      ╱ ╲      ╱
                ●────●   ●────●
             feat/…      fix/…
```

Trunk-based with short-lived branches. **A branch older than three days is a merge conflict waiting to happen.**

| Prefix | For |
|---|---|
| `feat/` | new capability |
| `fix/` | bug fix |
| `refactor/` | no behaviour change |
| `docs/` | documentation |
| `chore/` | tooling, deps |
| `audit/` | investigation, findings |

### 23.10.2 Commits — Conventional Commits

```
   <type>(<scope>): <subject>

   <body — WHY, not what>

   <footer>
```

Real examples from this repository:

```
   feat(sim): full order lifecycle — LIMIT/SL/SL_M, modify, cancel, partial fills
   fix(web): AppFrame mount-only effect didn't re-run on client navigation
   refactor(market-data): collapse two divergent simulators into packages/market-data
   docs: add definitive developer reference and expand QA audit
   chore(infra): add pgAdmin service to local docker-compose
   audit: comprehensive QA and product audit of TradeW application
```

**The body explains why.** *"Collapse two divergent simulators"* is what; *"they disagreed on the same symbol at the same instant, flagged High severity"* is why, and it is the sentence that matters in eighteen months.

### 23.10.3 Commit hygiene

```
   □ One logical change per commit
   □ Compiles at every commit
   □ Never commit commented-out code — archive/ exists  (Rule 1)
   □ Never commit a secret. Ever. In any branch.        🔒
   □ Never commit .env
   □ Never `git push --force` to main
```

### 23.10.4 Pull requests

```markdown
## What
One or two sentences.

## Why
The problem, or the decision this implements.

## How
Approach, and anything non-obvious.

## Changed files
- `path` — what changed and why

## Risks
What could break. What is untested.

## Remaining
What this deliberately does not do.

## Verification
How it was checked.

## Architecture
- [ ] Adds no arrow to the dependency graph (§5.8)
- [ ] ARCH-1..4 unviolated
- [ ] Duplicates no platform system

## Compliance ⚖️
- [ ] No directive language in new copy or prompts
- [ ] New AI output carries a disclaimer
- [ ] New observations carry evidence and a category
```

**"Changed files", "Risks", and "Remaining" come directly from `CLAUDE.md` Rule 3** and are what make incremental work reviewable.

---

## 23.11 Code review

### 23.11.1 What a reviewer checks, in order

```
   1. ARCHITECTURE   Does it add an arrow? Violate ARCH-1..4?
                     Duplicate a platform system?
                     ← thirty seconds; catches most bad designs

   2. ⚖️ COMPLIANCE  Directive language? Missing disclaimer?
                     Fabricated value? Missing evidence?

   3. CORRECTNESS    Money maths. Timezones. Null handling.
                     Transaction boundaries.

   4. SECURITY 🔒    Identity from the token? Endpoint guarded?
                     DTO complete? Secret in a log?

   5. RELIABILITY    Enrichment non-fatal? Blast radius?
                     Background work off the request path?

   6. PERFORMANCE    Network call on a Tier 0 path? Selector too broad?
                     Tick value in a dep array? N+1? Unindexed query?

   7. MAINTAINABILITY  Whole-file rewrite? Deleted code?
                       Comments explain WHY? Vault note needed?

   8. STYLE          Last. Least important. A linter's job (once TD-3 is fixed).
```

### 23.11.2 Review rules

| Rule | |
|---|---|
| **Cite the principle** | *"Violates Principle 8 — this enrichment is awaited without a catch"* is a complete comment |
| **Distinguish blocking from suggestion** | prefix non-blocking comments with `nit:` |
| **Review the diff, not the author** | |
| **Approve with comments** if nothing blocks | do not hold a PR for a preference |
| **A whole-file rewrite is a blocking comment** | Rule 1 — request a targeted edit |
| **A deleted file is a blocking comment** | Rule 1 — request `archive/` |
| **A bug fix without a test is a blocking comment** | once tests exist |

### 23.11.3 Automatic rejections

No discussion needed:

```
   ❌ ARCH-1..4 violated
   ❌ ⚖️ directive trading language
   ❌ a secret committed
   ❌ a deleted file not in archive/          (Rule 1)
   ❌ a whole-file rewrite for a small change (Rule 1)
   ❌ identity read from a request body
   ❌ an unguarded endpoint touching user data
   ❌ an order-placement capability in an AI path
```

---

## 23.12 Tooling debt 🔴

| ID | Gap | Impact |
|---|---|---|
| **TD-3** | **No ESLint config anywhere** | every standard here is enforced by humans |
| TD-11 | No Prettier config | formatting churn in diffs |
| TD-12 | No pre-commit hooks | mistakes reach CI, or main |
| TD-5 | No root `tsconfig.base.json` | compiler settings drift between workspaces |
| TD-13 | No commitlint | commit conventions unenforced |
| TD-14 | No PR template | the checklist above is aspirational |

### 23.12.1 🔵 The remediation, in about a day

```
   1. eslint.config.js (flat) at the root
      + typescript-eslint recommended-type-checked
      + eslint-plugin-react-hooks         ← catches the dep-array class of bug
      + eslint-plugin-import (cycles, ordering)
      + a CUSTOM RULE: no directive trading language in string literals  ⚖️

   2. prettier.config.js
      printWidth 120, singleQuote, trailingComma all

   3. husky + lint-staged: format + lint the staged files

   4. commitlint with the Conventional Commits config

   5. .github/pull_request_template.md — §23.10.4

   6. tsconfig.base.json — extend it from every workspace

   7. Add lint + typecheck to CI as BLOCKING steps
```

> ⚠️ **Item 1's custom rule is the highest-value piece.** ⚖️ A lint rule that fails the build on `"consider selling"` in a string literal is a compliance control that costs nothing per run and never gets tired. It is the cheapest compliance automation available to us.

> ⚠️ **`eslint-plugin-react-hooks` will flag `anchorRef`-style intentional omissions.** Those need explicit `// eslint-disable-next-line react-hooks/exhaustive-deps` with the existing comment kept above it. Do not "fix" them to satisfy the linter — that reintroduces the four-reloads-per-second bug.

---

## 23.13 The standards summary card

```
   TYPESCRIPT     strict · no any · null is information ·
                  discriminated unions · as const

   NAMING         name the units · domain terms win · verb-first functions

   COMMENTS ⭐    WHY not what · document deliberate oddities ·
                  document limitations at the point of implementation

   REACT          narrow selectors · refs for tick values ·
                  cancel effects · { data, status } · config-driven

   BACKEND        thin controllers · identity from the token ·
                  guards at the boundary · transactions for money ·
                  degrade never fail · don't log expected absence

   ⚖️ COMPLIANCE  no directive language, ever, anywhere

   GIT            conventional commits · WHY in the body ·
                  never delete — archive · targeted edits

   REVIEW         architecture → compliance → correctness → security →
                  reliability → performance → maintainability → style
```

---

*Next: [Chapter 24 — Design System](24-design-system.md)*
