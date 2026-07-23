# Learning Hub — Full Topic Taxonomy

The complete intended topic set, and the honest status of each.

- `✓` — the lesson file exists and is written
- `·` — planned, not yet authored

This table is maintained by hand and is the build checklist for the remaining
content. A topic marked `✓` with no file on disk is a bug in this table.

## 1. Foundations

| # | Topic | File | Status |
|---|---|---|---|
| 1.1 | What a derivative is | `foundations/what-is-a-derivative.md` | · |
| 1.2 | Futures contract mechanics | `foundations/futures-mechanics.md` | · |
| 1.3 | What an option is | `foundations/what-is-an-option.md` | · |
| 1.4 | Calls and puts, buyer and seller | `foundations/calls-and-puts.md` | · |
| 1.5 | Moneyness — ITM, ATM, OTM | `foundations/moneyness.md` | · |
| 1.6 | Intrinsic and extrinsic value | `foundations/intrinsic-and-extrinsic-value.md` | · |
| 1.7 | Payoff diagrams, and how to read one | `foundations/payoff-diagrams.md` | · |
| 1.8 | Open interest and volume | `foundations/open-interest-and-volume.md` | · |
| 1.9 | The option chain | `foundations/option-chain.md` | · |
| 1.10 | Assignment and exercise | `foundations/assignment-and-exercise.md` | · |

## 2. India market structure

| # | Topic | File | Status |
|---|---|---|---|
| 2.1 | NSE and BSE expiry architecture | `india-market-structure/expiry-architecture.md` | ✓ |
| 2.2 | SEBI's index derivatives framework | `india-market-structure/sebi-derivatives-framework.md` | ✓ |
| 2.3 | Contract value and why lot sizes change | `india-market-structure/contract-value-and-lot-size.md` | ✓ |
| 2.4 | Transaction costs — STT, stamp, exchange, GST | `india-market-structure/transaction-costs.md` | ✓ |
| 2.5 | Physical settlement of stock F&O | `india-market-structure/physical-settlement.md` | ✓ |
| 2.6 | Margins — SPAN, exposure, ELM | `india-market-structure/margins.md` | · |
| 2.7 | Position limits and monitoring | `india-market-structure/position-limits.md` | · |
| 2.8 | Weekly versus monthly contract behaviour | `india-market-structure/weekly-vs-monthly.md` | · |
| 2.9 | Circuit limits and trading halts | `india-market-structure/circuit-limits.md` | · |
| 2.10 | The NSE trading session | `india-market-structure/trading-session.md` | · |

## 3. The Greeks

| # | Topic | File | Status |
|---|---|---|---|
| 3.1 | Delta | `greeks/delta.md` | · |
| 3.2 | Gamma | `greeks/gamma.md` | · |
| 3.3 | Theta | `greeks/theta.md` | · |
| 3.4 | Vega | `greeks/vega.md` | · |
| 3.5 | Rho | `greeks/rho.md` | · |
| 3.6 | Second-order — vanna, charm, vomma | `greeks/second-order.md` | · |
| 3.7 | Position greeks and aggregation | `greeks/position-greeks.md` | · |
| 3.8 | Delta hedging | `greeks/delta-hedging.md` | · |

## 4. Volatility

| # | Topic | File | Status |
|---|---|---|---|
| 4.1 | Historical versus implied volatility | `volatility/historical-vs-implied.md` | · |
| 4.2 | IV rank and IV percentile | `volatility/iv-rank-and-percentile.md` | · |
| 4.3 | Volatility smile and skew | `volatility/smile-and-skew.md` | · |
| 4.4 | Term structure | `volatility/term-structure.md` | · |
| 4.5 | India VIX | `volatility/india-vix.md` | · |
| 4.6 | Volatility crush around events | `volatility/volatility-crush.md` | · |
| 4.7 | Black–Scholes, and what it assumes | `volatility/black-scholes.md` | · |
| 4.8 | Binomial pricing | `volatility/binomial-model.md` | · |
| 4.9 | Put–call parity | `volatility/put-call-parity.md` | · |

## 5. Strategies

The core of this folder. Every written file carries `legs` frontmatter, so
every one is Apply-able once the Phase 2 feature lands.

### 5a. Directional / single-leg

| # | Strategy | File | Status |
|---|---|---|---|
| 5.1 | Long Call | `strategies/directional/long-call.md` | ✓ |
| 5.2 | Long Put | `strategies/directional/long-put.md` | ✓ |
| 5.3 | Short Call | `strategies/directional/short-call.md` | ✓ |
| 5.4 | Short Put | `strategies/directional/short-put.md` | ✓ |
| 5.5 | Covered Call | `strategies/directional/covered-call.md` | · |
| 5.6 | Protective Put | `strategies/directional/protective-put.md` | · |
| 5.7 | Collar | `strategies/directional/collar.md` | · |
| 5.8 | Cash-Secured Put | `strategies/directional/cash-secured-put.md` | · |

