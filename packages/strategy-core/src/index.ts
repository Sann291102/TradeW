/**
 * `@tradew/strategy-core` — the ONE decision framework.
 *
 * ## Why this package exists
 *
 * Before it, this repository had two unrelated strategy implementations: the
 * live path evaluated declarative setups inside `services/sentinel`, and the
 * backtester walked a hardcoded EMA-cross rule inside
 * `services/sentinel/src/backtest`. Two implementations cannot be compared,
 * and a backtest of a strategy the live engine does not run is a measurement
 * of nothing.
 *
 * So the decision framework lives here, in a package with no Nest, no I/O and
 * no venue knowledge, and every caller imports the same functions:
 *
 *     Market Data  →  Feature Core  →  Setup Engine  →  Level Deriver
 *                                                            ↓
 *                                                  Decision + 1:3 Filter
 *                                                     ↓            ↓
 *                                                 Backtest    Paper/Live
 *
 * Only the data source and the execution environment differ between those two
 * branches. Everything above the fork is this package.
 *
 * ## The rule that keeps it honest
 *
 * Nothing here may import from `services/*`. A dependency in that direction
 * would put strategy logic back inside a service and re-open the split this
 * package closed — and it would also make the autonomous engine depend on
 * Sentinel again, which is an architectural requirement, not a preference.
 */

export * from './indicators';
export * from './market-structure';
export * from './snapshot';
export * from './features';
export * from './rules';
export * from './setups';
export * from './levels';
export * from './trailing';
export * from './option-premium';
export * from './decision';
export * from './engine';

// Fixtures are exported deliberately. They are how a known setup is replayed
// through the real core into the real paper executor without touching a
// production threshold or fabricating a live signal, so the verification
// scripts and the backtest replay both need them at runtime — not only the
// `.spec` files.
export * from './fixtures';
