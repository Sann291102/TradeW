# infra/ ⚪

Deployment infrastructure as code. See ARCHITECTURE.md §7 for the full deployment architecture.

- `docker/` — docker-compose for local dev (api + web + trading-engine + postgres + redis), extending the compose file already found in the audited `TradeW-Setup-main` copy rather than starting from scratch.
- `k8s/` — one Deployment per service/app for staging/production (AWS ap-south-1 per the architecture doc), independently scalable.
- `terraform/` — IaC for VPC, RDS/Aurora Postgres, ElastiCache Redis, EKS, and S3 (audit/KYC storage, WORM per PRD compliance requirements).

**Status:** empty. Build `docker/` first (needed for local dev immediately); `k8s/` and `terraform/` come later, at the point the team is actually deploying to a real environment — don't provision cloud infrastructure before there's something ready to run on it.
