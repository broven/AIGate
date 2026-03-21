// NewAPI provider sync — fetches groups, pricing, and creates per-group tokens

import { canonicalize } from './canonicalize'
import { getModelsDevPricing, lookupPrice } from './models-dev'

// NewAPI /api/pricing response — actual format from packyapi
interface NewAPIPricingEntry {
  model_name: string
  model_ratio: number
  model_price: number
  completion_ratio: number
  enable_groups: string[]
  vendor_id?: number
  quota_type?: number
  owner_by?: string
  supported_endpoint_types?: string[]
}

interface NewAPIPricingResponse {
  success: boolean
  data: NewAPIPricingEntry[]
  group_ratio: Record<string, number>
  usable_group: Record<string, string>
}

// Yunwu-style /api/pricing response (data is an object, not array)
interface YunwuPricingResponse {
  success: boolean
  data: {
    model_info: Record<string, { name: string; supplier?: string; tags?: string[] }>
    model_completion_ratio: Record<string, number>
    group_special: Record<string, string[]>
    model_group: Record<string, {
      DisplayName?: string
      GroupRatio: number
      ModelPrice?: Record<string, { priceType: number; price: number }>
    }>
  }
}

/** Detect and normalize yunwu-style pricing into the standard NewAPI format */
function normalizeYunwuPricing(raw: YunwuPricingResponse): NewAPIPricingResponse {
  const { model_info, model_completion_ratio, group_special, model_group } = raw.data

  // Build group_ratio from model_group
  const group_ratio: Record<string, number> = {}
  for (const [groupName, group] of Object.entries(model_group)) {
    group_ratio[groupName] = group.GroupRatio ?? 1
  }

  // Build per-model entries
  const data: NewAPIPricingEntry[] = []
  for (const [modelName, info] of Object.entries(model_info)) {
    const enableGroups = group_special[modelName] || []
    const completionRatio = model_completion_ratio[modelName] ?? 1

    // Find the best model_price from model_group entries
    // Use the first group that has a ModelPrice entry for this model
    let modelPrice = 0
    for (const groupName of enableGroups) {
      const grp = model_group[groupName]
      if (grp?.ModelPrice?.[modelName]) {
        modelPrice = grp.ModelPrice[modelName].price
        break
      }
    }

    data.push({
      model_name: modelName,
      model_ratio: 0, // yunwu uses explicit model_price per group
      model_price: modelPrice,
      completion_ratio: completionRatio,
      enable_groups: enableGroups,
    })
  }

  return {
    success: raw.success,
    data,
    group_ratio,
    usable_group: {},
  }
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
    const data = await res.json() as { data?: { items?: NewAPIToken[] } | NewAPIToken[] }
    const items = Array.isArray(data.data) ? data.data : (data.data?.items || [])
    for (const t of items) {
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
    const data = await res.json() as { success?: boolean; message?: string; data?: { key?: string; id?: number } | string }
    if (data.success === false) {
      console.warn(`[newapi] Token creation rejected for group ${groupName}: ${data.message}`)
      return null
    }
    const key = typeof data.data === 'object' ? data.data?.key : data.data
    return key || null
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
    // Step 1: Fetch pricing data
    const pricingRes = await fetch(`${endpoint}/api/pricing`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    })

    if (!pricingRes.ok) {
      errors.push(`Pricing API returned ${pricingRes.status}`)
      return { models, errors }
    }

    const pricingRaw = await pricingRes.json() as any

    // Detect yunwu-style format: data is object with model_info key
    let pricingData: NewAPIPricingResponse
    if (pricingRaw.data && !Array.isArray(pricingRaw.data) && pricingRaw.data.model_info) {
      console.log(`[newapi] Detected yunwu-style pricing format, normalizing...`)
      pricingData = normalizeYunwuPricing(pricingRaw as YunwuPricingResponse)
    } else {
      pricingData = pricingRaw as NewAPIPricingResponse
    }

    if (!pricingData.data || !Array.isArray(pricingData.data)) {
      errors.push(`Unexpected pricing format: missing data array`)
      return { models, errors }
    }

    const groupRatioMap = pricingData.group_ratio || {}
    console.log(`[newapi] Got ${pricingData.data.length} models, ${Object.keys(groupRatioMap).length} groups`)

    // Step 2: Fetch existing AIGate tokens and create missing ones
    const existingTokens = await fetchExistingTokens(endpoint, headers)

    // Step 3: Get models.dev pricing for fallback
    const modelsDevPricing = await getModelsDevPricing()

    // Step 4: Collect all unique non-blacklisted groups
    const neededGroups = new Set<string>()
    for (const entry of pricingData.data) {
      if (!entry.model_name || !entry.enable_groups) continue
      for (const group of entry.enable_groups) {
        if (!group) continue
        const isBlacklisted = blackGroupMatch.some(
          (pattern) => group.toLowerCase().includes(pattern.toLowerCase()),
        )
        if (!isBlacklisted) neededGroups.add(group)
      }
    }

    // Step 5: Get or create tokens for all needed groups (sequential to avoid overloading upstream)
    const groupTokens = new Map<string, string | null>()
    for (const groupName of neededGroups) {
      const existing = existingTokens.get(groupName)
      if (existing) {
        groupTokens.set(groupName, existing.key)
      } else {
        const token = await createGroupToken(endpoint, headers, groupName)
        groupTokens.set(groupName, token)
        if (!token) errors.push(`Failed to get token for group: ${groupName}`)
      }
    }

    // Step 6: Process each model × group combination
    for (const entry of pricingData.data) {
      if (!entry.model_name || !entry.enable_groups) continue

      for (const groupName of entry.enable_groups) {
        if (!groupName) continue

        const isBlacklisted = blackGroupMatch.some(
          (pattern) => groupName.toLowerCase().includes(pattern.toLowerCase()),
        )
        if (isBlacklisted) continue

        const groupToken = groupTokens.get(groupName)
        if (!groupToken) continue

        const canonical = canonicalize(entry.model_name)
        const grpRatio = groupRatioMap[groupName] ?? 1

        let priceInput: number | null = null
        let priceOutput: number | null = null
        let priceSource: 'provider_api' | 'models_dev' | 'unknown' = 'unknown'

        if (entry.model_price > 0) {
          const basePrice = entry.model_price * grpRatio * BASE_FACTOR * costMultiplier
          priceInput = basePrice
          priceOutput = basePrice * (entry.completion_ratio ?? 1)
          priceSource = 'provider_api'
        } else if (entry.model_ratio > 0) {
          // model_ratio based pricing: ratio * group_ratio * BASE_FACTOR
          const basePrice = entry.model_ratio * grpRatio * BASE_FACTOR * costMultiplier
          priceInput = basePrice
          priceOutput = basePrice * (entry.completion_ratio ?? 1)
          priceSource = 'provider_api'
        } else if (costMultiplier === 0) {
          priceInput = 0
          priceOutput = 0
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
          groupName,
          apiKey: `sk-${groupToken}`,
          priceInput: priceInput !== null ? Math.round(priceInput * 1e5) / 1e5 : null,
          priceOutput: priceOutput !== null ? Math.round(priceOutput * 1e5) / 1e5 : null,
          priceSource,
        })
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  return { models, errors }
}

