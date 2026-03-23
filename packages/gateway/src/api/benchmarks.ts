import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { canonicalize } from '../sync/canonicalize'

const app = new Hono()

const AA_CACHE_KEY = 'aa_models'
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

  // Check DB cache
  const cached = await db.select().from(schema.kvCache).where(eq(schema.kvCache.key, AA_CACHE_KEY)).get()
  if (cached) {
    const age = Date.now() - new Date(cached.updatedAt + 'Z').getTime()
    if (age < CACHE_TTL) {
      return JSON.parse(cached.value)
    }
  }

  try {
    const resp = await fetch('https://artificialanalysis.ai/api/v2/data/llms/models', {
      headers: { 'x-api-key': apiToken },
    })
    if (!resp.ok) {
      console.error(`[benchmarks] AA API returned ${resp.status}`)
      if (cached) return JSON.parse(cached.value)
      return []
    }
    const json = (await resp.json()) as { data?: any[] }
    const data = json.data ?? []
    if (data.length === 0) {
      // Don't cache empty responses — likely an API issue
      if (cached) return JSON.parse(cached.value)
      return []
    }

    // Upsert into DB cache
    await db.insert(schema.kvCache)
      .values({ key: AA_CACHE_KEY, value: JSON.stringify(data), updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({
        target: schema.kvCache.key,
        set: { value: JSON.stringify(data), updatedAt: new Date().toISOString() },
      })

    return data
  } catch (err) {
    console.error('[benchmarks] Failed to fetch AA data:', err)
    // Return stale DB cache if available
    if (cached) return JSON.parse(cached.value)
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

  return c.json({ dimensions: DIMENSIONS, points, configured: !!process.env.Artificial_Analysis_api_token })
})

export default app
