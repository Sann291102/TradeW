# apps/mobile 🟡

Placeholder for the Android/iOS app targeted at roadmap stage **v0.9 (closed beta)** per `TradeW-Build-Plan.md` — nothing here should be built before then.

**Depends on (planned):** `packages/types`, `packages/sdk` — deliberately not `packages/ui` by default, since a React Native UI kit is usually not a drop-in reuse of a web component library. Revisit that assumption when this app is actually started.

**Talks to:** `services/api` only.

**Open question (see ARCHITECTURE.md §10):** whether this is React Native or a separate native codebase per platform. Don't decide this now — decide it at the v0.9 build stage when team skills and the actual feature list are known.

**Status:** empty on purpose. Do not scaffold a framework here yet.
