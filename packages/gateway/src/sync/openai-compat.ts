// OpenAI-compatible provider sync via /models endpoint

import { canonicalize } from './canonicalize'
import { getModelsDevPricing, lookupPrice } from './models-dev'
import type { SyncedModel } from './newapi'

interface OpenAIModel {
  id: string
  object: string
  created?: number
  owned_by?: string
  // OpenRouter-style pricing
  pricing?: {
    prompt?: string  // $/token as string
    completion?: string
  }
}

export async function syncOpenAICompatibleProvider(
  endpoint: string,
  apiKey: string,
  costMultiplier: number,
): Promise<{ models: SyncedModel[]; errors: string[] }> {
  const errors: string[] = []
  const models: SyncedModel[] = []

  try {
    const url = `${endpoint}/v1/models`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      errors.push(`/models returned ${res.status}`)
      return { models, errors }
    }

    const data = (await res.json()) as { data?: OpenAIModel[] }
    const modelList = data.data || []

    // Get models.dev pricing for fallback
    const modelsDevPricing = await getModelsDevPricing()

    for (const model of modelList) {
      const canonical = canonicalize(model.id)
      let priceInput: number | null = null
      let priceOutput: number | null = null
      let priceSource: 'provider_api' | 'models_dev' | 'unknown' = 'unknown'

      // Try OpenRouter-style pricing ($/token as string)
      if (model.pricing?.prompt && model.pricing?.completion) {
        const promptPrice = parseFloat(model.pricing.prompt)
        const completionPrice = parseFloat(model.pricing.completion)
        if (!isNaN(promptPrice) && !isNaN(completionPrice)) {
          // Convert from $/token to $/1M tokens
          priceInput = promptPrice * 1_000_000 * costMultiplier
          priceOutput = completionPrice * 1_000_000 * costMultiplier
          priceSource = 'provider_api'
        }
      }

      // Fallback to models.dev
      if (priceSource === 'unknown') {
        const devPrice = lookupPrice(modelsDevPricing, model.id)
        if (devPrice) {
          priceInput = devPrice.input * costMultiplier
          priceOutput = devPrice.output * costMultiplier
          priceSource = 'models_dev'
        }
      }

      models.push({
        canonical,
        upstream: model.id,
        groupName: null,
        apiKey: null, // OpenAI-compatible uses provider-level key
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
