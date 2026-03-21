import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { db, schema } from '../db'
import { nanoid } from '../utils'

const app = new Hono()

// GET /api/providers
app.get('/', async (c) => {
  const rows = await db.select().from(schema.providers)
  return c.json(
    rows.map((r) => ({
      ...r,
      apiKey: maskKey(r.apiKey),
      accessToken: r.accessToken ? maskKey(r.accessToken) : null,
      blackGroupMatch: r.blackGroupMatch ? JSON.parse(r.blackGroupMatch) : [],
    })),
  )
})

// POST /api/providers
app.post('/', async (c) => {
  const body = await c.req.json()
  const id = body.id || nanoid(8)

  await db.insert(schema.providers).values({
    id,
    type: body.type,
    endpoint: body.endpoint.replace(/\/$/, ''),
    apiKey: body.apiKey,
    costMultiplier: body.costMultiplier ?? 1.0,
    newApiUserId: body.newApiUserId ?? null,
    accessToken: body.accessToken ?? null,
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

  const result = await db
    .update(schema.providers)
    .set({
      type: body.type,
      endpoint: body.endpoint.replace(/\/$/, ''),
      apiKey: body.apiKey,
      costMultiplier: body.costMultiplier ?? 1.0,
      newApiUserId: body.newApiUserId ?? null,
      accessToken: body.accessToken ?? null,
      blackGroupMatch: body.blackGroupMatch ? JSON.stringify(body.blackGroupMatch) : null,
      syncEnabled: body.syncEnabled ?? true,
      syncIntervalMinutes: body.syncIntervalMinutes ?? 60,
    })
    .where(eq(schema.providers.id, id))

  return c.json({ ok: true })
})

// DELETE /api/providers/:id
app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await db.delete(schema.providers).where(eq(schema.providers.id, id))
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

function maskKey(key: string): string {
  if (key.length <= 8) return '***'
  return key.slice(0, 8) + '...' + key.slice(-4)
}

export default app
