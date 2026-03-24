export type ProviderType = 'newapi' | 'openai-compatible' | 'anthropic'
export type PriceSource = 'provider_api' | 'models_dev' | 'manual' | 'unknown'
export type DeploymentStatus = 'active' | 'stale'

export interface ProviderConfig {
  id: string
  type: ProviderType
  endpoint: string
  apiKey: string
  costMultiplier: number
  // NewAPI-specific
  newApiUserId?: number
  accessToken?: string
  blackGroupMatch?: string[]
  // Sync settings
  syncEnabled: boolean
  syncIntervalMinutes: number
  lastSyncAt?: string
}

export interface ModelDeployment {
  deploymentId: string
  providerId: string
  canonical: string
  upstream: string
  groupName?: string
  priceInput: number | null
  priceOutput: number | null
  priceSource: PriceSource
  manualPriceInput?: number | null
  manualPriceOutput?: number | null
  status: DeploymentStatus
  lastSyncAt: string
}

export interface SyncResult {
  providerId: string
  modelsAdded: number
  modelsUpdated: number
  modelsRemoved: number
  errors: string[]
  durationMs: number
}

export interface DailyUsage {
  date: string
  gatewayKey: string
  model: string
  requestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  totalSaved: number
}