### 5b. Vertical spreads

| # | Strategy | File | Status |
|---|---|---|---|
| 5.9 | Bull Call Spread | `strategies/vertical-spreads/bull-call-spread.md` | ✓ |
| 5.10 | Bear Put Spread | `strategies/vertical-spreads/bear-put-spread.md` | ✓ |
| 5.11 | Bull Put Spread | `strategies/vertical-spreads/bull-put-spread.md` | ✓ |
| 5.12 | Bear Call Spread | `strategies/vertical-spreads/bear-call-spread.md` | ✓ |

### 5c. Volatility structures

| # | Strategy | File | Status |
|---|---|---|---|
| 5.13 | Long Straddle | `strategies/volatility/long-straddle.md` | ✓ |
| 5.14 | Short Straddle | `strategies/volatility/short-straddle.md` | ✓ |
| 5.15 | Long Strangle | `strategies/volatility/long-strangle.md` | ✓ |
| 5.16 | Short Strangle | `strategies/volatility/short-strangle.md` | ✓ |
| 5.17 | Iron Condor | `strategies/volatility/iron-condor.md` | ✓ |
| 5.18 | Iron Butterfly | `strategies/volatility/iron-butterfly.md` | ✓ |
| 5.19 | Long Call Butterfly | `strategies/volatility/long-call-butterfly.md` | · |
| 5.20 | Long Put Butterfly | `strategies/volatility/long-put-butterfly.md` | · |
| 5.21 | Short Butterfly | `strategies/volatility/short-butterfly.md` | · |
| 5.22 | Broken Wing Butterfly | `strategies/volatility/broken-wing-butterfly.md` | · |
| 5.23 | Call Condor | `strategies/volatility/call-condor.md` | · |
| 5.24 | Put Condor | `strategies/volatility/put-condor.md` | · |
| 5.25 | Guts | `strategies/volatility/guts.md` | · |

### 5d. Ratio and backspread

| # | Strategy | File | Status |
|---|---|---|---|
| 5.26 | Call Ratio Spread | `strategies/ratio-and-backspread/call-ratio-spread.md` | · |
| 5.27 | Put Ratio Spread | `strategies/ratio-and-backspread/put-ratio-spread.md` | · |
| 5.28 | Call Ratio Backspread | `strategies/ratio-and-backspread/call-ratio-backspread.md` | · |
| 5.29 | Put Ratio Backspread | `strategies/ratio-and-backspread/put-ratio-backspread.md` | · |
| 5.30 | Jade Lizard | `strategies/ratio-and-backspread/jade-lizard.md` | · |
| 5.31 | Big Lizard | `strategies/ratio-and-backspread/big-lizard.md` | · |
| 5.32 | Call Ladder | `strategies/ratio-and-backspread/call-ladder.md` | · |
| 5.33 | Put Ladder | `strategies/ratio-and-backspread/put-ladder.md` | · |
| 5.34 | ZEBRA | `strategies/ratio-and-backspread/zebra.md` | · |

### 5e. Time spreads

| # | Strategy | File | Status |
|---|---|---|---|
| 5.35 | Calendar Spread | `strategies/time-spreads/calendar-spread.md` | · |
| 5.36 | Diagonal Spread | `strategies/time-spreads/diagonal-spread.md` | · |
| 5.37 | Double Calendar | `strategies/time-spreads/double-calendar.md` | · |
| 5.38 | Double Diagonal | `strategies/time-spreads/double-diagonal.md` | · |
| 5.39 | Poor Man's Covered Call | `strategies/time-spreads/poor-mans-covered-call.md` | · |

### 5f. Synthetic and arbitrage

| # | Strategy | File | Status |
|---|---|---|---|
| 5.40 | Synthetic Long Stock | `strategies/synthetic-and-arbitrage/synthetic-long.md` | · |
| 5.41 | Synthetic Short Stock | `strategies/synthetic-and-arbitrage/synthetic-short.md` | · |
| 5.42 | Conversion and Reversal | `strategies/synthetic-and-arbitrage/conversion-reversal.md` | · |
| 5.43 | Box Spread | `strategies/synthetic-and-arbitrage/box-spread.md` | · |
| 5.44 | Jelly Roll | `strategies/synthetic-and-arbitrage/jelly-roll.md` | · |
| 5.45 | Strap and Strip | `strategies/synthetic-and-arbitrage/strap-and-strip.md` | · |
| 5.46 | Christmas Tree | `strategies/synthetic-and-arbitrage/christmas-tree.md` | · |

## 6. Equity and technical analysis

