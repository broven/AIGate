import { Hono } from 'hono'
import { sql, eq, and } from 'drizzle-orm'
import { db, schema } from '../db'
import { nanoid, generateApiKey } from '../utils'

const app = new Hono()

// GET /api/keys
app.get('/', async (c) => {
  const rows = await db.select({
    id: schema.gatewayKeys.id,
    name: schema.gatewayKeys.name,
    keyPlain: schema.gatewayKeys.keyPlain,
    createdAt: schema.gatewayKeys.createdAt,
  }).from(schema.gatewayKeys)

  return c.json(rows)
})

// POST /api/keys
app.post('/', async (c) => {
  const body = await c.req.json()
  const name = body.name

  if (!name) {
    return c.json({ error: { message: 'Name is required' } }, 400)
  }

  const rawKey = generateApiKey()
  const id = nanoid(12)

  await db.insert(schema.gatewayKeys).values({
    id,
    name,
    keyPlain: rawKey,
  })

  return c.json({ id, name, keyPlain: rawKey }, 201)
})

// DELETE /api/keys/:id
app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await db.delete(schema.gatewayKeys).where(eq(schema.gatewayKeys.id, id))
  return c.json({ ok: true })
})

// GET /api/keys/stats — aggregate usage for all keys
app.get('/stats', async (c) => {
  const rows = await db
    .select({
      keyId: schema.gatewayKeys.id,
      requests: sql<number>`coalesce(sum(${schema.dailyUsage.requestCount}), 0)`,
      inputTokens: sql<number>`coalesce(sum(${schema.dailyUsage.totalInputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${schema.dailyUsage.totalOutputTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${schema.dailyUsage.totalCost}), 0)`,
    })
    .from(schema.gatewayKeys)
    .leftJoin(schema.dailyUsage, eq(schema.dailyUsage.gatewayKey, schema.gatewayKeys.name))
    .groupBy(schema.gatewayKeys.id)

  const result: Record<string, { requests: number; tokens: number; cost: number }> = {}
  for (const row of rows) {
    result[row.keyId] = {
      requests: row.requests,
      tokens: row.inputTokens + row.outputTokens,
      cost: row.cost,
    }
  }
  return c.json(result)
})

// GET /api/keys/:id/usage
app.get('/:id/usage', async (c) => {
  const id = c.req.param('id')

  // Look up key name
  const [keyRow] = await db
    .select({ name: schema.gatewayKeys.name })
    .from(schema.gatewayKeys)
    .where(eq(schema.gatewayKeys.id, id))
    .limit(1)

  if (!keyRow) {
    return c.json({ error: { message: 'Key not found' } }, 404)
  }

  // Per-model aggregation
  const byModel = await db
    .select({
      model: schema.dailyUsage.model,
      requests: sql<number>`coalesce(sum(request_count), 0)`,
      inputTokens: sql<number>`coalesce(sum(total_input_tokens), 0)`,
      outputTokens: sql<number>`coalesce(sum(total_output_tokens), 0)`,
      cost: sql<number>`coalesce(sum(total_cost), 0)`,
    })
    .from(schema.dailyUsage)
    .where(eq(schema.dailyUsage.gatewayKey, keyRow.name))
    .groupBy(schema.dailyUsage.model)

  // Per-day aggregation (last 30 days)
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const since = thirtyDaysAgo.toISOString().slice(0, 10)

  const byDay = await db
    .select({
      date: schema.dailyUsage.date,
      requests: sql<number>`coalesce(sum(request_count), 0)`,
      cost: sql<number>`coalesce(sum(total_cost), 0)`,
    })
    .from(schema.dailyUsage)
    .where(
      and(
        eq(schema.dailyUsage.gatewayKey, keyRow.name),
        sql`${schema.dailyUsage.date} >= ${since}`,
      ),
    )
    .groupBy(schema.dailyUsage.date)
    .orderBy(schema.dailyUsage.date)

  return c.json({ byModel, byDay })
})

export default app
