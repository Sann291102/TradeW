using './services.bicep'

// Copy to services.staging.local.bicepparam before supplying actual resource
// IDs and Key Vault secret URLs. Do not add secret values to this file.
param location = 'centralindia'
param namePrefix = 'tradew-staging'
param managedEnvironmentId = '/subscriptions/<subscription-id>/resourceGroups/tradew-staging-rg/providers/Microsoft.App/managedEnvironments/tradew-staging-env'
param containerAppsIdentityResourceId = '/subscriptions/<subscription-id>/resourceGroups/tradew-staging-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tradew-staging-containers'
param containerRegistryLoginServer = 'tradewstagingacr.azurecr.io'
param imageTag = '<git-commit-sha>'
param publicOrigin = 'https://staging.example.com'
param trustedProxyHops = 0
param secretUrls = {
  databaseUrl: 'https://tradew-staging-kv.vault.azure.net/secrets/database-url/<version>'
  jwtSecret: 'https://tradew-staging-kv.vault.azure.net/secrets/jwt-secret/<version>'
  adminApiToken: 'https://tradew-staging-kv.vault.azure.net/secrets/admin-api-token/<version>'
  sentinelServiceToken: 'https://tradew-staging-kv.vault.azure.net/secrets/sentinel-service-token/<version>'
  serviceToken: 'https://tradew-staging-kv.vault.azure.net/secrets/service-token/<version>'
  dhanAccessToken: 'https://tradew-staging-kv.vault.azure.net/secrets/dhan-access-token/<version>'
}
