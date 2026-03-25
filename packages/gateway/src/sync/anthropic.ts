// Anthropic native provider sync
// 1. Try /v1/models API to get model list
// 2. Pricing always from models.dev (Anthropic API doesn't expose pricing)
// 3. If /v1/models fails, fall back to models.dev for both list and pricing

import { canonicalize } from './canonicalize'
import { getModelsDevPricing, lookupPrice, getModelsFromModelsDevBySlug } from './models-dev'
import type { SyncedModel } from './newapi'

interface AnthropicModel {
  id: string
  type: 'model'
  display_name: string
  created_at: string
}

interface AnthropicModelsResponse {
  data: AnthropicModel[]
  has_more: boolean
  last_id: string | null
}

async function fetchAnthropicModels(
  endpoint: string,
  apiKey: string,
): Promise<AnthropicModel[]> {
  const models: AnthropicModel[] = []
  let afterId: string | undefined

  // Paginate through all models
  while (true) {
    const url = new URL(`${endpoint}/v1/models`)
    url.searchParams.set('limit', '1000')
    if (afterId) url.searchParams.set('after_id', afterId)

    const res = await fetch(url.toString(), {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      throw new Error(`/v1/models returned ${res.status}`)
    }

    const data = (await res.json()) as AnthropicModelsResponse
    models.push(...data.data)

    if (!data.has_more || !data.last_id) break
    afterId = data.last_id
  }

  return models
}

export async function syncAnthropicProvider(
  endpoint: string,
  apiKey: string,
  costMultiplier: number,
  modelsDevSlug?: string,
): Promise<{ models: SyncedModel[]; errors: string[] }> {
  const errors: string[] = []
  const models: SyncedModel[] = []
  const slug = modelsDevSlug || 'anthropic'
  const modelsDevPricing = await getModelsDevPricing()

  let modelIds: string[]

  // Strategy 1: Try Anthropic /v1/models API
  try {
    const anthropicModels = await fetchAnthropicModels(endpoint, apiKey)
    modelIds = anthropicModels.map((m) => m.id)
    console.log(`[sync:anthropic] Fetched ${modelIds.length} models from /v1/models`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`/v1/models failed (${msg}), falling back to models.dev [${slug}]`)
    console.warn(`[sync:anthropic] /v1/models failed: ${msg}, using models.dev fallback [${slug}]`)

    // Strategy 2: Fall back to models.dev
    const devModels = getModelsFromModelsDevBySlug(modelsDevPricing, slug)
    modelIds = devModels.map((m) => m.id)
    console.log(`[sync:anthropic] Found ${modelIds.length} models from models.dev [${slug}]`)
  }

  // Resolve pricing for each model from models.dev
  for (const modelId of modelIds) {
    const canonical = canonicalize(modelId)
    let priceInput: number | null = null
    let priceOutput: number | null = null
    let priceSource: 'provider_api' | 'models_dev' | 'unknown' = 'unknown'

    const devPrice = lookupPrice(modelsDevPricing, modelId)
    if (devPrice) {
      priceInput = devPrice.input * costMultiplier
      priceOutput = devPrice.output * costMultiplier
      priceSource = 'models_dev'
    }

    models.push({
      canonical,
      upstream: modelId,
      groupName: null,
      apiKey: null,
      priceInput,
      priceOutput,
      priceSource,
    })
  }

  return { models, errors }
}
