import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { db, schema } from '../db'
import { nanoid } from '../utils'
import { getModelsDevProviderList } from '../sync/models-dev'
import {
  getSpend,
  getInFlight,
  getReservedUsd,
  effectiveLimit,
  nextResetAt,
  invalidateSpendCache,
  RESERVE_OUTPUT_TOKENS,
} from '../router/cost-limit'

const app = new Hono()

/**
 * Coerce a Cost Limit from the wire. Empty string / null / undefined all mean
 * "unlimited"; a non-numeric or negative value is rejected as unlimited rather
 * than silently becoming 0, which would shut the Provider off entirely.
 */
function normalizeLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

// GET /api/providers
app.get('/', async (c) => {
  const rows = await db.select().from(schema.providers)

  return c.json(
    await Promise.all(
      rows.map(async (r) => {
        const spend = await getSpend(r.id)
        const inFlight = getInFlight(r.id)
        // The exact USD withheld by the requests in flight — each reserved from
        // its own Deployment's rates, so this needs no per-model estimate.
        const reservedUsd = getReservedUsd(r.id)

        return {
          ...r,
          blackGroupMatch: r.blackGroupMatch ? JSON.parse(r.blackGroupMatch) : [],
          modelsDevSlug: r.modelsDevSlug ?? null,
          spend: {
            daily: spend.daily,
            monthly: spend.monthly,
            inFlight,
            reservedUsd,
            reserveOutputTokens: RESERVE_OUTPUT_TOKENS,
            effectiveDailyLimitUsd: effectiveLimit(r.dailyCostLimitUsd, reservedUsd),
            effectiveMonthlyLimitUsd: effectiveLimit(r.monthlyCostLimitUsd, reservedUsd),
            dailyResetAt: nextResetAt('daily'),
            monthlyResetAt: nextResetAt('monthly'),
          },
        }
      }),
    ),
  )
})

// GET /api/providers/models-dev-providers — list models.dev provider slugs for dropdown
app.get('/models-dev-providers', async (c) => {
  const list = await getModelsDevProviderList()
  return c.json(list)
})

// POST /api/providers
app.post('/', async (c) => {
  const body = await c.req.json()
  const id = body.id || nanoid(8)

  await db.insert(schema.providers).values({
    id,
    type: body.type,
    apiFormat: body.apiFormat ?? 'openai',
    endpoint: body.endpoint.replace(/\/$/, ''),
    apiKey: body.apiKey || '',
    costMultiplier: body.costMultiplier ?? 1.0,
    newApiUserId: body.newApiUserId ?? null,
    accessToken: body.accessToken ?? null,
    modelsDevSlug: body.modelsDevSlug ?? null,
    dailyCostLimitUsd: normalizeLimit(body.dailyCostLimitUsd),
    monthlyCostLimitUsd: normalizeLimit(body.monthlyCostLimitUsd),
    blackGroupMatch: body.blackGroupMatch ? JSON.stringify(body.blackGroupMatch) : null,
    syncEnabled: body.syncEnabled ?? true,
    syncIntervalMinutes: body.syncIntervalMinutes ?? 60,
  })

  return c.json({ id }, 201)
})

// PUT /api/providers/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()

  const updates: Record<string, unknown> = {
    type: body.type,
    apiFormat: body.apiFormat ?? 'openai',
    endpoint: body.endpoint.replace(/\/$/, ''),
    costMultiplier: body.costMultiplier ?? 1.0,
    syncEnabled: body.syncEnabled ?? true,
    syncIntervalMinutes: body.syncIntervalMinutes ?? 60,
  }

  // Only update fields the frontend explicitly sent. Frontends omit unchanged
  // fields (especially secrets and credentials) and we must not clobber them.
  if ('apiKey' in body) updates.apiKey = body.apiKey || ''
  if ('accessToken' in body) updates.accessToken = body.accessToken ?? null
  if ('newApiUserId' in body) updates.newApiUserId = body.newApiUserId ?? null
  if ('modelsDevSlug' in body) updates.modelsDevSlug = body.modelsDevSlug ?? null
  // A Cost Limit legitimately has "no value" as a meaning: null = unlimited.
  // It goes through the same present-in-body guard as the secrets so that an
  // omitted field is left alone, but unlike them an explicitly sent empty
  // value must clear the limit rather than be ignored.
  if ('dailyCostLimitUsd' in body) updates.dailyCostLimitUsd = normalizeLimit(body.dailyCostLimitUsd)
  if ('monthlyCostLimitUsd' in body) updates.monthlyCostLimitUsd = normalizeLimit(body.monthlyCostLimitUsd)
  if ('blackGroupMatch' in body) {
    updates.blackGroupMatch = body.blackGroupMatch
      ? JSON.stringify(body.blackGroupMatch)
      : null
  }

  await db
    .update(schema.providers)
    .set(updates)
    .where(eq(schema.providers.id, id))

  // A raised or lowered limit must take effect on the next request, not after
  // the cached spend happens to expire.
  invalidateSpendCache(id)

  return c.json({ ok: true })
})

// DELETE /api/providers/:id
app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await db.delete(schema.providers).where(eq(schema.providers.id, id))
  // Deleting the Provider cascades away its provider_daily_spend rows, but the
  // spend cache is keyed by UTC day and would otherwise keep serving the old
  // total. Recreating the same Provider id — which the create API allows —
  // would then start out already over its limit and 503 until 00:00 UTC.
  invalidateSpendCache(id)
  return c.json({ ok: true })
})

// POST /api/providers/:id/sync — trigger manual sync
app.post('/:id/sync', async (c) => {
  const id = c.req.param('id')
  const [provider] = await db
    .select()
    .from(schema.providers)
    .where(eq(schema.providers.id, id))
    .limit(1)

  if (!provider) return c.json({ error: { message: 'Provider not found' } }, 404)

  // Import dynamically to avoid circular deps
  const { syncProvider } = await import('../sync/engine')
  const result = await syncProvider(provider)

  return c.json(result)
})

// GET /api/providers/:id/sync-history
app.get('/:id/sync-history', async (c) => {
  const id = c.req.param('id')
  const rows = await db
    .select()
    .from(schema.syncLogs)
    .where(eq(schema.syncLogs.providerId, id))
    .orderBy(desc(schema.syncLogs.createdAt))
    .limit(20)

  return c.json(
    rows.map((r) => ({
      ...r,
      errors: r.errors ? JSON.parse(r.errors) : [],
    })),
  )
})

export default app
