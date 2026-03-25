// models.dev pricing fallback

interface ModelsDevProvider {
  id: string
  name: string
  models: Record<string, ModelsDevModel>
}

interface ModelsDevModel {
  id: string
  name: string
  cost?: {
    input?: number   // $/1M tokens
    output?: number  // $/1M tokens
  }
}

interface CachedData {
  pricing: Map<string, { input: number; output: number }>
  providers: Record<string, ModelsDevProvider>
}

let cache: CachedData | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

async function fetchModelsDevData(): Promise<CachedData> {
  const now = Date.now()
  if (cache && now - cacheTimestamp < CACHE_TTL_MS) {
    return cache
  }

  try {
    const response = await fetch('https://models.dev/api.json', {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`models.dev returned ${response.status}`)

    const data = (await response.json()) as Record<string, ModelsDevProvider>
    const map = new Map<string, { input: number; output: number }>()

    // Data is { [providerId]: { models: { [modelId]: { cost: { input, output } } } } }
    for (const provider of Object.values(data)) {
      if (!provider.models || typeof provider.models !== 'object') continue
      for (const [modelId, model] of Object.entries(provider.models)) {
        if (model.cost?.input !== undefined && model.cost?.output !== undefined) {
          map.set(modelId.toLowerCase(), {
            input: model.cost.input,
            output: model.cost.output,
          })
          // Also store with provider prefix for broader matching
          if (provider.id) {
            map.set(`${provider.id}/${modelId}`.toLowerCase(), {
              input: model.cost.input,
              output: model.cost.output,
            })
          }
        }
      }
    }

    cache = { pricing: map, providers: data }
    cacheTimestamp = now
    console.log(`[models.dev] Cached pricing for ${map.size} models`)
    return cache
  } catch (error) {
    console.warn('[models.dev] Failed to fetch pricing:', error instanceof Error ? error.message : error)
    return cache ?? { pricing: new Map(), providers: {} }
  }
}

export async function getModelsDevPricing(): Promise<Map<string, { input: number; output: number }>> {
  const data = await fetchModelsDevData()
  return data.pricing
}

export function lookupPrice(
  pricing: Map<string, { input: number; output: number }>,
  modelName: string,
): { input: number; output: number } | null {
  const lower = modelName.toLowerCase()

  // Direct match
  if (pricing.has(lower)) return pricing.get(lower)!

  // Try without provider prefix
  const slashIdx = lower.indexOf('/')
  if (slashIdx !== -1) {
    const stripped = lower.slice(slashIdx + 1)
    if (pricing.has(stripped)) return pricing.get(stripped)!
  }

  // Try fuzzy: startsWith
  for (const [key, value] of pricing) {
    if (key.startsWith(lower) || lower.startsWith(key)) return value
  }

  return null
}

/**
 * Extract models from models.dev matching a provider slug prefix.
 * e.g. slug="minimax" returns all models keyed as "minimax/..." in the pricing map.
 */
export function getModelsFromModelsDevBySlug(
  pricing: Map<string, { input: number; output: number }>,
  slug: string,
): { id: string; input: number; output: number }[] {
  const models: { id: string; input: number; output: number }[] = []
  const seen = new Set<string>()
  const prefix = `${slug.toLowerCase()}/`

  for (const [key, price] of pricing) {
    if (!key.startsWith(prefix)) continue
    const modelId = key.slice(prefix.length)
    if (seen.has(modelId)) continue
    seen.add(modelId)
    models.push({ id: modelId, input: price.input, output: price.output })
  }

  return models
}

/**
 * Returns the list of provider slugs from models.dev for the UI dropdown.
 */
export async function getModelsDevProviderList(): Promise<
  { id: string; name: string; modelCount: number }[]
> {
  const data = await fetchModelsDevData()
  const result: { id: string; name: string; modelCount: number }[] = []

  for (const provider of Object.values(data.providers)) {
    if (!provider.models || typeof provider.models !== 'object') continue
    const modelCount = Object.keys(provider.models).length
    if (modelCount === 0) continue
    result.push({
      id: provider.id,
      name: provider.name || provider.id,
      modelCount,
    })
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}
