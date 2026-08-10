# `infra/terraform` — Stage 1: AWS ap-south-1

Terraform for the **Stage 1** target described in `docs/CLOUD-ARCHITECTURE.md`:
the first deployment that survives losing a machine. Stage 0 (a single Oracle
Cloud Ampere VM running `infra/docker/docker-compose.prod.yml`) stays the
current deployment and is documented in `infra/oci/README.md`; nothing here
replaces it until there is traffic that justifies the spend.

> **Status: written, never applied.** No AWS account was available while this
> was authored, so `terraform plan` has not been run against a real provider.
> Treat the first `plan` as the review step, not as a formality. Every resource
> is standard and the module graph is deliberately boring for exactly that
> reason.

## What it provisions

| Layer | Resource | Why this and not the obvious alternative |
|---|---|---|
| Network | VPC, 2 public + 2 private subnets across 2 AZs, IGW, 1 NAT GW | Two AZs is the smallest topology that survives an AZ failure. One NAT gateway, not two — it is the single largest fixed cost here and a NAT outage degrades outbound calls, it does not take the site down. |
| Ingress | ALB (HTTP→HTTPS redirect), ACM cert | ALB rather than API Gateway: the app is a long-lived HTTP service with SSE, not a set of lambdas, and ALB target-group health checks are what make `/ready` meaningful. |
| Compute | ECS Fargate — `web`, `api`, `sentinel`, `market-data`, `live-feed` | Fargate rather than EKS: five services do not need a control plane, and the operational surface of EKS is the thing most likely to be the actual outage. |
| Data | RDS PostgreSQL 16, Multi-AZ optional, `pgvector` enabled | Managed, because the audit's honest position is that nobody here is on call for a self-managed primary at 3am. |
| Cache | ElastiCache Redis (single node; replication group when it matters) | Needed at Stage 1 for exactly one reason: rate-limit counters must be shared once `api` runs more than one task. |
| Images | ECR repositories per service | |
| Secrets | Secrets Manager, injected as ECS task secrets | Never in task-definition environment blocks, which are readable by anyone with `ecs:DescribeTaskDefinition`. |
| Logs | CloudWatch log group per service, 30-day retention | Matches `TELEMETRY_RETENTION_DAYS` so the two stories about "how far back can we look" agree. |

## Replica counts are not uniform, and that is deliberate

`api` and `web` are stateless and scale horizontally. The other three do not:

- **`market-data`** owns the broker feed connection. Dhan allows five
  connections per account and evicts the oldest with code 805 on the sixth, so
  a second task does not double throughput — it fights the first for the
  connection set. `desired_count = 1`, and the variable is documented as such.
- **`live-feed`** is the same resource for the same reason.
- **`sentinel`** holds an in-memory market-watch registry and writes occurrence
  records that feed its own live-performance gate; two instances would
  double-count occurrences and inflate the sample that gate depends on. It can
  be made horizontally scalable — see the Stage 2 section of
  `docs/CLOUD-ARCHITECTURE.md` — but it is not today, so it is pinned to 1 and
  the reason is recorded here rather than discovered later.

`api` is safe to scale because its singleton background work (matching engine,
settlement, snapshots, telemetry retention) runs behind the `JobLease` leader
election added in `services/api/src/common/leader-election.ts`. Before that,
`desired_count = 2` was a correctness bug, not a capacity setting.

## Layout

```
main.tf         providers, backend, locals
variables.tf    every knob, with the reasoning in its description
network.tf      VPC, subnets, routing, security groups
data.tf         RDS, ElastiCache, Secrets Manager
compute.tf      ECR, ECS cluster, task definitions, services, autoscaling
alb.tf          load balancer, listeners, target groups, ACM
outputs.tf
```

## Using it

```bash
cd infra/terraform
terraform init
terraform plan  -var-file=env/prod.tfvars
terraform apply -var-file=env/prod.tfvars
```

The state backend is intentionally left as a placeholder in `main.tf`: pointing
it at an S3 bucket that does not exist yet is a worse first experience than
being told to create one.
