# Admin portal (`/admin`)

The operator console. A second UI over the same platform, visible only to people
you name — not linked from the website, not in the sidebar, not in the command
palette, not in the sitemap.

## Running it for the first time

Two commands on your machine, then two credentials.

```bash
# 1. Install (services/api gained a dependency on @tradew/ai-core) and
#    regenerate the Prisma client for the new telemetry models.
npm install
npm run db:generate

# 2. Apply the migration that adds User.isAdmin and the four telemetry tables.
npm run db:migrate
```

Then set the operator secret in `.env` and grant yourself access:

```bash
# .env — a long random string. Unset means the admin API is disabled entirely.
ADMIN_API_TOKEN=<64 random chars>
```

```bash
npm run admin:grant -w @tradew/database -- you@example.com
npm run admin:grant -w @tradew/database -- --list      # who has access
npm run admin:grant -w @tradew/database -- you@example.com --revoke
```

Sign in to TradeW normally, go to `/admin`, and enter the operator token when
the gate asks.

## Two factors, both required

| Factor | What it is | Where it lives |
| --- | --- | --- |
| Account privilege | `User.isAdmin`, checked **against the database on every request** — never from a JWT claim, so revoking access takes effect immediately rather than whenever the token expires | Postgres |
| Operator secret | `ADMIN_API_TOKEN`, compared in constant time | `.env` on the server; `sessionStorage` in the browser |

Neither alone is enough. A stolen session cannot reach the console without the
operator token; a leaked operator token is useless without an account that has
`isAdmin`. The token is held in `sessionStorage`, so it dies with the tab and is
never sent automatically by the browser.

The client-side gate in `AdminFrame` is a **convenience, not a boundary**. Every
`/admin/*` endpoint enforces both factors independently. Someone who bypasses
the gate reaches a shell that can fetch nothing.

Every denial is written to the security log — this surface will be probed, and
the probing is the signal.

## What it shows

| Section | Answers |
| --- | --- |
| **Overview** | Is anything wrong right now? Traffic, error rate, AI spend, order flow, user count |
| **Orders & OMS** | Every order and fill, rejection reasons, and orders stuck in `PENDING` — a stalled OMS worker is invisible from every trader-facing screen |
| **AI & Sentinel** | The live agent orbit, per-agent spend and latency, orchestrator runs, and every raw LLM call |
| **Perceptors & Neural** | What the platform senses across all five domains, where in the four layers the signal stops, what repeated outcomes have taught it, and what it wants a human to decide |
| **Knowledge** | The engineering vault graph, moved here from the public site, plus live vault writes |
| **Users & System** | Accounts, the auth audit trail, route latency, request log, service health |

## Perceptors & Neural Networks

The four-layer cognition network — see
`knowledge/Decisions/2026-08-12 - Cognition network (perceptors + four layers).md`
for the architecture and `packages/ai-core/src/cognition/` for the code.

**Off by default.** `COGNITION_ENABLED=true` starts the loop; without it the
sensors are still registered and the page still renders the roster. That is
deliberate — a page that shows nothing when a feature is off cannot tell an
operator whether the feature is off or broken, so the distinction is stated in
words at the top of the page rather than left to be inferred from empty tables.

| Env var | Default | What it does |
| --- | --- | --- |
| `COGNITION_ENABLED` | *(unset)* | `true` starts the pass loop |
| `COGNITION_PASS_MS` | `300000` | How often a full pass runs |
| `COGNITION_FLUSH_MS` | `30000` | How often dirty weights are written back |
| `COGNITION_SALIENCE_FLOOR` | `0.15` | L1's attention budget |
| `COGNITION_RETENTION_DAYS` | `30` | Percept/episode pruning. **Never applies to weights** |

Three numbers on this page are worth knowing how to read, because each of them
looks fine when it is not:

- **Unproven weights.** A weight no outcome has ever scored is a *guess*. It is
  rendered dimmed and labelled, never as a finding. `proven = 0` with a large
  total means the network is associating and nothing is ever being scored.
- **Awaiting an outcome.** Eligibility traces with no result yet. A number that
  only grows means the feedback loop has stalled, which stops all learning
  without producing a single error or failed request.
- **Gated.** Percepts dropped below the salience floor. Always zero means the
  floor is too low to be doing anything, and the layers below it are being fed
  noise.

**Resolving a proposal is a write to the model, not just to a row.** "Wrong"
(`dismissed`) is the only negative training signal the network ever receives —
every other input it gets is "something happened". It reinforces the specific
chain of activations that produced the proposal, while the traces are still
live. Clicking it casually degrades the weights; not clicking it at all means
they only ever move in one direction.

