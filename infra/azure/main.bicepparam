using './main.bicep'

// Copy this to a non-committed *.bicepparam file and replace every value.
// Names must be globally unique where Azure requires it.
param location = 'centralindia'
param environment = 'staging'
param containerRegistryName = 'tradewstagingacr'
param keyVaultName = 'tradew-staging-kv'
param containerAppsEnvironmentName = 'tradew-staging-env'
param serviceBusNamespaceName = 'tradew-staging-bus'
