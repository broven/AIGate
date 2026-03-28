import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const DB_PATH = '/tmp/aigate-virtual-models-tests.db'
process.env.DATABASE_URL = DB_PATH
process.env.ADMIN_TOKEN = 'test-admin-token'

let app: { fetch: typeof fetch }
let db: any
let schema: any
let stopSyncScheduler: (() => void) | undefined
const upstreamCalls: Array<{ url: string; body: any }> = []
const originalFetch = globalThis.fetch

beforeAll(async () => {
  await import('../db/migrate')
  ;({ db, schema } = await import('../db'))
  ;({ stopSyncScheduler } = await import('../sync/engine'))
  ;({ default: app } = await import('../index'))

  await db.delete(schema.virtualModelDeploymentOverrides)
  await db.delete(schema.virtualModelEntries)
  await db.delete(schema.virtualModels)
  await db.delete(schema.requestLogs)
  await db.delete(schema.dailyUsage)
  await db.delete(schema.modelDeployments)
  await db.delete(schema.gatewayKeys)
  await db.delete(schema.providers)

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    upstreamCalls.push({ url, body })

    return Response.json({
      id: 'upstream-response',
      model: body?.model ?? 'unknown-model',
      choices: [{ message: { role: 'assistant', content: 'hello from upstream' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
  }

  await db.insert(schema.gatewayKeys).values({
    id: 'gw-key-1',
    name: 'test-key-name',
    keyPlain: 'test-api-key',
  })

  await db.insert(schema.providers).values({
    id: 'provider-1',
    type: 'openai-compatible',
    endpoint: 'https://provider.example',
    syncEnabled: false,
  })

  await db.insert(schema.modelDeployments).values([
    {
      deploymentId: 'dep-disabled',
      providerId: 'provider-1',
      canonical: 'gpt-4o',
      upstream: 'gpt-4o',
      priceInput: 1,
      priceOutput: 1,
    },
    {
      deploymentId: 'dep-tier-2',
      providerId: 'provider-1',
      canonical: 'claude-3-7-sonnet',
      upstream: 'claude-3-7-sonnet',
      priceInput: 2,
      priceOutput: 2,
    },
  ])

  await db.insert(schema.virtualModels).values({
    id: 'vm-1',
    name: 'chain',
    description: 'fallback chain',
  })

  await db.insert(schema.virtualModelEntries).values([
    {
      id: 'vm-entry-1',
      virtualModelId: 'vm-1',
      canonical: 'gpt-4o',
      priority: 0,
    },
    {
      id: 'vm-entry-2',
      virtualModelId: 'vm-1',
      canonical: 'claude-3-7-sonnet',
      priority: 1,
    },
  ])

  await db.insert(schema.virtualModelDeploymentOverrides).values({
    virtualModelId: 'vm-1',
    deploymentId: 'dep-disabled',
    disabled: true,
  })
})

afterAll(() => {
  globalThis.fetch = originalFetch
  stopSyncScheduler?.()
})

describe('virtual model routing and exposure', () => {
  test('exposes virtual models from /v1/models', async () => {
    const res = await app.fetch(new Request('http://localhost/v1/models', {
      headers: { Authorization: 'Bearer test-api-key' },
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.data.map((entry: { id: string }) => entry.id)

    expect(ids).toContain('gpt-4o')
    expect(ids).toContain('claude-3-7-sonnet')
    expect(ids).toContain('virtual:chain')
  })

  test('routes virtual model requests through the fallback chain and logs the virtual model name', async () => {
    upstreamCalls.length = 0

    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-api-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'virtual:chain',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message.content).toBe('hello from upstream')

    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]?.body.model).toBe('claude-3-7-sonnet')

    const logs = await db.select().from(schema.requestLogs)
    expect(logs).toHaveLength(1)
    expect(logs[0].model).toBe('virtual:chain')
    expect(logs[0].virtualModelName).toBe('chain')
  })
})
