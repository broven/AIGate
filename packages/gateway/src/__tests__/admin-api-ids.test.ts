import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

const DB_PATH = '/tmp/aigate-admin-api-ids-tests.db'
process.env.DATABASE_URL = DB_PATH
process.env.ADMIN_TOKEN = 'test-admin-token'

let app: { fetch: typeof fetch }
let db: any
let schema: any
let stopSyncScheduler: (() => void) | undefined
let costLimit: typeof import('../router/cost-limit')

// A real Cloudflare deployment id, as the sync engine builds it: the canonical
// keeps the `@cf/` namespace and its slashes.
const CF_CANONICAL = '@cf/meta/llama-3-2-1b-instruct'
const CF_DEPLOYMENT_ID = `cf-${CF_CANONICAL}`

beforeAll(async () => {
  await import('../db/migrate')
  ;({ db, schema } = await import('../db'))
  ;({ stopSyncScheduler } = await import('../sync/engine'))
  costLimit = await import('../router/cost-limit')
  ;({ default: app } = await import('../index'))
})

afterAll(() => stopSyncScheduler?.())

beforeEach(async () => {
  await db.delete(schema.providerDailySpend)
  await db.delete(schema.modelDeployments)
  await db.delete(schema.providers)
  costLimit.invalidateSpendCache()
})

function admin(path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-admin-token',
      ...init?.headers,
    },
  }))
}

async function seedCloudflareDeployment() {
  await db.insert(schema.providers).values({
    id: 'cf', type: 'openai-compatible', endpoint: 'https://cf.test', apiKey: 'k', syncEnabled: false,
  })
  await db.insert(schema.modelDeployments).values({
    deploymentId: CF_DEPLOYMENT_ID,
    providerId: 'cf',
    canonical: CF_CANONICAL,
    upstream: '@cf/meta/llama-3.2-1b-instruct',
    priceInput: 0.027,
    priceOutput: 0.201,
    priceSource: 'models_dev',
    status: 'active',
    lastSyncAt: new Date().toISOString(),
  })
}

// These mirror packages/dashboard/src/lib/api.ts — the URLs the dashboard builds.
const modelPriceUrl = (id: string) => `/api/models/${encodeURIComponent(id)}/price`
const modelBlacklistUrl = (id: string) => `/api/models/${encodeURIComponent(id)}/blacklist`
const cooldownResetUrl = (id: string) => `/api/cooldowns/${encodeURIComponent(id)}/reset`

describe('deployment ids containing slashes', () => {
  test('a manual price override reaches the right row', async () => {
    await seedCloudflareDeployment()

    const res = await admin(modelPriceUrl(CF_DEPLOYMENT_ID), {
      method: 'PUT',
      body: JSON.stringify({ priceInput: 1.5, priceOutput: 2.5 }),
    })
    expect(res.status).toBe(200)

    const [row] = await db.select().from(schema.modelDeployments)
    expect(row.deploymentId).toBe(CF_DEPLOYMENT_ID)
    expect(row.manualPriceInput).toBe(1.5)
    expect(row.manualPriceOutput).toBe(2.5)
  })

  test('a blacklist toggle reaches the right row', async () => {
    await seedCloudflareDeployment()

    const res = await admin(modelBlacklistUrl(CF_DEPLOYMENT_ID), {
      method: 'PUT',
      body: JSON.stringify({ blacklisted: true }),
    })
    expect(res.status).toBe(200)

    const [row] = await db.select().from(schema.modelDeployments)
    expect(row.blacklisted).toBe(true)
  })

  test('an unencoded id splits into extra path segments and 404s', async () => {
    await seedCloudflareDeployment()
    // What the dashboard used to send.
    const res = await admin(`/api/models/${CF_DEPLOYMENT_ID}/price`, {
      method: 'PUT',
      body: JSON.stringify({ priceInput: 1, priceOutput: 1 }),
    })
    expect(res.status).toBe(404)
  })

  test('the cooldown reset route survives the same id', async () => {
    await seedCloudflareDeployment()
    const res = await admin(cooldownResetUrl(CF_DEPLOYMENT_ID), { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('an id containing a percent sign is not double-decoded', async () => {
    // Hono already decodes route params; a second decode would corrupt this id
    // (and throw on a malformed escape).
    const weirdId = 'p-1/model-100%-off'
    await db.insert(schema.providers).values({
      id: 'p-1', type: 'openai-compatible', endpoint: 'https://p1.test', apiKey: 'k', syncEnabled: false,
    })
    await db.insert(schema.modelDeployments).values({
      deploymentId: weirdId,
      providerId: 'p-1',
      canonical: 'model-100%-off',
      upstream: 'model-100%-off',
      priceInput: 1,
      priceOutput: 1,
      priceSource: 'models_dev',
      status: 'active',
      lastSyncAt: new Date().toISOString(),
    })

    expect((await admin(cooldownResetUrl(weirdId), { method: 'POST' })).status).toBe(200)

    const res = await admin(modelBlacklistUrl(weirdId), {
      method: 'PUT',
      body: JSON.stringify({ blacklisted: true }),
    })
    expect(res.status).toBe(200)
    const [row] = await db.select().from(schema.modelDeployments)
    expect(row.deploymentId).toBe(weirdId)
    expect(row.blacklisted).toBe(true)
  })
})

describe('spend cache lifetime', () => {
  test('deleting a Provider drops its cached spend', async () => {
    await db.insert(schema.providers).values({
      id: 'p-del', type: 'openai-compatible', endpoint: 'https://d.test', apiKey: 'k',
      syncEnabled: false, dailyCostLimitUsd: 1,
    })
    await costLimit.addSpend('p-del', 0.9)

    // Warm the cache — this is what a routing pass or the providers list does.
    expect((await costLimit.getSpend('p-del')).daily).toBeCloseTo(0.9, 10)
    expect(costLimit.peekSpend('p-del')).not.toBeNull()

    expect((await admin('/api/providers/p-del', { method: 'DELETE' })).status).toBe(200)

    // The cascade removed the spend rows; the cache must not outlive them.
    expect(costLimit.peekSpend('p-del')).toBeNull()

    // Recreating the same id (the create API accepts a caller-supplied id)
    // starts from zero rather than resuming yesterday's total.
    const created = await admin('/api/providers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'p-del', type: 'openai-compatible', endpoint: 'https://d.test',
        apiKey: 'k', dailyCostLimitUsd: 1,
      }),
    })
    expect(created.status).toBe(201)

    const spend = await costLimit.getSpend('p-del')
    expect(spend.daily).toBe(0)
    expect(spend.monthly).toBe(0)
    expect(costLimit.evaluateCostLimit({
      providerId: 'p-del', providerName: 'p-del',
      dailyLimit: 1, monthlyLimit: null, spend,
    })).toBeNull()
  })
})
