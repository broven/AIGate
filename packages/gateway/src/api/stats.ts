import { Hono } from 'hono'
import { sql, eq, desc, and, gte, count } from 'drizzle-orm'
import { db, schema } from '../db'
import { getCooldownState, clearCooldown } from '../router/cooldown'

const app = new Hono()

// GET /api/stats — aggregate stats
app.get('/stats', async (c) => {
  const today = new Date().toISOString().slice(0, 10)

  const [todayStats] = await db
    .select({
      requests: sql<number>`coalesce(sum(request_count), 0)`,
      cost: sql<number>`coalesce(sum(total_cost), 0)`,
      saved: sql<number>`coalesce(sum(total_saved), 0)`,
      inputTokens: sql<number>`coalesce(sum(total_input_tokens), 0)`,
      outputTokens: sql<number>`coalesce(sum(total_output_tokens), 0)`,
    })
    .from(schema.dailyUsage)
    .where(eq(schema.dailyUsage.date, today))

  const [totalStats] = await db
    .select({
      requests: sql<number>`coalesce(sum(request_count), 0)`,
      cost: sql<number>`coalesce(sum(total_cost), 0)`,
      saved: sql<number>`coalesce(sum(total_saved), 0)`,
    })
    .from(schema.dailyUsage)

  const [providerCount] = await db
    .select({ count: count() })
    .from(schema.providers)

  const [failedToday] = await db
    .select({ count: count() })
    .from(schema.requestLogs)
    .where(
      and(
        eq(schema.requestLogs.success, false),
        gte(schema.requestLogs.createdAt, today),
      ),
    )

  const successRate =
    todayStats!.requests > 0
      ? ((todayStats!.requests - (failedToday?.count ?? 0)) / todayStats!.requests) * 100
      : 100

  return c.json({
    today: {
      requests: todayStats!.requests,
      cost: todayStats!.cost,
      saved: todayStats!.saved,
      inputTokens: todayStats!.inputTokens,
      outputTokens: todayStats!.outputTokens,
      successRate,
    },
    total: {
      requests: totalStats!.requests,
      cost: totalStats!.cost,
      saved: totalStats!.saved,
    },
    activeProviders: providerCount?.count ?? 0,
  })
})

// GET /api/usage?date=YYYY-MM-DD — per-key usage breakdown
app.get('/usage', async (c) => {
  const date = c.req.query('date') || new Date().toISOString().slice(0, 10)

  const rows = await db
    .select()
    .from(schema.dailyUsage)
    .where(eq(schema.dailyUsage.date, date))

  return c.json(rows)
})

// GET /api/logs?cursor=X&limit=50 — paginated request logs
app.get('/logs', async (c) => {
  const cursor = c.req.query('cursor')
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100)
  const model = c.req.query('model')
  const key = c.req.query('key')
  const status = c.req.query('status') // 'success' | 'failed'

  let query = db
    .select()
    .from(schema.requestLogs)
    .orderBy(desc(schema.requestLogs.createdAt), desc(schema.requestLogs.id))
    .limit(limit + 1) // +1 to detect next page

  const conditions = []
  if (cursor) {
    conditions.push(sql`(${schema.requestLogs.createdAt} < ${cursor} OR (${schema.requestLogs.createdAt} = ${cursor} AND ${schema.requestLogs.id} < ${cursor}))`)
  }
  if (model) conditions.push(eq(schema.requestLogs.model, model))
  if (key) conditions.push(eq(schema.requestLogs.gatewayKey, key))
  if (status === 'success') conditions.push(eq(schema.requestLogs.success, true))
  if (status === 'failed') conditions.push(eq(schema.requestLogs.success, false))

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query
  }

  const rows = await query

  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore ? data[data.length - 1]?.createdAt : null

  return c.json({
    data: data.map((r) => ({
      ...r,
      attempts: JSON.parse(r.attempts),
    })),
    nextCursor,
  })
})

// GET /api/logs/:id — single log entry
app.get('/logs/:id', async (c) => {
  const [row] = await db
    .select()
    .from(schema.requestLogs)
    .where(eq(schema.requestLogs.id, c.req.param('id')))
    .limit(1)

  if (!row) return c.json({ error: { message: 'Not found' } }, 404)

  return c.json({
    ...row,
    attempts: JSON.parse(row.attempts),
  })
})

// GET /api/health
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// GET /api/cooldowns — list active cooldowns
app.get('/cooldowns', (c) => {
  const state = getCooldownState()
  const now = Date.now()
  const result = []
  for (const [deploymentId, entry] of state) {
    result.push({
      deploymentId,
      until: entry.until,
      remainingMs: Math.max(0, entry.until - now),
      consecutiveFailures: entry.consecutiveFailures,
    })
  }
  return c.json(result)
})

// POST /api/cooldowns/:deploymentId/reset — clear a specific cooldown
app.post('/cooldowns/:deploymentId/reset', (c) => {
  const deploymentId = decodeURIComponent(c.req.param('deploymentId'))
  clearCooldown(deploymentId)
  return c.json({ ok: true })
})

export default app
