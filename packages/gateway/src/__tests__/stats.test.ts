import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

const DB_PATH = '/tmp/aigate-stats-tests.db'
process.env.DATABASE_URL = DB_PATH
process.env.ADMIN_TOKEN = 'test-admin-token'

let app: { fetch: typeof fetch }
let db: any
let schema: any
let stopSyncScheduler: (() => void) | undefined

const TODAY = new Date().toISOString().slice(0, 10)

beforeAll(async () => {
  await import('../db/migrate')
  ;({ db, schema } = await import('../db'))
  ;({ stopSyncScheduler } = await import('../sync/engine'))
  ;({ default: app } = await import('../index'))
})

afterAll(() => stopSyncScheduler?.())

beforeEach(async () => {
  await db.delete(schema.requestLogs)
  await db.delete(schema.dailyUsage)
})

let seq = 0

/** One `request_logs` row. `attempts` is what the router actually serializes. */
async function log(opts: {
  success: boolean
  finalProvider?: string | null
  attempts?: Array<{ status: string }>
}) {
  await db.insert(schema.requestLogs).values({
    id: `log-${seq++}`,
    model: 'model-x',
    gatewayKey: 'gw-1',
    sourceFormat: 'openai',
    attempts: JSON.stringify(
      (opts.attempts ?? [{ status: opts.success ? 'success' : 'failed' }]).map((a) => ({
        provider: 'p-1',
        deploymentId: 'p-1-model-x',
        groupName: null,
        price: 1,
        priceInput: 1,
        priceOutput: 1,
        status: a.status,
      })),
    ),
    finalProvider: opts.finalProvider ?? (opts.success ? 'p-1' : null),
    totalLatencyMs: 1,
    success: opts.success,
    createdAt: new Date().toISOString(),
  })
}

/** A metered request as `daily_usage` records it — only requests that reached a provider. */
async function metered(count: number) {
  await db.insert(schema.dailyUsage).values({
    date: TODAY,
    gatewayKey: 'gw-1',
    model: 'model-x',
    requestCount: count,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    totalSaved: 0,
  })
}

async function stats() {
  const res = await app.fetch(new Request('http://localhost/api/stats', {
    headers: { Authorization: 'Bearer test-admin-token' },
  }))
  expect(res.status).toBe(200)
  return (await res.json()) as any
}

describe('today success rate', () => {
  test('failures that never reached a provider cannot drive the rate negative', async () => {
    // The exact shape measured on the live E2E database: daily_usage counted 3
    // metered requests while request_logs held 4 failures with no final provider.
    // The old formula computed (3 - 4) / 3 = -33.3%.
    await metered(3)
    for (let i = 0; i < 3; i++) await log({ success: true })
    for (let i = 0; i < 4; i++) await log({ success: false })

    const s = await stats()
    expect(s.today.successRate).toBeGreaterThanOrEqual(0)
    expect(s.today.successRate).toBeLessThanOrEqual(100)
    // Both sides now come from request_logs: 3 successes out of 7 rows.
    expect(s.today.successRate).toBeCloseTo((3 / 7) * 100, 6)
    expect(s.today.loggedRequests).toBe(7)
    expect(s.today.failedRequests).toBe(4)
    expect(s.today.blockedByCostLimit).toBe(0)
  })

  test('cost-limit blocks are reported on their own and do not count as failures', async () => {
    await metered(1)
    await log({ success: true })
    await log({ success: false, attempts: [{ status: 'skipped_cost_limit' }] })
    await log({
      success: false,
      attempts: [{ status: 'skipped_cost_limit' }, { status: 'skipped_cost_limit' }],
    })

    const s = await stats()
    expect(s.today.blockedByCostLimit).toBe(2)
    expect(s.today.failedRequests).toBe(0)
    // Blocked requests stay in the denominator; they are just not errors.
    expect(s.today.loggedRequests).toBe(3)
    expect(s.today.successRate).toBe(100)
  })

  test('a request that was blocked on one provider and failed on another is a failure', async () => {
    await log({ success: true })
    await log({
      success: false,
      attempts: [{ status: 'skipped_cost_limit' }, { status: 'failed' }],
    })

    const s = await stats()
    expect(s.today.blockedByCostLimit).toBe(0)
    expect(s.today.failedRequests).toBe(1)
    expect(s.today.successRate).toBe(50)
  })

  test('a day with no requests reports 100, not NaN', async () => {
    const s = await stats()
    expect(s.today.loggedRequests).toBe(0)
    expect(s.today.successRate).toBe(100)
    expect(Number.isNaN(s.today.successRate)).toBe(false)
  })

  test('metered requests and logged requests are allowed to disagree', async () => {
    // daily_usage only counts requests that reached a provider; the rate must not
    // mix the two populations again.
    await metered(2)
    await log({ success: true })
    await log({ success: true })
    await log({ success: false })

    const s = await stats()
    expect(s.today.requests).toBe(2)       // metered — unchanged meaning
    expect(s.today.loggedRequests).toBe(3) // every request, blocked ones included
    expect(s.today.successRate).toBeCloseTo((2 / 3) * 100, 6)
  })
})
