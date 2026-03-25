// OpenAI-compatible provider sync via /models endpoint

import { canonicalize } from './canonicalize'
import { getModelsDevPricing, lookupPrice, getModelsFromModelsDevBySlug } from './models-dev'
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
  modelsDevSlug?: string,
): Promise<{ models: SyncedModel[]; errors: string[] }> {
  const errors: string[] = []
  const models: SyncedModel[] = []

  // Get models.dev pricing for fallback
  const modelsDevPricing = await getModelsDevPricing()

  let modelList: OpenAIModel[] = []
  let usedModelsDev = false

  // Strategy 1: Try /v1/models API
  try {
    const url = `${endpoint}/v1/models`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      throw new Error(`/models returned ${res.status}`)
    }

    const data = (await res.json()) as { data?: OpenAIModel[] }
    modelList = data.data || []
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)

    // Strategy 2: Fall back to models.dev if slug is configured
    if (modelsDevSlug) {
      errors.push(`/v1/models failed (${msg}), falling back to models.dev [${modelsDevSlug}]`)
      console.warn(`[sync:openai-compat] /v1/models failed: ${msg}, using models.dev fallback [${modelsDevSlug}]`)

      const devModels = getModelsFromModelsDevBySlug(modelsDevPricing, modelsDevSlug)
      console.log(`[sync:openai-compat] Found ${devModels.length} models from models.dev [${modelsDevSlug}]`)

      for (const m of devModels) {
        const canonical = canonicalize(m.id)
        models.push({
          canonical,
          upstream: m.id,
          groupName: null,
          apiKey: null,
          priceInput: m.input * costMultiplier,
          priceOutput: m.output * costMultiplier,
          priceSource: 'models_dev',
        })
      }
      usedModelsDev = true
    } else {
      errors.push(`/v1/models failed (${msg})`)
    }
  }

  // Process models from /v1/models API (only if we didn't fall back to models.dev)
  if (!usedModelsDev) {
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
  }

  return { models, errors }
}
