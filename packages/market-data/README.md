# packages/market-data 🟢

`@tradew/market-data` — the shared **market-data engine**: one place for provider/feed contracts, the single simulated market, the Dhan adapter (including the hand-written WebSocket binary parser), and the ingestion primitives.

Exists to resolve the duplicate-simulator debt in [`docs/product-architecture/MARKET-DATA-BASELINE.md`](../../docs/product-architecture/MARKET-DATA-BASELINE.md) §7 without duplicating business logic across three services, per [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §6 (shared libraries live in `packages/`, runtimes in `services/`). Pure TypeScript library — consumed by its built `dist/` entrypoint.

Consumed by:
- **`services/market-data`** — the ingestion runtime (writes) + the standalone live Dhan feed bridge scripts
- **`services/api`** — pure reads
- **`services/sentinel`** — pull-side provider for signal computation

## Structure (`src/`)

| Path | Purpose |
|---|---|
| `contracts/` | Provider/feed abstractions — `feed.ts`, `cache.ts`, `tick.ts`, `instrument-ref.ts` |
| `providers/dhan/` | Dhan adapter — `dhan-binary-parser.ts` (hand-written WebSocket binary frame parser), `dhan-scrip-master.ts`, `dhan.feed.ts` |
| `providers/simulated/` | The single simulated market — Ornstein-Uhlenbeck engine (`ou-engine.ts`), provider + feed |
| `providers/binance/` | Binance — crypto only, public/keyless, read-only (no secret, no persistent subscription set) |
| `providers/twelvedata/` | TwelveData adapter |
| `cache/` | `in-memory-quote-cache.ts` |
| `rate-limit/` | `token-bucket.ts` |
| `registry.ts` | Provider registry / selection |

## The Dhan binary parser

`providers/dhan/dhan-binary-parser.ts` decodes Dhan's live WebSocket binary frames into ticks by hand. It is verified by `scripts/verify-parser.ts` (`npm run verify`), which doubled as the repo's earliest real test-like artifact. See the [Dhan token architecture](../../docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md) for how the 24h feed token is minted.

## Build / test

```bash
npm run build     -w @tradew/market-data   # tsc → dist/
npm run typecheck -w @tradew/market-data
npm run verify    -w @tradew/market-data   # runs scripts/verify-parser.ts (aliased as `test`)
```
