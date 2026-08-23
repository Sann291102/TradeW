targetScope = 'resourceGroup'

@description('Region of the existing Container Apps environment.')
param location string = resourceGroup().location

@description('Prefix for Container App resource names, for example tradew-staging.')
param namePrefix string

@description('Resource ID of the Container Apps environment created by main.bicep.')
param managedEnvironmentId string

@description('User-assigned identity with AcrPull and Key Vault Secrets User roles.')
param containerAppsIdentityResourceId string

@description('ACR login server, for example tradewstagingacr.azurecr.io.')
param containerRegistryLoginServer string

@description('Immutable image tag, normally the Git commit SHA. Do not use latest.')
param imageTag string

@description('Public browser origin, including https. Used only for API CORS and OAuth callbacks.')
param publicOrigin string

@description('Number of trusted proxy hops after Front Door is introduced. Keep 0 until then.')
@minValue(0)
@maxValue(3)
param trustedProxyHops int = 0

@description('Versioned Key Vault secret URLs. URLs contain no secret values.')
param secretUrls object

var identityMap = {
  '${containerAppsIdentityResourceId}': {}
}

var registryConfiguration = [
  {
    server: containerRegistryLoginServer
    identity: containerAppsIdentityResourceId
  }
]

var sharedSecrets = [
  {
    name: 'database-url'
    keyVaultUrl: secretUrls.databaseUrl
    identity: containerAppsIdentityResourceId
  }
  {
    name: 'sentinel-service-token'
    keyVaultUrl: secretUrls.sentinelServiceToken
    identity: containerAppsIdentityResourceId
  }
  {
    name: 'service-token'
    keyVaultUrl: secretUrls.serviceToken
    identity: containerAppsIdentityResourceId
  }
]

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-web'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: identityMap
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registryConfiguration
      ingress: {
        external: false
        targetPort: 3000
        transport: 'auto'
      }
    }
    template: {
      containers: [
        {
          name: 'web'
          image: '${containerRegistryLoginServer}/tradew-web:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                path: '/'
                port: 3000
              }
              initialDelaySeconds: 10
              periodSeconds: 15
            }
          ]
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            // Internal Container Apps service discovery. These names must not
            // be exposed as NEXT_PUBLIC_* variables or browser destinations.
            {
              name: 'API_PROXY_TARGET'
              value: 'http://${namePrefix}-api'
            }
            {
              name: 'FEED_PROXY_TARGET'
              value: 'http://${namePrefix}-live-feed'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-api'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: identityMap
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registryConfiguration
      secrets: concat(sharedSecrets, [
        {
          name: 'jwt-secret'
          keyVaultUrl: secretUrls.jwtSecret
          identity: containerAppsIdentityResourceId
        }
        {
          name: 'admin-api-token'
          keyVaultUrl: secretUrls.adminApiToken
          identity: containerAppsIdentityResourceId
        }
        {
          name: 'dhan-access-token'
          keyVaultUrl: secretUrls.dhanAccessToken
          identity: containerAppsIdentityResourceId
        }
      ])
      ingress: {
        external: false
        targetPort: 4000
        transport: 'auto'
      }
    }
    template: {
      containers: [
        {
          name: 'api'
          image: '${containerRegistryLoginServer}/tradew-api:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 4000
              }
              initialDelaySeconds: 15
              periodSeconds: 15
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/ready'
                port: 4000
              }
              initialDelaySeconds: 15
              periodSeconds: 15
            }
          ]
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '4000'
            }
            {
              name: 'HOST'
              value: '0.0.0.0'
            }
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'JWT_SECRET'
              secretRef: 'jwt-secret'
            }
            {
              name: 'ADMIN_API_TOKEN'
              secretRef: 'admin-api-token'
            }
            {
              name: 'SENTINEL_SERVICE_URL'
              value: 'http://${namePrefix}-sentinel'
            }
            {
              name: 'SENTINEL_SERVICE_TOKEN'
              secretRef: 'sentinel-service-token'
            }
            {
              name: 'DHAN_LIVE_URL'
              value: 'http://${namePrefix}-live-feed'
            }
            {
              name: 'DHAN_ACCESS_TOKEN'
              secretRef: 'dhan-access-token'
            }
            {
              name: 'FRONTEND_URL'
              value: publicOrigin
            }
            {
              name: 'API_PUBLIC_URL'
              value: '${publicOrigin}/api'
            }
            {
              name: 'TRUSTED_PROXY_HOPS'
              value: string(trustedProxyHops)
            }
          ]
        }
      ]
      // The rate limiter is process-local today. Keep this at one until its
      // storage moves to Azure Managed Redis and is load-tested across replicas.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

