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
| **Knowledge** | The engineering vault graph, moved here from the public site, plus live vault writes |
| **Users & System** | Accounts, the auth audit trail, route latency, request log, service health |

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

## Adding a section

1. `apps/web/src/app/admin/<name>/page.tsx`
2. Add it to `SECTIONS` in `AdminFrame.tsx`
3. Reads go in `AdminService`; the class-level `@UseGuards(AdminGuard)` covers
   any route you add to `AdminController`. Do not put a guard on an individual
   handler — the class-level placement is what makes forgetting one impossible.
