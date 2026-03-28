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
      deploymentId: 'dep-gpt4o',
      providerId: 'provider-1',
      canonical: 'gpt-4o',
      upstream: 'gpt-4o',
      priceInput: 5,
      priceOutput: 5,
    },
    {
      deploymentId: 'dep-disabled',
      providerId: 'provider-1',
      canonical: 'gpt-4o',
      upstream: 'gpt-4o-backup',
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
    {
      deploymentId: 'dep-merge-a',
      providerId: 'provider-1',
      canonical: 'claude-haiku-4-5',
      upstream: 'claude-haiku-4-5',
      priceInput: 10,
      priceOutput: 10,
    },
    {
      deploymentId: 'dep-merge-b',
      providerId: 'provider-1',
      canonical: 'claude-haiku-4-5-20250301',
      upstream: 'claude-haiku-4-5-20250301',
      priceInput: 3,
      priceOutput: 3,
    },
  ])

  // Fallback virtual model
  await db.insert(schema.virtualModels).values({
    id: 'vm-1',
    name: 'chain',
    description: 'fallback chain',
    mode: 'fallback',
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

  // Merge virtual model
  await db.insert(schema.virtualModels).values({
    id: 'vm-merge',
    name: 'claude-haiku',
    description: 'merge haiku variants',
    mode: 'merge',
  })

  await db.insert(schema.virtualModelEntries).values([
    {
      id: 'vm-merge-entry-1',
      virtualModelId: 'vm-merge',
      canonical: 'claude-haiku-4-5',
      priority: 0,
    },
    {
      id: 'vm-merge-entry-2',
      virtualModelId: 'vm-merge',
      canonical: 'claude-haiku-4-5-20250301',
      priority: 1,
    },
  ])
})

afterAll(() => {
  globalThis.fetch = originalFetch
  stopSyncScheduler?.()
})

describe('virtual model routing and exposure', () => {
  test('exposes virtual models by plain name from /v1/models', async () => {
    const res = await app.fetch(new Request('http://localhost/v1/models', {
      headers: { Authorization: 'Bearer test-api-key' },
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.data.map((entry: { id: string }) => entry.id)

    expect(ids).toContain('gpt-4o')
    expect(ids).toContain('claude-3-7-sonnet')
    expect(ids).toContain('chain')
    expect(ids).toContain('claude-haiku')
    // Should NOT have virtual: prefix
    expect(ids).not.toContain('virtual:chain')
    expect(ids).not.toContain('virtual:claude-haiku')
  })

  test('routes fallback virtual model by plain name and logs virtualModelName', async () => {
    upstreamCalls.length = 0
    await db.delete(schema.requestLogs)

    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-api-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'chain',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message.content).toBe('hello from upstream')

    // dep-disabled is disabled, dep-gpt4o should be used
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]?.body.model).toBe('gpt-4o')

    const logs = await db.select().from(schema.requestLogs)
    expect(logs).toHaveLength(1)
    expect(logs[0].model).toBe('chain')
    expect(logs[0].virtualModelName).toBe('chain')
  })

  test('virtual model shadows regular model with same canonical', async () => {
    // 'gpt-4o' exists as both a regular model and as an entry in virtual model 'chain'
    // But 'chain' is the virtual model name, not 'gpt-4o'
    // A request for 'gpt-4o' should go through regular routing (no virtual model named 'gpt-4o')
    upstreamCalls.length = 0

    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-api-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    }))

    expect(res.status).toBe(200)
    // Regular routing uses both gpt-4o deployments (dep-gpt4o and dep-disabled)
    // dep-disabled has lower price (1), should be tried first
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]?.body.model).toBe('gpt-4o-backup')
  })

  test('merge mode pools deployments across entries and routes by cheapest price', async () => {
    upstreamCalls.length = 0
    await db.delete(schema.requestLogs)

    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-api-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message.content).toBe('hello from upstream')

    // Merge mode: pools dep-merge-a (price 10) and dep-merge-b (price 3)
    // Should pick dep-merge-b (cheapest)
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]?.body.model).toBe('claude-haiku-4-5-20250301')

    const logs = await db.select().from(schema.requestLogs)
    expect(logs).toHaveLength(1)
    expect(logs[0].model).toBe('claude-haiku')
    expect(logs[0].virtualModelName).toBe('claude-haiku')
  })
})
