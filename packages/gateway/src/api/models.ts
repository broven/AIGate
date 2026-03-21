import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
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
      lastSyncAt: schema.modelDeployments.lastSyncAt,
    })
    .from(schema.modelDeployments)

  return c.json(rows)
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

export default app
