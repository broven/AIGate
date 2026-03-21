// NewAPI provider sync — fetches groups, pricing, and creates per-group tokens

import { canonicalize } from './canonicalize'
import { getModelsDevPricing, lookupPrice } from './models-dev'

// NewAPI /api/pricing response format
interface NewAPIPricingResponse {
  model_group: Record<string, {
    DisplayName: string
    GroupRatio: number
    ModelPrice: Record<string, { priceType: number; price: number }>
  }>
}

// NewAPI /api/ratio_config response
interface NewAPIRatioConfig {
  [model: string]: number // completion_ratio
}

// NewAPI token
interface NewAPIToken {
  id: number
  key: string
  name: string
  group: string
  status: number // 1 = active
}

const BASE_FACTOR = 2 // NewAPI base factor (from axonhub-bridge)

export interface SyncedModel {
  canonical: string
  upstream: string
  groupName: string | null
  apiKey: string | null // Per-group token
  priceInput: number | null
  priceOutput: number | null
  priceSource: 'provider_api' | 'models_dev' | 'unknown'
}

function newApiHeaders(accessToken: string, userId?: number): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }
  if (userId) {
    headers['New-Api-User'] = String(userId)
  }
  return headers
}

async function fetchExistingTokens(
  endpoint: string,
  headers: Record<string, string>,
): Promise<Map<string, NewAPIToken>> {
  const map = new Map<string, NewAPIToken>()
  try {
    // NewAPI token list endpoint: GET /api/token/?p=0&size=100
    const res = await fetch(`${endpoint}/api/token/?p=0&size=100`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return map
    const data = await res.json() as { data?: NewAPIToken[] }
    for (const t of data.data || []) {
      if (t.group && t.status === 1 && t.name?.startsWith('aigate-')) {
        map.set(t.group, t)
      }
    }
  } catch {
    // Ignore — will create tokens as needed
  }
  return map
}

async function createGroupToken(
  endpoint: string,
  headers: Record<string, string>,
  groupName: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${endpoint}/api/token/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `aigate-${groupName}`,
        group: groupName,
        remain_quota: 5000000000,
        expired_time: -1,
        unlimited_quota: false,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      console.warn(`[newapi] Failed to create token for group ${groupName}: ${res.status}`)
      return null
    }
    const data = await res.json() as { data?: string; key?: string }
    return data.data || data.key || null
  } catch (err) {
    console.warn(`[newapi] Error creating token for group ${groupName}:`, err)
    return null
  }
}

