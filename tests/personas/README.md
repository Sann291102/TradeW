# Virtual customers

Scripted personas that use the **real** TradeW app in a real browser and write
down what a customer would run into. Claude reads the output and works from it.

They are not mocks: they sign up through the real form, click the real buttons
and read the real screens, against the real API and a real (isolated) database.

## What they are, honestly

- **Scripted journeys with explicit expectations**, plus an observer that records
  everything any customer would notice: console errors, failed requests, 4xx/5xx,
  slow responses, error banners, disabled buttons and dead ends.
- The "review" is **rule-based**. There is no LLM judging the screens. A
  model-driven exploratory persona can be added once an Anthropic key is
  configured; until then the reviewer is Claude reading `report.md` and the
  screenshots.
- Each step ends in one of four states, and the difference matters:

| | meaning |
|---|---|
| ✅ pass | ran, and what the customer would expect happened |
| 🟠 finding | ran, and something is wrong — a product problem to act on |
| ⚪ blocked | could **not** run because the environment lacks something (no live market feed). Not a pass, not a bug |
| ⏭️ not reached | an earlier critical step (e.g. sign-up) failed |

## The personas

| name | who | covers |
|---|---|---|
| `new-trader` | Asha, first-time retail trader | sign-up, dashboard honesty, trade screen, first order, Orders, Trade History |
| `options-trader` | Ravi, weekly-expiry options | option chain does not invent numbers, positions, order-history columns |
| `housekeeping` | Meera, wants a clean slate | Settings → Trading, **reset balance to ₹10,00,000** (cancel path and confirm path) |
| `agent-watcher` | Priya, an agent trades for her | **Agent badge**, Entry / Exit · Square-off, Closed by, Charges (agent round-trip is *seeded*) |

## Running them

They only ever run against a **local** app (the runner refuses anything else),
and against an **isolated** database — never the shared dev DB: they create
accounts, press Reset, and seed rows.

```bash
# 1. isolated database (once)
docker run -d --name tradew-personas-pg -p 127.0.0.1:5435:5432 \
  -e POSTGRES_USER=tradew -e POSTGRES_PASSWORD=<local-only> -e POSTGRES_DB=tradew_personas \
  pgvector/pgvector:pg16
# root .env: DATABASE_URL on :5435, fresh JWT_SECRET etc., API_PORT=4100,
#            PAPER_EXECUTION_ENABLED=false, SQUARE_OFF_SWEEP_ENABLED=false
# apps/web/.env.local: NEXT_PUBLIC_API_URL=http://localhost:4100  API_PROXY_TARGET=http://127.0.0.1:4100
cd packages/database && npx prisma migrate deploy --schema prisma/schema.prisma && npx ts-node prisma/seed.ts

# 2. the app on ports 4100 / 3100 (see .claude/launch.json: personas-api, personas-web)

# 3. run
cd tests/personas
npm install                # playwright-core only; uses the installed Chrome
node src/run.mjs           # all personas
node src/run.mjs housekeeping
PERSONA_HEADED=1 node src/run.mjs new-trader   # watch it
```

Ports 4100/3100 are deliberate: 4000/3000 may be a developer's own stack.

## Output (gitignored, in `out/`)

- `out/latest/report.md` — read this first.
- `out/latest/findings.json` — every finding and every step, machine-readable.
- `out/latest/screenshots/` — one per step.
- `out/<run-id>/accounts.json` — the generated test accounts (never printed).

Each finding has a **stable id** (hash of persona, route, kind and normalised
message), so runs compare day to day: new / still open / fixed. Every run is
stamped with the IST clock and market session, because what is correct at 11:00
is not what is correct at 15:20.

## For Claude

1. Run the personas, read `out/latest/report.md`.
2. Fix **S1** first, then S2. S3 is polish.
3. **Blocked** steps are not bugs — say what they need (a market feed) instead of guessing.
4. Re-run; the report says which ids are fixed and which are new.

## Known limits

- Anything needing live prices (placing an order, the option chain) is
  **blocked** until the Dhan market-data bridge is running (needs Dhan credentials).
- The agent loop is not run; its orders are seeded, and the report says so.
- First visit to each route is slow on the Next dev server; routes are warmed
  first so that is not reported as a slow page.
- The dev API restarts when its sources change; the runner waits for it between
  personas, but a restart *during* a persona can still surface as a blocked step.
