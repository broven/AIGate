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

let cache: Map<string, { input: number; output: number }> | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export async function getModelsDevPricing(): Promise<Map<string, { input: number; output: number }>> {
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

    cache = map
    cacheTimestamp = now
    console.log(`[models.dev] Cached pricing for ${map.size} models`)
    return map
  } catch (error) {
    console.warn('[models.dev] Failed to fetch pricing:', error instanceof Error ? error.message : error)
    return cache ?? new Map()
  }
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
