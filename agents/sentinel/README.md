# agents/sentinel/ 🟡

Agent definitions for the Sentinel (Safety Nets) pillar. See `../../docs/product-architecture/SENTINEL.md` §2 for each agent's job and inputs: `market-technical-intelligence`, `emotion-intelligence`, `trap-safety-intelligence`, `compliance-audit`, `sentinel-orchestrator`.

**Status (corrected 2026-08-21):** `definitions.json` exists and **nothing reads it** — not this folder's absence of source files, but the file itself being unwired. Sentinel's agent logic lives in `services/sentinel/src/`, is deterministic TypeScript with no LLM, no tools and no prompt templates, and its roster is ten agents whose ids do not match the five names in `definitions.json`.

Do not add a definition here expecting it to take effect. Adding a Sentinel agent means writing a class in `services/sentinel/src/sentinel-intelligence/agents/` and registering it in `AgentRegistryService`. See `../../docs/product-architecture/AGENT-LAYERS.md` for the full map.
