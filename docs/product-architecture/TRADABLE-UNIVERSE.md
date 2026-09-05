# Tradable Universe

**Status:** implemented (2026-09-05)
**Owner:** `packages/market-data/src/universe` (contracts + sources) · `services/market-data` (writes) · `services/api` (reads) · `apps/web/src/components/universe` (UI)

The complete, dynamically-discovered catalogue of every instrument TradeW can
quote, across five markets. This document explains what it is, why it is not
part of the `Instrument` table, and the two rules that govern money in it.

---

## 1. What it covers

| Market | Venues | Provider | Quoted in | Paper account settles in |
|---|---|---|---|---|
| `INDIA` | NSE, BSE (+ F&O and currency derivatives, opt-in) | Dhan scrip master | INR | **INR** |
| `USA` | NYSE, NASDAQ, AMEX (NYSE American) | Twelve Data | USD | **USD** |
| `UK` | LSE | Twelve Data | **GBX** (pence), some lines USD/EUR | **USD** |
| `FOREX` | Interbank spot — every pair the vendor lists | Twelve Data | the pair's own quote leg | **USD** |
| `CRYPTO` | Binance spot — every pair, every quote asset | Binance | the pair's quote asset (USDT, USDC, BTC, …) | **USD** |

Nothing is capped at 200, 500 or 1,000 symbols. Each source is asked for its
full published catalogue and paginated through to exhaustion.

---

## 2. Why a new table and not `Instrument`

`Instrument` is the OMS's foreign-key target — `Order`, `Trade`, `Position`,
`Holding` and `Candle` all point at it — and its `symbol` column is **globally
unique**, which is what keeps `findUnique({ where: { symbol } })` working behind
`/market-data/quote-by-symbol`.

A multi-market universe cannot satisfy that constraint:

- `RELIANCE` is listed on **both** NSE and BSE.
- A three-letter ticker means different companies on NYSE and on the LSE.
- `BTC` appears as `BTCUSDT`, `BTCUSDC`, `BTCFDUSD` and `BTCTRY`.

Widening `Instrument.symbol` into a composite key would mean re-keying every
order the platform has ever written. So `UniverseInstrument` is its own table,
keyed by `(market, exchange, symbol)` with a denormalised globally-unique
`ref` (`USA:NASDAQ:AAPL`), carrying **no foreign keys to user data**. It can be
resynced freely without touching a single order.

The existing India-only `ScripMasterService` import is untouched and still
populates `Instrument` for the OMS. The universe is additive.

---

## 3. Currency: two facts, never one

This is the part most likely to be got wrong later, so it is enforced in one
module — `packages/market-data/src/universe/currency-policy.ts` — and pinned by
21 assertions in `currency-policy.spec.ts`.

Every row carries **two** currency columns:

- **`quoteCurrency`** — what the *venue* prices the instrument in.
- **`accountCurrency`** — what the *paper account* settles in.

They differ for the UK (GBX quoted, USD settled), for non-USD forex legs, and
for every crypto pair (a stablecoin is not a dollar). `requiresFxConversion` is
the stored, queryable form of "these two disagree".

### Rule 1 — market prices are never rescaled

A price is stored, transported and displayed in its `quoteCurrency`, exactly as
the provider published it. The LSE quotes ordinary shares in **pence**: VOD
prints around 70, not 0.70. Recording that as GBP would make every UK price a
hundred times too large the moment anything reasoned about it in pounds.
`formatQuotePrice` renders GBX with a `p` suffix and never a `£`.

### Rule 2 — converting is explicit and rate-bearing

`convertToAccountCurrency` throws `FxRateRequiredError` without a real rate.
There is no default rate, no cached-forever rate, and no `1.0` fallback. It
returns the rate it used alongside the number, and it distinguishes "not
converted" (`rate: null`) from "converted at parity" (`rate: 1`). Minor-unit
rescaling (GBX → GBP, ÷100) happens before the FX step, so a rate table never
needs a `GBX/USD` entry that would be 100× the real exchange rate.

