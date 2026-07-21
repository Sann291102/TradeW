# apps/terminal — superseded static prototype (Terminal v0.5)

**Status (corrected 2026-07-21): historical reference only, superseded by `apps/web`.** This was originally documented as "THE TradeW app" — that framing is stale and incorrect. `apps/web` is the real, actively developed frontend (110+ real source files as of 2026-07-21); this folder is a single static `index.html` with no build step, kept for provenance per the repo's archive-don't-delete policy, not treated as canonical. Its Sentinel section in particular describes the old shared-workspace dashboard model (AI Reflection Cards, Agent Activity Timeline, Observation Feed, Session Summary) that both `apps/web` and `docs/product-architecture/SENTINEL.md` have since moved away from — see `SENTINEL.md` §5 for the current, binding Sentinel product model (a premium intelligence workspace inside the shared TradeW shell).

One file: [`index.html`](index.html). Everything lived inside that single self-contained file — HTML, CSS and JavaScript for all workspaces: Core (Home / Markets / Trading / Portfolio / Option Chain / Alerts), TradeW AI (Research + AI dock) and the old Sentinel workspace layout described above.

## Run it

```bash
cd "D:\TradeW LLC\TradeW\apps\terminal"
python -m http.server 3000
```

Then open **http://localhost:3000**. (Also available via the `tradew-terminal`
entry in `.claude/launch.json`.)

## Facts to avoid confusion

- Moved here 2026-07-16 from `docs/design-reference/prototype/` (git rename,
  history preserved) so the app lives in ONE obvious place.
- Older copies named `TradeW-Platform-v0.4.html` in the `TradeW -(Setup &
  Paper)` folder are superseded snapshots — do not edit those.
- The Sentinel section currently runs on the file's built-in simulation.
  The real Sentinel backend lives in `../../services/sentinel` (port 4010)
  and is not wired to this UI yet.
- Edit policy: targeted edits only, never wholesale rewrites, never deletions
  (workspace rule in `D:\TradeW LLC\CLAUDE.md`).
