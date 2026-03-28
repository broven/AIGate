import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { db, schema } from '../db'
import { nanoid } from '../utils'
import { getModelsDevProviderList } from '../sync/models-dev'

const app = new Hono()

// GET /api/providers
app.get('/', async (c) => {
  const rows = await db.select().from(schema.providers)
  return c.json(
    rows.map((r) => ({
      ...r,
      blackGroupMatch: r.blackGroupMatch ? JSON.parse(r.blackGroupMatch) : [],
      modelsDevSlug: r.modelsDevSlug ?? null,
    })),
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
    newApiUserId: body.newApiUserId ?? null,
    modelsDevSlug: body.modelsDevSlug ?? null,
    blackGroupMatch: body.blackGroupMatch ? JSON.stringify(body.blackGroupMatch) : null,
    syncEnabled: body.syncEnabled ?? true,
    syncIntervalMinutes: body.syncIntervalMinutes ?? 60,
  }

  // Only update secrets if explicitly provided (frontend omits them to keep current values)
  if ('apiKey' in body) updates.apiKey = body.apiKey || ''
  if ('accessToken' in body) updates.accessToken = body.accessToken ?? null

  await db
    .update(schema.providers)
    .set(updates)
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

export default app
