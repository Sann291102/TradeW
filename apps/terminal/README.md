# apps/terminal — THE TradeW app (Terminal v0.5)

**This is the application. One file: [`index.html`](index.html).**

Everything lives inside that single self-contained file — HTML, CSS and
JavaScript for all workspaces: Core (Home / Markets / Trading / Portfolio /
Option Chain / Alerts), TradeW AI (Research + AI dock) and the **Sentinel**
workspace (agent cards, risk callouts, AI Reflection Cards, Agent Activity
Timeline, Observation Feed, Session Summary, Trading Journal).

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
