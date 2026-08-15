# ADR-001: Azure Container Apps migration foundation

**Status:** Proposed
**Date:** 2026-08-16
**Deciders:** TradeW engineering and product owners

## Context

TradeW currently runs as a Docker Compose stack behind Caddy. The web app and
API are the public surfaces; Sentinel, market-data and the Dhan live-feed bridge
are deliberately private. The platform has an existing Azure PostgreSQL host,
but its password must never enter the repository.

The migration needs private service discovery, managed identity, durable
background work, observable deployments, and a safe route back to the existing
OCI deployment. It must not change the correctness constraints of singleton
services.

## Decision

Build an Azure Container Apps foundation in Bicep before deploying application
containers. It provides:

- an internal, VNet-integrated Container Apps environment;
- Azure Container Registry with managed-identity image pulls;
- Key Vault with RBAC, with secrets created outside the deployment template;
- Log Analytics and Application Insights;
- Service Bus queues for durable background-job triggers; and
- a VNet split between the delegated Container Apps subnet and an isolated
  private-endpoint subnet.

Existing PostgreSQL is treated as an external dependency. Its ownership,
networking, backup, and pgvector support must be verified before application
cutover. This foundation does not create or change it.

## Options considered

### Option A: Container Apps foundation first

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Moderate; validate Front Door Premium, private networking, and always-warm replicas before production |
| Scalability | Good for current service count |
| Team familiarity | Medium |

**Pros:** Establishes repeatable infrastructure, isolates services, avoids
secrets in code, and preserves a staged migration path.

**Cons:** Requires Azure subscription and network decisions before deployment.

### Option B: Directly deploy Compose-equivalent containers with CLI commands

| Dimension | Assessment |
|---|---|
| Complexity | Low initially, high over time |
| Cost | Unknown and difficult to audit |
| Scalability | Uncontrolled |
| Team familiarity | High |

**Pros:** Fast proof of concept.

**Cons:** Infrastructure drift, accidental secret exposure, and no reviewable
rollback plan.

## Consequences

- `market-data`, `live-feed`, and `sentinel` remain at one replica. They must
  not be horizontally scaled until their state is made shared and idempotent.
- API replicas remain capped at one in the Azure service module until its
  process-local rate limiter moves to Azure Managed Redis.
- Front Door Premium, private endpoints, and production DNS are intentionally
  excluded until staging confirms network connectivity and cost.
- The OCI stack remains the rollback deployment until an Azure cutover has
  passed backup-restore, load, readiness, and data-consistency tests.

## Action items

1. Deploy this foundation to a staging resource group using `what-if` first.
2. Create Key Vault secrets out of band and grant only the Container Apps
   identity access to read them.
3. Verify the existing PostgreSQL server's private networking, pgvector, backup
   restore, and connection budget.
4. Add the Container Apps service module and Front Door only after the above
   evidence is recorded.
