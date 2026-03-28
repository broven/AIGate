import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'

const DB_PATH = `/tmp/aigate-virtual-models-api-${Date.now()}.db`
process.env.DATABASE_URL = DB_PATH

let app: any
let db: any
let schema: any

beforeAll(async () => {
  process.env.ADMIN_TOKEN = 'test-admin-token'
  rmSync(DB_PATH, { force: true })

  await import('../db/migrate')
  ;({ db, schema } = await import('../db'))
  ;({ default: app } = await import('../api/virtual-models'))
})

afterAll(() => {
  rmSync(DB_PATH, { force: true })
})

describe('virtual models API', () => {
  test('lists an empty array initially', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test('creates, updates, lists, and deletes a virtual model', async () => {
    await db.insert(schema.providers).values({
      id: 'provider-1',
      type: 'openai-compatible',
      endpoint: 'https://example.com',
    })
    await db.insert(schema.modelDeployments).values({
      deploymentId: 'dep-1',
      providerId: 'provider-1',
      canonical: 'gpt-4o',
      upstream: 'gpt-4o',
    })

    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'reasoning',
        description: 'Ordered fallback chain',
        entries: [
          {
            canonical: 'gpt-4o',
            priority: 0,
            disabledDeployments: ['dep-1'],
          },
        ],
      }),
    })

    expect(createRes.status).toBe(200)
    const { id } = await createRes.json()
    expect(id).toBeString()

    const listAfterCreate = await app.request('/')
    const created = await listAfterCreate.json()
    expect(created).toHaveLength(1)
    expect(created[0].name).toBe('reasoning')
    expect(created[0].entries).toHaveLength(1)
    expect(created[0].entries[0].disabledDeployments).toEqual(['dep-1'])

    const updateRes = await app.request(`/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'Updated description',
        entries: [
          {
            canonical: 'gpt-4o',
            priority: 1,
            disabledDeployments: [],
          },
        ],
      }),
    })
    expect(updateRes.status).toBe(200)
    expect(await updateRes.json()).toEqual({ ok: true })

    const listAfterUpdate = await app.request('/')
    const updated = await listAfterUpdate.json()
    expect(updated[0].description).toBe('Updated description')
    expect(updated[0].entries[0].priority).toBe(1)
    expect(updated[0].entries[0].disabledDeployments).toEqual([])

    const deleteRes = await app.request(`/${id}`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)
    expect(await deleteRes.json()).toEqual({ ok: true })

    const listAfterDelete = await app.request('/')
    expect(await listAfterDelete.json()).toEqual([])
  })
})
