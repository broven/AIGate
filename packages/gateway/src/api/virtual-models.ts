import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'

const app = new Hono()

app.get('/', async (c) => {
  const vms = await db.select().from(schema.virtualModels)
  const entries = await db.select().from(schema.virtualModelEntries)
  const overrides = await db.select().from(schema.virtualModelDeploymentOverrides)

  const result = vms.map((vm) => ({
    ...vm,
    entries: entries
      .filter((entry) => entry.virtualModelId === vm.id)
      .sort((a, b) => a.priority - b.priority)
      .map((entry) => ({
        ...entry,
        disabledDeployments: overrides
          .filter((override) => override.virtualModelId === vm.id && override.disabled)
          .map((override) => override.deploymentId),
      })),
  }))

  return c.json(result)
})

app.post('/', async (c) => {
  const body = await c.req.json<{
    name: string
    description?: string
    entries: Array<{
      canonical: string
      priority: number
      disabledDeployments?: string[]
    }>
  }>()

  if (!body.name || !body.name.trim()) {
    return c.json({ error: { message: 'name is required' } }, 400)
  }

  if (!body.entries || body.entries.length === 0) {
    return c.json({ error: { message: 'at least one entry is required' } }, 400)
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await db.insert(schema.virtualModels).values({
    id,
    name: body.name.trim().toLowerCase(),
    description: body.description?.trim() || '',
    createdAt: now,
    updatedAt: now,
  })

  for (const entry of body.entries) {
    await db.insert(schema.virtualModelEntries).values({
      id: crypto.randomUUID(),
      virtualModelId: id,
      canonical: entry.canonical,
      priority: entry.priority,
      createdAt: now,
    })

    if (entry.disabledDeployments) {
      for (const deploymentId of entry.disabledDeployments) {
        await db.insert(schema.virtualModelDeploymentOverrides).values({
          virtualModelId: id,
          deploymentId,
          disabled: true,
        })
      }
    }
  }

  return c.json({ id })
})

app.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    name?: string
    description?: string
    entries?: Array<{
      canonical: string
      priority: number
      disabledDeployments?: string[]
    }>
  }>()

  const existing = await db.select().from(schema.virtualModels).where(eq(schema.virtualModels.id, id))
  if (existing.length === 0) {
    return c.json({ error: { message: 'virtual model not found' } }, 404)
  }

  if (body.name !== undefined && !body.name.trim()) {
    return c.json({ error: { message: 'name cannot be empty' } }, 400)
  }

  if (body.entries && body.entries.length === 0) {
    return c.json({ error: { message: 'at least one entry is required' } }, 400)
  }

  const now = new Date().toISOString()

  await db.update(schema.virtualModels).set({
    ...(body.name !== undefined ? { name: body.name.trim().toLowerCase() } : {}),
    ...(body.description !== undefined ? { description: body.description.trim() } : {}),
    updatedAt: now,
  }).where(eq(schema.virtualModels.id, id))

  if (body.entries) {
    await db.delete(schema.virtualModelEntries).where(eq(schema.virtualModelEntries.virtualModelId, id))
    await db.delete(schema.virtualModelDeploymentOverrides).where(eq(schema.virtualModelDeploymentOverrides.virtualModelId, id))

    for (const entry of body.entries) {
      await db.insert(schema.virtualModelEntries).values({
        id: crypto.randomUUID(),
        virtualModelId: id,
        canonical: entry.canonical,
        priority: entry.priority,
        createdAt: now,
      })

      if (entry.disabledDeployments) {
        for (const deploymentId of entry.disabledDeployments) {
          await db.insert(schema.virtualModelDeploymentOverrides).values({
            virtualModelId: id,
            deploymentId,
            disabled: true,
          })
        }
      }
    }
  }

  return c.json({ ok: true })
})

app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await db.delete(schema.virtualModels).where(eq(schema.virtualModels.id, id))
  return c.json({ ok: true })
})

export default app