Nothing in this subsystem fetches a rate. Rate acquisition belongs to whoever
has a live FX source (`services/api`'s `ForexService`); this module only makes
it impossible to convert without one.

---

## 4. Discovery, pagination and de-duplication

Each source implements `CatalogueSource` and yields **pages** via an async
generator, so the sync writes as pages arrive rather than buffering 200k records.

| Source | Pagination | Notes |
|---|---|---|
| Dhan | one page per exchange segment | two published masters merged — compact has the ticker, detailed has ISIN; neither alone suffices |
| Twelve Data | `page`/`page_size` per (exchange, feed) | tolerates both the paginated and single-body response shapes; stops on a short page, on a page that adds nothing new (an endpoint ignoring `page`), or at `MAX_PAGES` |
| Binance | single `exchangeInfo` request | ~3,000 spot pairs, keyless |

De-duplication happens in `normalise.ts`. Duplicates are real: Twelve Data's
`/stocks` and `/etf` feeds overlap, exchange aliases can be queried twice, and
providers occasionally emit a ticker twice across a data migration. The winner
is chosen by a stated preference order (known status ▸ specific asset class ▸
more identifiers ▸ incumbent) and losers are **counted**, so a jump in
duplicates is visible as a number rather than as silent data loss.

---

## 5. Delisting requires proof

Rows are **never deleted** — charts, backtests and journal entries refer to
instruments years after they stop trading. An instrument that leaves a
provider's catalogue is marked `DELISTED` with a timestamp.

Marking anything delisted requires a run that **completed**, covered a whole
market, and was **not truncated** by `--limit`. Four guards enforce that, and
each one corresponds to a real way an entire market could be wiped:

1. An unconfigured source is `SKIPPED`, never run-and-observed-empty. A missing
   `TWELVEDATA_API_KEY` must not delist every US, UK and FX instrument.
2. A source that dies mid-stream is `PARTIAL`; its pages are kept, its right to
   delist is not.
3. Delisting is scoped by `provider` — a Binance sync says nothing about the LSE.
4. A run that would delist **more than half** of a market refuses and logs an
   error. That is an upstream fault, not a delisting event.

`UniverseSyncRun` records every attempt, so "is the universe fresh?" is
answerable without trusting a log file — a failed run leaves rows untouched and
perfectly fresh-*looking*, so row age alone cannot distinguish "nothing changed"
from "nothing ran".

---

## 6. Reads: how thousands of instruments stay out of the browser

`GET /universe/search` is the only way to reach the catalogue, and it is bounded
by construction:

- **Keyset pagination, not OFFSET.** Pages are addressed by the last row's sort
  key `(market, symbol, ref)`, so page 400 costs what page 1 costs. `ref` is the
  unique tiebreaker that makes the seek total.
- **A hard server-side page ceiling** (`MAX_PAGE_SIZE = 100`). A client cannot
  ask for the whole universe with `limit=999999`.
- **No `COUNT(*)`.** One extra row is fetched to answer "is there more"; a count
  over a trigram search on a 10⁵-row table is a full scan per keystroke.
- **One trigram-indexed search column.** `searchText` holds symbol, name, ISIN
  and pair legs lower-cased, served by a GIN `gin_trgm_ops` index — a leading
  wildcard that a B-tree cannot serve at all.

The UI (`UniverseExplorer`) has **no client-side `.filter()`**: filtering in the
browser would require the data to be in the browser, which is the thing being
avoided. Typing is debounced into server queries; scrolling walks cursors 50
rows at a time via an `IntersectionObserver`; a new search resets the pages
rather than appending, so the DOM stays bounded by how far one person scrolled.

Delisted and inactive rows are excluded by default but reachable on request.
`UNKNOWN` is **included** in the default view — every FX pair carries it, because
the vendor publishes no status for pairs, and excluding it would empty the
market.

---

## 7. Running it

```bash
# preview without writing
npm run universe:sync -w @tradew/market-data-service -- --dry

# build the whole catalogue
npm run universe:sync -w @tradew/market-data-service

# one market, capped, for a smoke run (marked truncated; cannot delist)
npm run universe:sync -w @tradew/market-data-service -- --markets=CRYPTO --limit=500

# a full run that also retires what the providers dropped
npm run universe:sync -w @tradew/market-data-service -- --delist-missing
```

Unattended refresh is off by default; see `UNIVERSE_REFRESH_*` in `.env.example`.

---

## 8. Known limits

- **Quotes are not wired to the universe yet.** This ships the catalogue —
  identity, addressing, currency and lifecycle. Every row carries the
  `provider`/`providerSymbol` (and Dhan's `securityId`/`exchangeSegment`) needed
  to fetch a price, but routing a universe row to its quote source is separate
  work.
- **Paper trading is not extended to the new markets.** The INR `PaperWallet`
  and USD `CryptoWallet` are unchanged. This defines what each market settles in
  and refuses to convert without a rate; it does not open an order path for US,
  UK or FX instruments.
- **The catalogue sources were implemented against documented response shapes,
  not verified live** — the build environment has no egress to
  `images.dhan.co`, `api.twelvedata.com` or `api.binance.com`. Parsing is
  defensive (both header vocabularies, both response envelopes, missing-field
  rejection counted rather than swallowed) and every adapter is fixture-tested,
  but the first real run should be `--dry` and its rejection counts read.
- **UK asset-class depth is what Twelve Data publishes.** LSE investment trusts
  and depositary receipts map from the vendor's `type` vocabulary; anything
  unrecognised is filed as the feed's own class rather than guessed.
