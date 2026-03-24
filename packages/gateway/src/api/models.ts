import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db'

const app = new Hono()

// GET /api/models — all auto-discovered models across providers
app.get('/', async (c) => {
  const rows = await db
    .select({
      deploymentId: schema.modelDeployments.deploymentId,
      providerId: schema.modelDeployments.providerId,
      canonical: schema.modelDeployments.canonical,
      upstream: schema.modelDeployments.upstream,
      groupName: schema.modelDeployments.groupName,
      priceInput: schema.modelDeployments.priceInput,
      priceOutput: schema.modelDeployments.priceOutput,
      priceSource: schema.modelDeployments.priceSource,
      manualPriceInput: schema.modelDeployments.manualPriceInput,
      manualPriceOutput: schema.modelDeployments.manualPriceOutput,
      status: schema.modelDeployments.status,
      blacklisted: schema.modelDeployments.blacklisted,
      lastSyncAt: schema.modelDeployments.lastSyncAt,
    })
    .from(schema.modelDeployments)

  return c.json(rows)
})

// PUT /api/models/:deploymentId/blacklist — toggle deployment blacklist
app.put('/:deploymentId/blacklist', async (c) => {
  const deploymentId = c.req.param('deploymentId')
  const body = await c.req.json<{ blacklisted: boolean }>()

  await db
    .update(schema.modelDeployments)
    .set({ blacklisted: body.blacklisted ? true : false })
    .where(eq(schema.modelDeployments.deploymentId, deploymentId))

  return c.json({ ok: true })
})

// PUT /api/models/:deploymentId/price — manual price override
app.put('/:deploymentId/price', async (c) => {
  const deploymentId = c.req.param('deploymentId')
  const body = await c.req.json()

  await db
    .update(schema.modelDeployments)
    .set({
      manualPriceInput: body.priceInput ?? null,
      manualPriceOutput: body.priceOutput ?? null,
    })
    .where(eq(schema.modelDeployments.deploymentId, deploymentId))

  return c.json({ ok: true })
})

// GET /api/models/preferences — all model preferences (favorite/blacklist)
app.get('/preferences', async (c) => {
  const rows = await db
    .select()
    .from(schema.modelPreferences)
  return c.json(rows)
})

// PUT /api/models/preferences — batch set/clear preferences
app.put('/preferences', async (c) => {
  const body = await c.req.json<{ canonicals: string[]; preference: 'favorite' | 'blacklist' | null }>()
  const { canonicals, preference } = body

  if (!Array.isArray(canonicals) || canonicals.length === 0) {
    return c.json({ error: { message: 'canonicals must be a non-empty array' } }, 400)
  }

  if (preference === null) {
    await db.delete(schema.modelPreferences)
      .where(inArray(schema.modelPreferences.canonical, canonicals))
  } else {
    for (const canonical of canonicals) {
      await db.insert(schema.modelPreferences)
        .values({ canonical, preference, updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: schema.modelPreferences.canonical,
          set: { preference, updatedAt: new Date().toISOString() },
        })
    }
  }

  return c.json({ ok: true })
})

export default app
