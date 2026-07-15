# services/auth 🟡 (contract boundary, not yet a deployable)

This folder is **not** a running service today. See ARCHITECTURE.md §2.1 for the reasoning: the audited auth logic (JWT, hashed/revocable refresh tokens, `/auth/refresh` + `/auth/logout`, login/signup/refresh audit logging, profile/preferences) already works as a module inside `services/api`, and splitting it into a separately deployed service now would add a network hop with no current benefit.

**What goes here now:** the auth module's public contract — guard interfaces, DTOs, token-validation logic — structured so `services/api` imports it as an isolated internal module.

**Extraction trigger:** real session load approaching the roadmap's v0.9 "50k concurrent" target — not a fixed date. When that happens, this folder becomes the actual standalone deployable and `services/api` calls it over the network instead of importing it in-process.

**Status:** placeholder. Do not deploy this as a separate service before the trigger above.
