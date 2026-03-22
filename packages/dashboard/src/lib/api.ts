const BASE = '/api'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
    throw new Error(err.error?.message || res.statusText)
  }
  return res.json()
}

// Types
export interface LogEntry {
  id: string
  model: string
  gatewayKey: string
  attempts: Array<{
    provider: string
    deploymentId: string
    groupName?: string | null
    price: number
    status: 'success' | 'failed' | 'skipped_cooldown'
    error?: string
    latencyMs?: number
  }>
  finalProvider: string | null
  totalLatencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  cost: number | null
  savedVsDirect: number | null
  success: boolean
  createdAt: string
}

export interface Provider {
  id: string
  type: 'newapi' | 'openai-compatible'
  endpoint: string
  apiKey: string
  costMultiplier: number
  newApiUserId: number | null
  accessToken: string | null
  blackGroupMatch: string[]
  syncEnabled: boolean
  syncIntervalMinutes: number
  lastSyncAt: string | null
  createdAt: string
}

export interface ModelDeployment {
  deploymentId: string
  providerId: string
  canonical: string
  upstream: string
  groupName: string | null
  priceInput: number | null
  priceOutput: number | null
  priceSource: string
  manualPriceInput: number | null
  manualPriceOutput: number | null
  status: string
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

// Stats
export const getStats = () => request<{
  today: { requests: number; cost: number; saved: number; inputTokens: number; outputTokens: number; successRate: number }
  total: { requests: number; cost: number; saved: number }
  activeProviders: number
}>('/stats')

export const getUsage = (date?: string) =>
  request<Array<{ date: string; gatewayKey: string; model: string; requestCount: number; totalCost: number; totalSaved: number }>>
    (`/usage${date ? `?date=${date}` : ''}`)

// Logs
export const getLogs = (params?: { cursor?: string; limit?: number; model?: string; key?: string; status?: string }) => {
  const searchParams = new URLSearchParams()
  if (params?.cursor) searchParams.set('cursor', params.cursor)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.model) searchParams.set('model', params.model)
  if (params?.key) searchParams.set('key', params.key)
  if (params?.status) searchParams.set('status', params.status)
  const qs = searchParams.toString()
  return request<{ data: LogEntry[]; nextCursor: string | null }>(`/logs${qs ? `?${qs}` : ''}`)
}

export const getLog = (id: string) => request<LogEntry>(`/logs/${id}`)

// Providers
export const getProviders = () => request<Provider[]>('/providers')
export const createProvider = (data: Record<string, unknown>) =>
  request<{ id: string }>('/providers', { method: 'POST', body: JSON.stringify(data) })
export const updateProvider = (id: string, data: Record<string, unknown>) =>
  request<{ ok: boolean }>(`/providers/${id}`, { method: 'PUT', body: JSON.stringify(data) })
export const deleteProvider = (id: string) =>
  request<{ ok: boolean }>(`/providers/${id}`, { method: 'DELETE' })
export const syncProvider = (id: string) =>
  request<SyncResult>(`/providers/${id}/sync`, { method: 'POST' })
export const getSyncHistory = (id: string) =>
  request<Array<Record<string, unknown>>>(`/providers/${id}/sync-history`)

// Models
export const getModels = () => request<ModelDeployment[]>('/models')
export const updateModelPrice = (deploymentId: string, priceInput: number | null, priceOutput: number | null) =>
  request<{ ok: boolean }>(`/models/${deploymentId}/price`, {
    method: 'PUT',
    body: JSON.stringify({ priceInput, priceOutput }),
  })

// Keys
export const getKeys = () => request<Array<{ id: string; name: string; keyPrefix: string; createdAt: string }>>('/keys')
export const createKey = (name: string) =>
  request<{ id: string; name: string; key: string; keyPrefix: string }>('/keys', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
export const deleteKey = (id: string) =>
  request<{ ok: boolean }>(`/keys/${id}`, { method: 'DELETE' })

// Health
export const getHealth = () => request<{ status: string; timestamp: string }>('/health')
