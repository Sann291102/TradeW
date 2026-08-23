# Azure Container Apps foundation

This directory is the Azure migration's **foundation only**. It creates the
network, observability, container registry, Key Vault, Container Apps
environment, identities, and Service Bus queues. It intentionally does not
create, overwrite, or migrate the existing PostgreSQL server.

## What is already known

- PostgreSQL host: `tradew.postgres.database.azure.com`
- Database: `postgres`
- App Service hostname: `tradew-dscvgqe3dwhkgqax.eastus2-01.azurewebsites.net`

Those values are identifiers, not deployment configuration. Store the complete
PostgreSQL connection string in Key Vault as `database-url`; never add a real
password to Git, a Bicep parameter file, terminal history, or CI logs.

## Before deploying

1. Confirm the Azure subscription, tenant, resource group, and the target
   production region. The supplied App Service is in East US 2, while the
   proposed design is Central India; this is a latency and data-movement
   decision that must be explicit.
2. Confirm that `tradew.postgres.database.azure.com` is the intended Flexible
   Server and that its network policy permits the new Container Apps VNet. Do
   not disable public access or change firewall rules until the private path has
   been tested.
3. Validate `pgvector` and take a restorable backup before any production
   application points at the server.
4. Create a resource group and use a local copy of `main.bicepparam` named
   `main.staging.local.bicepparam`. Do not use the checked-in example as
   production input.

## Deploy the foundation

```powershell
az login
az account set --subscription '<subscription-id>'
az group create --name tradew-staging-rg --location centralindia
az bicep build --file infra/azure/main.bicep
az deployment group what-if --resource-group tradew-staging-rg --template-file infra/azure/main.bicep --parameters infra/azure/main.staging.local.bicepparam
az deployment group create --resource-group tradew-staging-rg --template-file infra/azure/main.bicep --parameters infra/azure/main.staging.local.bicepparam
```

## Deploy application services to staging

After the foundation and the Key Vault secrets exist, create a local
`services.staging.local.bicepparam` from the checked-in example. Use a commit
SHA as `imageTag`; a mutable `latest` tag makes a rollback impossible to state.

```powershell
az bicep build --file infra/azure/services.bicep
az deployment group what-if --resource-group tradew-staging-rg --template-file infra/azure/services.bicep --parameters infra/azure/services.staging.local.bicepparam
az deployment group create --resource-group tradew-staging-rg --template-file infra/azure/services.bicep --parameters infra/azure/services.staging.local.bicepparam
```

The module deploys `web`, `api`, `sentinel`, `market-data`, and `live-feed`
with **internal ingress only**. It does not make an application publicly
reachable. Azure Front Door Premium and Private Link remain the only approved
way to introduce public production traffic in a later change.

The parameters name versioned Key Vault secret URLs. Create these secrets out
of band before deployment: `database-url`, `jwt-secret`, `admin-api-token`,
`sentinel-service-token`, `service-token`, and `dhan-access-token`.

## Deliberate next steps

The public ingress and scale-out work comes after these facts are confirmed:

- Front Door Premium and Private Link are selected and cost-approved.
- Private DNS and the database's network model are agreed.
- Azure Managed Redis is provisioned; the API rate limiter is migrated from
  process memory before API replicas can scale above one.
- Clean CI builds publish an Azure-supported container architecture. The
  current OCI workflow publishes `linux/arm64` only.
- Service secrets are created out of band in Key Vault.

`market-data`, `live-feed`, and `sentinel` remain singleton workloads. The
current broker-feed and Sentinel state model make a second replica incorrect,
not merely expensive.
