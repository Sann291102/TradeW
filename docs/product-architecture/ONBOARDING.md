# Onboarding — Product Blueprint

Status: design, pre-implementation.

## 1. The one rule this exists to enforce

Per the brief: **do not send users directly to Paper Trading after signup.** Onboarding is a required, non-skippable sequence that establishes context before the user ever sees a live workspace.

## 2. Flow

```
Signup → Welcome → Trading Experience → Goals → Preferred Markets → Risk Profile
       → Workspace Setup → Platform Tour → Dashboard → Sentinel Introduction → Trading
```

| Step | Captures | Feeds |
|---|---|---|
| Trading Experience | beginner/intermediate/advanced | Learning Hub's initial recommended path |
| Goals | e.g. income, learning, long-term investing | Home dashboard's default widget emphasis |
| Preferred Markets | equity/options/futures, sectors of interest | Watchlist seed, Portfolio Insights framing |
| Risk Profile | conservative/moderate/aggressive | Sentinel's Emotion Intelligence baseline (`SENTINEL.md` §2) — this is the first data point the agent has before any real trades exist |
| Workspace Setup | preferred default workspace (Home/Trading/Options) | initial nav landing after onboarding completes |

## 3. Storage

New `onboarding_profile` table, owned by `services/api`: user_id, experience_level, goals[], preferred_markets[], risk_profile, workspace_default, completed_at. Read by Sentinel (via `services/api`, read-only, same pattern as its trade-history access) as the seed for Emotion Intelligence before real behavioral data accumulates.

## 4. Platform Tour + Sentinel Introduction

Two distinct steps, not merged: Platform Tour covers Core Platform navigation (sidebar, top bar, search) per the shared chrome in `DESIGN-SYSTEM.md` §3; Sentinel Introduction is a dedicated explainer of what Sentinel is/isn't (observation-only, never a gate — `SENTINEL.md` §6) **before** the user reaches a live workspace where Sentinel is already active. This matters for the same reason Sentinel's compliance posture matters generally: a user should never encounter a Sentinel warning for the first time without having been told what it is and isn't.

## 5. Skippability

Not skippable end-to-end (per §1). Individual steps (Goals, Preferred Markets) can be "skip for now, I'll set this up later" without blocking progression, but the sequence itself — Signup through Sentinel Introduction — always runs once per account before Trading is reachable.

## 6. Data dependencies

- `services/api` — new `onboarding_profile` table, gate on first login (redirect to onboarding if `completed_at` is null)
- Sentinel (read-only) — risk profile seed

## 7. Sentinel-originated signup — same flow, Sentinel-first landing (2026-07-21)

A user may arrive from a dedicated Sentinel marketing page rather than the main site. That changes where they *land*, not what platform they join: they are onboarding onto TradeW, and Sentinel is the workspace they came for.

```
Signup → Welcome → Trading Experience → Goals → Preferred Markets → Risk Profile
       → Workspace Setup → Platform Tour → Sentinel Introduction → /sentinel
```

- The flow is **§2's flow, unchanged** — every step still applies, because the user is joining the full platform and will have a sidebar with Dashboard, Markets, Trading, Portfolio and the rest.
- **Workspace Setup** defaults `workspace_default` to `sentinel` for this entry path, so the user lands where they expected. That is the whole of the difference.
- **Sentinel Introduction** (§4) is unchanged and still required before a live Sentinel session.
- Still not skippable end-to-end (§5), still one `onboarding_profile` row (§3), with no fields left null on account of the entry point.

> **Reversed direction, 2026-07-21.** This section previously specified a *separate, shorter* Sentinel-only onboarding that dropped Trading Experience, Goals, Preferred Markets, Workspace Setup and Platform Tour, on the grounds that "none of which exists inside the standalone Sentinel application." Sentinel is not a standalone application, so all of it does exist and none of it should be dropped — cutting those steps would have left Sentinel-originated users with a half-configured platform (`SENTINEL.md` §5, `TRADEW-OS.md` §1).