| # | Topic | File | Status |
|---|---|---|---|
| 6.1 | Market structure — trend, range, transition | `equity/market-structure.md` | · |
| 6.2 | Support and resistance | `equity/support-and-resistance.md` | · |
| 6.3 | Candlestick anatomy | `equity/candlestick-anatomy.md` | · |
| 6.4 | Classical chart patterns | `equity/chart-patterns.md` | · |
| 6.5 | Moving averages | `equity/moving-averages.md` | · |
| 6.6 | RSI | `equity/rsi.md` | · |
| 6.7 | MACD | `equity/macd.md` | · |
| 6.8 | Bollinger Bands | `equity/bollinger-bands.md` | · |
| 6.9 | ATR | `equity/atr.md` | · |
| 6.10 | VWAP | `equity/vwap.md` | · |
| 6.11 | Supertrend | `equity/supertrend.md` | · |
| 6.12 | ADX | `equity/adx.md` | · |
| 6.13 | Volume analysis | `equity/volume-analysis.md` | · |
| 6.14 | Market profile and auction theory | `equity/market-profile.md` | · |
| 6.15 | Order flow | `equity/order-flow.md` | · |
| 6.16 | Gap behaviour | `equity/gaps.md` | · |

## 7. Fundamentals

| # | Topic | File | Status |
|---|---|---|---|
| 7.1 | Reading a P&L statement | `fundamentals/income-statement.md` | · |
| 7.2 | Reading a balance sheet | `fundamentals/balance-sheet.md` | · |
| 7.3 | Cash flow | `fundamentals/cash-flow.md` | · |
| 7.4 | Valuation multiples | `fundamentals/valuation-multiples.md` | · |
| 7.5 | ROE, ROCE and DuPont | `fundamentals/return-ratios.md` | · |
| 7.6 | Discounted cash flow | `fundamentals/dcf.md` | · |
| 7.7 | Sector rotation | `fundamentals/sector-rotation.md` | · |
| 7.8 | Corporate actions and F&O adjustment | `fundamentals/corporate-actions.md` | · |

## 8. Risk management

| # | Topic | File | Status |
|---|---|---|---|
| 8.1 | Position sizing | `risk/position-sizing.md` | · |
| 8.2 | R-multiples and expectancy | `risk/expectancy.md` | · |
| 8.3 | Drawdown and recovery arithmetic | `risk/drawdown.md` | · |
| 8.4 | Risk of ruin | `risk/risk-of-ruin.md` | · |
| 8.5 | Stop placement methods | `risk/stop-placement.md` | · |
| 8.6 | Correlation and concentration | `risk/correlation.md` | · |
| 8.7 | Leverage and margin calls | `risk/leverage.md` | · |
| 8.8 | Tail risk and gap risk | `risk/tail-risk.md` | · |

## 9. Psychology

| # | Topic | File | Status |
|---|---|---|---|
| 9.1 | Loss aversion | `psychology/loss-aversion.md` | · |
| 9.2 | Revenge trading | `psychology/revenge-trading.md` | · |
| 9.3 | Overtrading | `psychology/overtrading.md` | · |
| 9.4 | Confirmation bias | `psychology/confirmation-bias.md` | · |
| 9.5 | FOMO | `psychology/fomo.md` | · |
| 9.6 | Recency bias | `psychology/recency-bias.md` | · |
| 9.7 | Disposition effect | `psychology/disposition-effect.md` | · |
| 9.8 | Process versus outcome | `psychology/process-vs-outcome.md` | · |

## Coverage summary

| Section | Planned | Written |
|---|---|---|
| 1. Foundations | 10 | 0 |
| 2. India market structure | 10 | 5 |
| 3. Greeks | 8 | 0 |
| 4. Volatility | 9 | 0 |
| 5. Strategies | 46 | 14 |
| 6. Equity / TA | 16 | 0 |
| 7. Fundamentals | 8 | 0 |
| 8. Risk | 8 | 0 |
| 9. Psychology | 8 | 0 |
| **Total** | **123** | **19** |

## Notes on the remaining work

**Cross-references point forward.** Written lessons link to planned files that
do not exist yet — for example `greeks/gamma.md` and `risk/expectancy.md` are
referenced from several strategy lessons. Those links are dead until the target
is authored. This is deliberate: the reference marks where the explanation
belongs, in the same spirit as an unresolved `[[wikilink]]` in `knowledge/`.

**Sections 6, 7 and 9 have existing backing concepts.** `knowledge-base/`
already holds validated YAML for technical analysis, company fundamentals,
trading psychology, volume and sentiment. Those lessons are largely a matter of
expanding an existing validated concept into lesson prose rather than
researching new ground, so they should go faster than sections 3–5 did.

**Section 5 is the priority**, since strategy lessons are what the Learning
UI's Apply button consumes. The 14 written cover the structures that most
retail activity concentrates in; the remaining 32 are progressively more
specialised.
