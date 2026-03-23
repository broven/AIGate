import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { canonicalize } from '../sync/canonicalize'

const app = new Hono()

// --- Artificial Analysis API cache ---
let aaCache: { data: any[]; fetchedAt: number } | null = null
const CACHE_TTL = 24 * 60 * 60 * 1000 // 24h

const DIMENSIONS = [
  'artificial_analysis_intelligence_index',
  'artificial_analysis_coding_index',
  'artificial_analysis_math_index',
  'mmlu_pro',
  'gpqa',
  'hle',
  'livecodebench',
  'scicode',
  'math_500',
  'aime',
  'aime_25',
  'ifbench',
  'lcr',
  'terminalbench_hard',
  'tau2',
]

async function fetchAA(): Promise<any[]> {
  const apiToken = process.env.Artificial_Analysis_api_token
  if (!apiToken) return []

  // Return cached data if still fresh
  if (aaCache && Date.now() - aaCache.fetchedAt < CACHE_TTL) {
    return aaCache.data
  }

  try {
    const resp = await fetch('https://artificialanalysis.ai/api/v2/data/llms/models', {
      headers: { 'x-api-key': apiToken },
    })
    const json = (await resp.json()) as { data?: any[] }
    const data = json.data ?? []
    aaCache = { data, fetchedAt: Date.now() }
    return data
  } catch (err) {
    console.error('[benchmarks] Failed to fetch AA data:', err)
    // Return stale cache if available
    if (aaCache) return aaCache.data
    return []
  }
}

// GET /api/benchmarks
app.get('/benchmarks', async (c) => {
  const aaModels = await fetchAA()

  // Build lookup: canonical slug -> AA model evaluations
  const aaMap = new Map<string, any>()
  for (const model of aaModels) {
    if (model.slug) {
      const canon = canonicalize(model.slug)
      aaMap.set(canon, model)
    }
  }

  // Query active deployments joined with providers
  const rows = await db
    .select({
      deploymentId: schema.modelDeployments.deploymentId,
      providerId: schema.modelDeployments.providerId,
      canonical: schema.modelDeployments.canonical,
      priceInput: schema.modelDeployments.priceInput,
      priceOutput: schema.modelDeployments.priceOutput,
      manualPriceInput: schema.modelDeployments.manualPriceInput,
      manualPriceOutput: schema.modelDeployments.manualPriceOutput,
      status: schema.modelDeployments.status,
      costMultiplier: schema.providers.costMultiplier,
    })
    .from(schema.modelDeployments)
    .innerJoin(schema.providers, eq(schema.modelDeployments.providerId, schema.providers.id))
    .where(eq(schema.modelDeployments.status, 'active'))

  const points: any[] = []

  for (const row of rows) {
    const effectiveInput = (row.manualPriceInput ?? row.priceInput ?? 0) * (row.costMultiplier ?? 1)
    const effectiveOutput = (row.manualPriceOutput ?? row.priceOutput ?? 0) * (row.costMultiplier ?? 1)

    // Skip if both prices are null/0
    if (effectiveInput === 0 && effectiveOutput === 0) continue

    const blendedPrice = (3 * effectiveInput + effectiveOutput) / 4

    // Look up AA benchmarks
    const aaModel = aaMap.get(row.canonical)
    const benchmarks: Record<string, number | null> = {}
    for (const dim of DIMENSIONS) {
      benchmarks[dim] = aaModel?.evaluations?.[dim] ?? null
    }

    points.push({
      canonical: row.canonical,
      providerId: row.providerId,
      blendedPrice,
      benchmarks,
    })
  }

  return c.json({ dimensions: DIMENSIONS, points })
})

export default app
