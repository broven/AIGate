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

  // Success rate is computed entirely from `request_logs`: it is the only table
  // with a row for EVERY request, including the ones blocked by a Cost Limit and
  // the ones where every provider failed. `daily_usage.request_count` only counts
  // requests that reached a provider, so mixing the two put failures the metered
  // side had never seen into the numerator — enough of them and the rate went
  // negative.
  //
  // A request whose attempts are all Cost Limit refusals never reached an
  // upstream. That is a deliberate policy decision, not an error, so it does not
  // count against the rate — but it stays in the denominator and is reported on
  // its own as `blockedByCostLimit`. `request_logs` has no column for it; the
  // logged attempts are the only record, hence the match on the serialized status.
  const blockedByCostLimit = sql`${schema.requestLogs.success} = 0
    AND ${schema.requestLogs.attempts} LIKE '%"status":"skipped_cost_limit"%'
    AND ${schema.requestLogs.attempts} NOT LIKE '%"status":"failed"%'`

  const [todayRequests] = await db
    .select({
      total: count(),
      failed: sql<number>`coalesce(sum(case when ${schema.requestLogs.success} = 0 then 1 else 0 end), 0)`,
      blocked: sql<number>`coalesce(sum(case when ${blockedByCostLimit} then 1 else 0 end), 0)`,
    })
    .from(schema.requestLogs)
    .where(gte(schema.requestLogs.createdAt, today))

  const loggedRequests = todayRequests?.total ?? 0
  const blockedRequests = todayRequests?.blocked ?? 0
  // Failures that actually went wrong: total failures minus the policy blocks.
  const failedRequests = Math.max(0, (todayRequests?.failed ?? 0) - blockedRequests)

  // Clamped regardless of what the two counts say: a rate outside 0..100 is a
  // bug report shown to the operator as if it were data. A day with no requests
  // reports 100, not NaN.
  const successRate =
    loggedRequests > 0
      ? Math.min(100, Math.max(0, ((loggedRequests - failedRequests) / loggedRequests) * 100))
      : 100

  return c.json({
    today: {
      requests: todayStats!.requests,
      cost: todayStats!.cost,
      saved: todayStats!.saved,
      inputTokens: todayStats!.inputTokens,
      outputTokens: todayStats!.outputTokens,
      successRate,
      /** Every request logged today, including blocked and all-providers-failed ones. */
      loggedRequests,
      /** Requests that reached a provider and still failed. */
      failedRequests,
      /** Requests refused up front by a Provider Cost Limit — policy, not error. */
      blockedByCostLimit: blockedRequests,
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
  // Hono already percent-decodes route params; decoding a second time would
  // corrupt a deployment id that legitimately contains '%' (and throw on a
  // malformed sequence). Cloudflare ids arrive here as `cf-@cf/meta/...`.
  const deploymentId = c.req.param('deploymentId')
  clearCooldown(deploymentId)
  return c.json({ ok: true })
})

export default app
