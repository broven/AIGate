import { displayName } from './canonicalize'

// models.dev pricing source.
//
// Prices are indexed **per provider**: the same model id (e.g. `glm-5.2`) is
// offered by dozens of providers at different prices, so a flat id -> price map
// silently resolves to whichever provider happened to be iterated last.
// Every lookup therefore requires a provider slug; without one we return null
// rather than guessing.

interface ModelsDevProvider {
  id: string
  name: string
  models: Record<string, ModelsDevModel>
}

interface ModelsDevModel {
  id: string
  name: string
  cost?: {
    input?: number       // $/1M tokens
    output?: number      // $/1M tokens
    cache_read?: number  // $/1M tokens
    cache_write?: number // $/1M tokens
  }
}

export interface ModelPrice {
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
}

/** providerSlug -> (lowercased model id -> price) */
export type ModelsDevPricing = Map<string, Map<string, ModelPrice>>

interface CachedData {
  pricing: ModelsDevPricing
  providers: Record<string, ModelsDevProvider>
}

let cache: CachedData | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Build the provider-scoped price index from a raw models.dev api.json payload. */
export function buildPricingIndex(data: Record<string, ModelsDevProvider>): ModelsDevPricing {
  const index: ModelsDevPricing = new Map()

  for (const [providerKey, provider] of Object.entries(data)) {
    if (!provider || !provider.models || typeof provider.models !== 'object') continue
    const slug = (provider.id || providerKey).toLowerCase()
    let byModel = index.get(slug)
    if (!byModel) {
      byModel = new Map()
      index.set(slug, byModel)
    }
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model?.cost?.input === undefined || model.cost.output === undefined) continue
      byModel.set(modelId.toLowerCase(), {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cache_read ?? null,
        cacheWrite: model.cost.cache_write ?? null,
      })
    }
  }

  return index
}

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
    const pricing = buildPricingIndex(data)

    cache = { pricing, providers: data }
    cacheTimestamp = now
    const modelCount = [...pricing.values()].reduce((sum, m) => sum + m.size, 0)
    console.log(`[models.dev] Cached pricing for ${modelCount} models across ${pricing.size} providers`)
    return cache
  } catch (error) {
    console.warn('[models.dev] Failed to fetch pricing:', error instanceof Error ? error.message : error)
    return cache ?? { pricing: new Map(), providers: {} }
  }
}

export async function getModelsDevPricing(): Promise<ModelsDevPricing> {
  const data = await fetchModelsDevData()
  return data.pricing
}

/** Test seam: inject a pricing index without touching the network. */
export function __setModelsDevCacheForTests(data: Record<string, ModelsDevProvider>): void {
  cache = { pricing: buildPricingIndex(data), providers: data }
  cacheTimestamp = Date.now()
}

/**
 * Look up a model price. `providerSlug` is mandatory in practice: without a
 * provider context we do NOT fall back to fuzzy or bare-id matching, because a
 * wrong-but-present price is worse than no price (it silently misroutes and
 * mis-bills). Callers that have no slug get `null` and the deployment ends up
 * unpriced, which the router refuses to schedule.
 */
export function lookupPrice(
  pricing: ModelsDevPricing,
  modelId: string,
  providerSlug?: string | null,
): ModelPrice | null {
  if (!providerSlug) return null
  const byModel = pricing.get(providerSlug.toLowerCase())
  if (!byModel) return null

  const lower = modelId.toLowerCase()
  const direct = byModel.get(lower)
  if (direct) return direct

  // `openai/gpt-5` style ids: strip the redundant provider prefix, still exact.
  const slashIdx = lower.indexOf('/')
  if (slashIdx !== -1) {
    const stripped = lower.slice(slashIdx + 1)
    const hit = byModel.get(stripped)
    if (hit) return hit
  }

  return null
}

/**
 * Extract every model models.dev lists under a provider slug.
 */
export function getModelsFromModelsDevBySlug(
  pricing: ModelsDevPricing,
  slug: string,
): ({ id: string } & ModelPrice)[] {
  const byModel = pricing.get(slug.toLowerCase())
  if (!byModel) return []
  return [...byModel.entries()].map(([id, price]) => ({ id, ...price }))
}

/**
 * Map a canonical model name to the models.dev slug of its **first-party**
 * provider — the vendor that actually trains and hosts it. This is the baseline
 * "Saved vs Direct" is measured against.
 *
 * Unrecognized prefixes return null on purpose: an approximate baseline would
 * make the savings number look authoritative while being fiction.
 */
const FIRST_PARTY_PREFIXES: Array<[RegExp, string]> = [
  [/^claude[-.]/, 'anthropic'],
  [/^(gpt|chatgpt)[-.]/, 'openai'],
  [/^o[1-9](-|$)/, 'openai'],
  [/^gemini[-.]/, 'google'],
  [/^gemma[-.]/, 'google'],
  [/^deepseek[-.]/, 'deepseek'],
  [/^grok[-.]/, 'xai'],
  [/^mistral[-.]/, 'mistral'],
  [/^magistral[-.]/, 'mistral'],
  [/^codestral[-.]/, 'mistral'],
  [/^command[-.]/, 'cohere'],
  [/^llama[-.]/, 'meta'],
  [/^qwen[-.\d]/, 'alibaba'],
  [/^glm[-.]/, 'zhipuai'],
  [/^kimi[-.]/, 'moonshotai'],
  [/^moonshot[-.]/, 'moonshotai'],
]

export function resolveFirstPartyProvider(canonical: string): string | null {
  const lower = canonical.toLowerCase()
  for (const [pattern, slug] of FIRST_PARTY_PREFIXES) {
    if (pattern.test(lower)) return slug
  }
  return null
}

/**
 * The official list price of a canonical model at its first-party provider.
 * Returns null when the first party can't be resolved, isn't in models.dev, or
 * doesn't list this exact model id.
 */
export function lookupFirstPartyPrice(
  pricing: ModelsDevPricing,
  canonical: string,
): ModelPrice | null {
  const slug = resolveFirstPartyProvider(canonical)
  if (!slug) return null
  // Canonicalization rewrites version dots to dashes ("gemini-2.5-pro" ->
  // "gemini-2-5-pro"); models.dev keeps the dots. Try both spellings of the
  // same id — still exact matching, just undoing our own normalization.
  return lookupPrice(pricing, canonical, slug) ?? lookupPrice(pricing, displayName(canonical), slug)
}

/**
 * Returns the list of provider slugs from models.dev for the UI dropdown.
 */
export async function getModelsDevProviderList(): Promise<
  { id: string; name: string; modelCount: number }[]
> {
  const data = await fetchModelsDevData()
  const result: { id: string; name: string; modelCount: number }[] = []

  for (const [key, provider] of Object.entries(data.providers)) {
    if (!provider?.models || typeof provider.models !== 'object') continue
    const modelCount = Object.keys(provider.models).length
    if (modelCount === 0) continue
    result.push({
      id: provider.id || key,
      name: provider.name || provider.id || key,
      modelCount,
    })
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}
