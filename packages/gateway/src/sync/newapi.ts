// NewAPI provider sync — fetches pricing and groups from NewAPI-style providers

import { canonicalize } from './canonicalize'
import { getModelsDevPricing, lookupPrice } from './models-dev'

interface NewAPIPricing {
  model_group: string
  model_name: string
  model_price: number
  group_ratio: number
  token_group: string
}

interface NewAPIRatioConfig {
  [model: string]: number // completion_ratio
}

// Base factor from existing axonhub-bridge logic
const BASE_FACTOR = 500000

export interface SyncedModel {
  canonical: string
  upstream: string
  groupName: string | null
  priceInput: number | null
  priceOutput: number | null
  priceSource: 'provider_api' | 'models_dev' | 'unknown'
}

export async function syncNewAPIProvider(
  endpoint: string,
  apiKey: string,
  costMultiplier: number,
  blackGroupMatch: string[],
  accessToken?: string,
): Promise<{ models: SyncedModel[]; errors: string[] }> {
  const errors: string[] = []
  const models: SyncedModel[] = []

  try {
    // Fetch pricing data
    const pricingUrl = `${endpoint}/api/pricing`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken || apiKey}`,
    }

    const pricingRes = await fetch(pricingUrl, {
      headers,
      signal: AbortSignal.timeout(30_000),
    })

    if (!pricingRes.ok) {
      errors.push(`Pricing API returned ${pricingRes.status}`)
      return { models, errors }
    }

    const pricingData = (await pricingRes.json()) as {
      data?: NewAPIPricing[]
    }

    const pricingEntries = pricingData.data || []

    // Fetch ratio config for completion ratios
    let ratioConfig: NewAPIRatioConfig = {}
    try {
      const ratioRes = await fetch(`${endpoint}/api/ratio_config`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      if (ratioRes.ok) {
        ratioConfig = (await ratioRes.json()) as NewAPIRatioConfig
      }
    } catch {
      errors.push('Failed to fetch ratio_config')
    }

    // Get models.dev pricing for fallback
    const modelsDevPricing = await getModelsDevPricing()

    // Group entries by model+group, filter blacklisted groups
    for (const entry of pricingEntries) {
      // Apply blackGroupMatch filter
      const isBlacklisted = blackGroupMatch.some(
        (pattern) =>
          entry.model_group.toLowerCase().includes(pattern.toLowerCase()),
      )
      if (isBlacklisted) continue

      const canonical = canonicalize(entry.model_name)

      // Calculate price from NewAPI pricing formula
      let priceInput: number | null = null
      let priceOutput: number | null = null
      let priceSource: 'provider_api' | 'models_dev' | 'unknown' = 'unknown'

      if (entry.model_price > 0) {
        const completionRatio = ratioConfig[entry.model_name] ?? 1
        const basePrice = entry.model_price * entry.group_ratio * BASE_FACTOR * costMultiplier

        priceInput = basePrice
        priceOutput = basePrice * completionRatio
        priceSource = 'provider_api'
      } else if (costMultiplier === 0) {
        // Free provider
        priceInput = 0
        priceOutput = 0
        priceSource = 'provider_api'
      } else {
        // Fallback to models.dev
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
        priceInput,
        priceOutput,
        priceSource,
      })
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  return { models, errors }
}
