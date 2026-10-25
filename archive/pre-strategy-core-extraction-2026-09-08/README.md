# Pre-extraction snapshot — 2026-09-08

Point-in-time copies of the three Sentinel modules whose bodies moved into
`packages/strategy-core` when the decision core was extracted (Phase 0 of the
autonomous-engine work).

**These are a snapshot for Rule 1, not live code. Do not edit them and do not
import them.** The live versions are:

| was | now |
|---|---|
| `services/sentinel/src/intelligence/indicators.ts` | `packages/strategy-core/src/indicators.ts` |
| `services/sentinel/src/intelligence/market-structure.ts` | `packages/strategy-core/src/market-structure.ts` |
| `services/sentinel/src/intelligence/strategy-rules.ts` | `packages/strategy-core/src/rules.ts` |

The original paths still exist and still export the same symbols — they are now
re-export shims, so every import site in the repository was left untouched and
Sentinel's behaviour is unchanged. The only content change in the move was one
import line in `strategy-rules.ts` (`./market-intelligence.service` →
`./snapshot`), verified by diff at the time of the move.
