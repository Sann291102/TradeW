---
type: plan
date: 2026-07-17
tags: [plan, deployment, infra, oci, docker]
status: designed-not-deployed
---

# OCI Free Tier deployment

## For future Claude
Read this before designing any hosting/deploy for TradeW. Oracle Cloud is the **host only** — Postgres stays the database (the earlier Oracle *Database* migration was explicitly rejected, see [[../Research/2026-07-17 - Oracle migration assessment]]). The canonical, detailed design lives in the repo at `infra/oci/README.md`; this note is the index entry, not a duplicate.

## What was built (2026-07-17)
Deployment architecture + runnable infra for a single **OCI Ampere A1 (arm64, 4 OCPU / 24 GB)** VM, preserving the app architecture (no code logic changed):
- **Dockerfiles** — `services/api/Dockerfile`, `services/sentinel/Dockerfile`, `apps/web/Dockerfile` (multi-stage, monorepo-aware, arm64-buildable; api image doubles as the Prisma migrate runner).
- **Prod stack** — `infra/docker/docker-compose.prod.yml`: Caddy (auto-TLS, `/api` same-origin proxy) → web + api; internal sentinel; pgvector Postgres (persistent, tuned); provisioned-but-unused Redis; one-shot migrate. Compose-validated.
- **Reverse proxy / SSL** — `infra/docker/Caddyfile` (Let's Encrypt).
- **Backups** — `infra/docker/backup.sh` (pg_dump → OCI Object Storage via rclone, retention).
- **CI/CD** — `.github/workflows/deploy.yml` (arm64 build → GHCR → SSH deploy + migrate).
- **Env** — `infra/docker/.env.prod.example`; `.env.prod` gitignored.
- **Design doc** — `infra/oci/README.md` (all 9 areas + the OCI networking gotcha + first-deploy checklist).

## Key decisions / gotchas
- **arm64** everywhere (Ampere). All base images are multi-arch; app images built for `linux/arm64` in CI.
- **Two firewalls**: OCI VCN Security List/NSG **and** the instance iptables/firewalld must both open 80/443 — the classic "looks up but unreachable" trap.
- **Redis** is provisioned but no app code consumes it yet — honest, not load-bearing.
- **Not validated live** — no OCI VM was available; first CI build + deploy is the validation step.

## Remaining (manual, needs the actual account)
Provision the VM, open ports, DNS A record, fill/rotate `.env.prod` secrets, set GH secrets (SSH_HOST/USER/KEY), configure rclone backup remote, run first deploy. Full checklist in `infra/oci/README.md`.

## Related
- [[../Research/2026-07-17 - Oracle migration assessment]] — why Postgres stays
- [[2026-07-17 - Platform audit and implementation roadmap]]
- [[Patterns/2026-07-17 - Knowledge Workspace]]
