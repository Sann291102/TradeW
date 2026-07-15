# packages/shared 🟡

Common utilities used by every Node service: a typed config loader (fail-fast env validation at boot, not at first use — see ARCHITECTURE.md §7), a structured logger (JSON, so observability tooling can parse it from day one), and common error types.

**Consumed by:** every service under `services/` written in Node (not `services/trading-engine`, which is Python and has its own equivalent utilities).

**Status:** doesn't exist yet. Build this alongside `services/api` — it's small and cheap, and every other Node service benefits from not reinventing config/logging.