resource sentinel 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-sentinel'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: identityMap
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registryConfiguration
      secrets: sharedSecrets
      ingress: {
        external: false
        targetPort: 4010
        transport: 'auto'
      }
    }
    template: {
      containers: [
        {
          name: 'sentinel'
          image: '${containerRegistryLoginServer}/tradew-sentinel:${imageTag}'
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 4010
              }
              initialDelaySeconds: 30
              periodSeconds: 15
            }
          ]
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '4010'
            }
            {
              name: 'HOST'
              value: '0.0.0.0'
            }
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'SERVICE_TOKEN'
              secretRef: 'service-token'
            }
            {
              name: 'SENTINEL_LIVE_FEED_URL'
              value: 'http://${namePrefix}-live-feed'
            }
          ]
        }
      ]
      // Sentinel is stateful today: its watch registry and performance gate
      // are not safe to duplicate across replicas.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

resource marketData 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-market-data'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: identityMap
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registryConfiguration
      secrets: [
        {
          name: 'database-url'
          keyVaultUrl: secretUrls.databaseUrl
          identity: containerAppsIdentityResourceId
        }
        {
          name: 'dhan-access-token'
          keyVaultUrl: secretUrls.dhanAccessToken
          identity: containerAppsIdentityResourceId
        }
      ]
      ingress: {
        external: false
        targetPort: 4020
        transport: 'auto'
      }
    }
    template: {
      containers: [
        {
          name: 'market-data'
          image: '${containerRegistryLoginServer}/tradew-market-data:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 4020
              }
              initialDelaySeconds: 20
              periodSeconds: 15
            }
          ]
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '4020'
            }
            {
              name: 'HOST'
              value: '0.0.0.0'
            }
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'DHAN_ACCESS_TOKEN'
              secretRef: 'dhan-access-token'
            }
          ]
        }
      ]
      // Dhan permits only a limited set of feed connections per account.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

resource liveFeed 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-live-feed'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: identityMap
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registryConfiguration
      secrets: [
        {
          name: 'dhan-access-token'
          keyVaultUrl: secretUrls.dhanAccessToken
          identity: containerAppsIdentityResourceId
        }
      ]
      ingress: {
        external: false
        targetPort: 4600
        transport: 'auto'
      }
    }
    template: {
      containers: [
        {
          name: 'live-feed'
          image: '${containerRegistryLoginServer}/tradew-market-data:${imageTag}'
          command: [
            '/usr/bin/tini'
            '--'
            'npx'
            'ts-node'
            '-T'
            '--project'
            'tsconfig.scripts.json'
            'scripts/live-feed-server.ts'
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/status'
                port: 4600
              }
              initialDelaySeconds: 20
              periodSeconds: 20
            }
          ]
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'DHAN_LIVE_PORT'
              value: '4600'
            }
            {
              name: 'DHAN_LIVE_HOST'
              value: '0.0.0.0'
            }
            {
              name: 'DHAN_ACCESS_TOKEN'
              secretRef: 'dhan-access-token'
            }
          ]
        }
      ]
      // This bridge owns the Dhan feed connection and is intentionally one
      // replica. The web route allowlist remains its only browser exposure.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output webInternalFqdn string = web.properties.configuration.ingress.fqdn
output apiInternalFqdn string = api.properties.configuration.ingress.fqdn
