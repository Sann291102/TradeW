---
type: pattern
date: 2026-07-21
tags: [pattern, market-data, dhan, ingestion, architecture]
status: implemented
---

# Market Data Phase 1 — ingestion runtime, pure reads, one simulator

## For future Claude
The market-data read path **inverted** on this date. If you are about to add a
provider or an endpoint, read this first.

- `services/api` **never generates market data.** It reads persisted `Quote`
  rows and nothing else. If you find yourself computing a price in a request
  handler, you are undoing this work.
- `services/market-data` is the **sole writer** of `Quote` and of the broker
  columns on `Instrument`. It is a **singleton** — do not scale it.
- There is exactly **one** simulator, in `packages/market-data`. Both previous
  copies are in `archive/`.

## Why the inversion was forced, not chosen
Dhan caps market-quote REST at **1 request/second account-wide**. The old
`MarketDataService.enrich()` ran the simulator and wrote `Quote` on *every GET*,
so one 5-index dashboard load would have blown that budget five times over. No
amount of caching fixes a read that generates data; the direction had to change.

Consequence worth internalising: with pure reads, **something must write
continuously or the dashboard freezes**. That is why the simulated feed exists
as a `MarketFeed` and runs through the same pipeline as Dhan will. The simulator
is not a stub — it is the dev/CI/fallback source.

## Why services/market-data is a separate deployable
The broker feed connection set is a *per-account* resource: Dhan allows 5
WebSocket connections per user and evicts the oldest with code `805` on a sixth.
An API scaled to N replicas would open N connection sets that evict each other.
One ingestor writes; the API stays stateless and scales freely.

## Scrip master: four things the docs do not tell you
Discovered by running against the real 36 MiB file. Each one changed the design.

1. **Both published masters are needed.** Detailed has ISIN but **no ticker
   column at all** (`SYMBOL_NAME` is the company name). Compact has
   `SEM_TRADING_SYMBOL`. Merge on `(exchangeSegment, securityId)`.
2. **NSE_EQ is mostly not equities** — 9,620 rows, ~4,300 SDL government bonds,
   only ~2,400 shares. All series → **417 symbol collisions**; `EQ`+`BE` → **1**.
3. **`"NA"` is the null placeholder**, a literal string. Treating it as a value
   silently dropped every index.
4. **The placeholder differs between files** — indices are `SERIES=NA` in
   detailed, `SERIES=X` in compact. So series filtering is scoped to cash
   segments, not made dependent on placeholder strings.

Mapping sanity check: `RELIANCE`=2885, `TCS`=11536, `HDFCBANK`=1333 — the same
ids Dhan uses in its own API examples.

## Constraint that shapes future work
`Instrument.symbol` is **globally unique** and must stay that way —
`findUnique({ where: { symbol } })` backs `/market-data/quote-by-symbol`. That is
why the importer runs against a segment + series allowlist. Enabling BSE or F&O
requires deciding a symbol-uniqueness policy *first*; the importer reports
collisions and refuses them rather than overwriting.

## Gotchas hit
- **`nest build` emitted `dist/src/main.js`** instead of `dist/main.js` because
  `tsconfig.json` had no `exclude`, so it compiled `scripts/` too and shifted the
  inferred `rootDir`. Broke `start:prod`. Every service tsconfig that gains a
  `scripts/` folder needs `"exclude": ["scripts", ...]`.
- **Shared packages must build to `dist`.** `main: src/index.ts` works for
  ts-node but a compiled service cannot resolve the TS source's extensionless
  imports at runtime. Repo convention is `main: dist/index.js` + a build step —
  match `@tradew/types` and `@tradew/ai-core`.
- **Flushes overlap.** Writing ~3,000 rows sequentially takes longer than a 2s
  interval, so the next flush joins the previous one and database concurrency
  climbs exactly when it is already struggling. Needs a re-entrancy guard plus
  bounded-concurrency writes.
- **`prisma generate` EPERM on Windows** whenever any `services/api` process is
  running — the compiled `dist/main` holds `query_engine-windows.dll.node`, and
  killing only the `nest --watch` parent is not enough. Find the holder by port
  or by module handle. See [[../Decisions/2026-07-21 - Sentinel Concept Knowledge Graph (living ontology)]].

## State
Implemented and verified end-to-end: 2,933 instruments imported (idempotent
re-run writes nothing), ingestor writes 2,933 quote rows with 0 unresolved and
0 errors, 15 API reads left `Quote.updatedAt` byte-identical, Sentinel boots on
the shared provider.

**Not built:** live Dhan WebSocket transport, Dhan REST provider, `Candle`
(Migration 2), option chain, Redis cache, WebSocket push to clients.

## Related
- [[../_INDEX.md]]
- `docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md` — the plan and §11's data findings
- `docs/product-architecture/MARKET-DATA-BASELINE.md` — what this superseded
- [[2026-07-18 - Market Data Migration 1 executed (Quote revision, baseline established)]]
- [[../Decisions/2026-07-18 - Market Data domain architecture review]]
