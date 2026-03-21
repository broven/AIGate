// models.dev pricing fallback

interface ModelsDevEntry {
  name: string
  provider: string
  input_price?: number  // $/1M tokens
  output_price?: number // $/1M tokens
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

    const data = (await response.json()) as ModelsDevEntry[]
    const map = new Map<string, { input: number; output: number }>()

    for (const entry of data) {
      if (entry.input_price !== undefined && entry.output_price !== undefined) {
        // Key by lowercased name for fuzzy matching
        map.set(entry.name.toLowerCase(), {
          input: entry.input_price,
          output: entry.output_price,
        })
      }
    }

    cache = map
    cacheTimestamp = now
    return map
  } catch (error) {
    console.warn('Failed to fetch models.dev pricing:', error)
    // Return stale cache if available
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