## The Sentinel orbit

The orchestrator is a glowing core; every agent under it orbits on a tilted 3D
ring, connected by a line. Each agent's live state is an orb:

- **thinking** — fast teal pulse with an expanding halo
- **sending / receiving** — bright cyan, with a packet travelling along the
  connector in the direction the data is moving
- **error** — red alarm pulse
- **idle** — dim, slow breath

State comes from two sources because neither is sufficient alone. A **poll**
(`/admin/agents/states`) establishes the roster including agents that have never
emitted an event — an agent quietly not running is a bug, and a view built only
from observed events would hide it rather than show it as silent. An **SSE
stream** (`/admin/stream`) drives the moment-to-moment animation at event
latency.

Live states **decay to idle after 6 seconds** unless refreshed. A transition is
a point in time, not a condition; without decay an agent that thought once would
appear to think forever and the display would quietly become fiction.

All 3D is CSS `transform` + `perspective` — no three.js, no new dependency,
nothing animating a layout property. Everything stops under
`prefers-reduced-motion`; orbital rotation and pulsing glow are established
migraine and vestibular triggers, and this is a page you may leave open all day.

## How the telemetry gets recorded

Nothing was being logged before this. Three collection points, all
instrumented at a **chokepoint** rather than at call sites — partial coverage of
an observability surface is worse than none, because you have no way to know
what was left out:

1. **`ApiCallInterceptor`** — registered globally via `APP_INTERCEPTOR`, so
   routes added later are covered automatically. Logs the route *template*
   (`/market-data/quote/:symbol`), never the raw URL, and drops query strings.
2. **`instrumentLlmProvider`** — applied inside `ProviderManager.registerLlm`,
   so any provider reachable through the manager is instrumented by
   construction. Records model, tokens, latency and estimated cost.
3. **`runAgentRun` / `trackAgent`** — in the Sentinel orchestrator. Uses
   `AsyncLocalStorage` so a correlation id propagates to every nested agent and
   LLM call without changing a single business signature.

`TelemetryService` buffers all of it and flushes to Postgres every 2 seconds.
Writes are fire-and-forget with capped, oldest-first-discarding buffers: a
telemetry failure degrades this console, it never degrades the platform, and a
database outage cannot turn into an out-of-memory in the trading API.

Cost figures are an **estimate** from a local rate card in
`packages/ai-core/src/telemetry/instrument.ts`, labelled as such everywhere they
appear. They exist to show that one agent is burning 40× what the others do — a
question provider billing answers accurately but a month late and without
per-agent attribution.

## Knowledge moved here

`/knowledge` was removed from the public app entirely (route, nav item, command
palette entry). It was never trader-facing: it renders the *engineering* vault —
architecture decisions, gotchas, agent research notes — and exposing it put
internal reasoning in front of every signed-in user. It now lives at
`/admin/knowledge`, with a live-writes rail added, because the operational
question is "are the agents still writing to the vault".

## There is a second, unfinished admin app — do not add to it

`apps/admin` (`npm run dev:admin`) is a separate Next.js console with eight
routes: Engine Health, Knowledge Management, Agent Management, Reasoning
Inspector, TradingView Rule Management, Learning Platform, Observability, and
Audit & Compliance.

**All eight are five-line `ModulePlaceholder` stubs.** Its own README still says
"Status: design-only". It has a login page, a session cookie and a middleware,
and no page that renders data.

This console — the one you are reading about — is the real one, and it reaches
the same `/admin/*` API. The two overlap almost completely in intent: `apps/admin`
Engine Health / Agent Management / Reasoning Inspector are **AI & Sentinel**;
Observability is **Overview** plus **Users & System**; Audit & Compliance is the
audit trail in **Users & System**; Knowledge Management is **Knowledge**.

Finishing `apps/admin` would mean rebuilding the gate, the API client and the
chart primitives that already exist here, and then maintaining two operator
surfaces with two auth models over one API. That is a decision for the owner,
not something to drift into — so nothing was added to it. The realistic choices
are to archive it under `TradeW/archive/` per Rule 1, or to keep it and move
this console's sections across wholesale. Until then, new operator UI goes here.

## Adding a section

1. `apps/web/src/app/admin/<name>/page.tsx`
2. Add it to `SECTIONS` in `AdminFrame.tsx`
3. Reads go in `AdminService`; the class-level `@UseGuards(AdminGuard)` covers
   any route you add to `AdminController`. Do not put a guard on an individual
   handler — the class-level placement is what makes forgetting one impossible.
