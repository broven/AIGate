import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { nanoid, hashKey, generateApiKey } from '../utils'

const app = new Hono()

// GET /api/keys
app.get('/', async (c) => {
  const rows = await db.select({
    id: schema.gatewayKeys.id,
    name: schema.gatewayKeys.name,
    keyPrefix: schema.gatewayKeys.keyPrefix,
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
    keyHash: hashKey(rawKey),
    keyPrefix: rawKey.slice(0, 8),
  })

  // Return the raw key ONCE — it cannot be retrieved again
  return c.json({ id, name, key: rawKey, keyPrefix: rawKey.slice(0, 8) }, 201)
})

// DELETE /api/keys/:id
app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await db.delete(schema.gatewayKeys).where(eq(schema.gatewayKeys.id, id))
  return c.json({ ok: true })
})

export default app