export async function syncNewAPIProvider(
  endpoint: string,
  apiKey: string,
  costMultiplier: number,
  blackGroupMatch: string[],
  accessToken?: string,
  newApiUserId?: number,
): Promise<{ models: SyncedModel[]; errors: string[] }> {
  const errors: string[] = []
  const models: SyncedModel[] = []
  const authToken = accessToken || apiKey
  const headers = newApiHeaders(authToken, newApiUserId)

  try {
    // Step 1: Fetch pricing data (groups + models + prices)
    const pricingRes = await fetch(`${endpoint}/api/pricing`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    })

    if (!pricingRes.ok) {
      errors.push(`Pricing API returned ${pricingRes.status}`)
      return { models, errors }
    }

    const pricingData = await pricingRes.json() as NewAPIPricingResponse

    if (!pricingData.model_group || typeof pricingData.model_group !== 'object') {
      // Fallback: try legacy flat format
      const legacyData = pricingData as unknown as { data?: Array<{ model_group: string; model_name: string; model_price: number; group_ratio: number }> }
      if (legacyData.data && Array.isArray(legacyData.data)) {
        return syncNewAPILegacyFormat(legacyData.data, endpoint, authToken, costMultiplier, blackGroupMatch, newApiUserId)
      }
      errors.push('Unexpected pricing format: no model_group field')
      return { models, errors }
    }

    // Step 2: Fetch ratio config for completion ratios
    let ratioConfig: NewAPIRatioConfig = {}
    try {
      const ratioRes = await fetch(`${endpoint}/api/ratio_config`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      if (ratioRes.ok) {
        ratioConfig = await ratioRes.json() as NewAPIRatioConfig
      }
    } catch {
      errors.push('Failed to fetch ratio_config')
    }

    // Step 3: Fetch existing AIGate tokens and create missing ones
    const existingTokens = await fetchExistingTokens(endpoint, headers)

    // Step 4: Get models.dev pricing for fallback
    const modelsDevPricing = await getModelsDevPricing()

    // Step 5: Process each group
    for (const [groupName, groupData] of Object.entries(pricingData.model_group)) {
      // Apply blackGroupMatch filter
      const isBlacklisted = blackGroupMatch.some(
        (pattern) => groupName.toLowerCase().includes(pattern.toLowerCase()),
      )
      if (isBlacklisted) continue

      // Get or create group token
      let groupToken: string | null = null
      const existing = existingTokens.get(groupName)
      if (existing) {
        groupToken = existing.key
      } else {
        groupToken = await createGroupToken(endpoint, headers, groupName)
      }

      if (!groupToken) {
        errors.push(`Failed to get token for group: ${groupName}`)
        continue
      }

      // Process each model in this group
      const groupRatio = groupData.GroupRatio ?? 1
      for (const [modelName, modelData] of Object.entries(groupData.ModelPrice || {})) {
        const canonical = canonicalize(modelName)

        let priceInput: number | null = null
        let priceOutput: number | null = null
        let priceSource: 'provider_api' | 'models_dev' | 'unknown' = 'unknown'

        if (modelData.price > 0) {
          const completionRatio = ratioConfig[modelName] ?? 1
          const basePrice = modelData.price * groupRatio * BASE_FACTOR * costMultiplier

          priceInput = basePrice
          priceOutput = basePrice * completionRatio
          priceSource = 'provider_api'
        } else if (costMultiplier === 0) {
          priceInput = 0
          priceOutput = 0
          priceSource = 'provider_api'
        } else {
          const devPrice = lookupPrice(modelsDevPricing, modelName)
          if (devPrice) {
            priceInput = devPrice.input * costMultiplier
            priceOutput = devPrice.output * costMultiplier
            priceSource = 'models_dev'
          }
        }

        models.push({
          canonical,
          upstream: modelName,
          groupName,
          apiKey: `sk-${groupToken}`, // NewAPI tokens need sk- prefix
          priceInput,
          priceOutput,
          priceSource,
        })
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  return { models, errors }
}

// Legacy flat format fallback (some NewAPI instances use this)
async function syncNewAPILegacyFormat(
  entries: Array<{ model_group: string; model_name: string; model_price: number; group_ratio: number }>,
  endpoint: string,
  authToken: string,
  costMultiplier: number,
  blackGroupMatch: string[],
  newApiUserId?: number,
): Promise<{ models: SyncedModel[]; errors: string[] }> {
  const errors: string[] = []
  const models: SyncedModel[] = []
  const headers = newApiHeaders(authToken, newApiUserId)
  const existingTokens = await fetchExistingTokens(endpoint, headers)
  const modelsDevPricing = await getModelsDevPricing()
  const groupTokens = new Map<string, string | null>()

  for (const entry of entries) {
    const isBlacklisted = blackGroupMatch.some(
      (pattern) => entry.model_group.toLowerCase().includes(pattern.toLowerCase()),
    )
    if (isBlacklisted) continue

    // Get or create group token (cached per group)
    if (!groupTokens.has(entry.model_group)) {
      const existing = existingTokens.get(entry.model_group)
      if (existing) {
        groupTokens.set(entry.model_group, existing.key)
      } else {
        const token = await createGroupToken(endpoint, headers, entry.model_group)
        groupTokens.set(entry.model_group, token)
      }
    }

    const groupToken = groupTokens.get(entry.model_group)
    if (!groupToken) continue

    const canonical = canonicalize(entry.model_name)
    let priceInput: number | null = null
    let priceOutput: number | null = null
    let priceSource: 'provider_api' | 'models_dev' | 'unknown' = 'unknown'

    if (entry.model_price > 0) {
      const basePrice = entry.model_price * entry.group_ratio * BASE_FACTOR * costMultiplier
      priceInput = basePrice
      priceOutput = basePrice
      priceSource = 'provider_api'
    } else {
      const devPrice = lookupPrice(modelsDevPricing, entry.model_name)
      if (devPrice) {
        priceInput = devPrice.input * costMultiplier
        priceOutput = devPrice.output * costMultiplier
        priceSource = 'models_dev'
      }
    }

    models.push({
      canonical,
      upstream: entry.model_name,
      groupName: entry.model_group,
      apiKey: `sk-${groupToken}`,
      priceInput,
      priceOutput,
      priceSource,
    })
  }

  return { models, errors }
}
