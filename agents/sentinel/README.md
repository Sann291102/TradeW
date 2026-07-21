# agents/sentinel/ 🟡

Agent definitions for the Sentinel (Safety Nets) pillar. See `../../docs/product-architecture/SENTINEL.md` §2 for each agent's job and inputs: `market-technical-intelligence`, `emotion-intelligence`, `trap-safety-intelligence`, `compliance-audit`, `sentinel-orchestrator`.

**Status (corrected 2026-07-21):** has a `definitions.json` config file; no per-agent source files yet (the actual agent logic already lives in `services/sentinel/src/{intelligence,compliance,orchestrator}/`, not here — see `services/sentinel/README.md`). These five have a strict dependency order: the first three feed the orchestrator, so write and test them independently before wiring up `sentinel-orchestrator`'s synthesis logic.
