import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

const DB_PATH = '/tmp/aigate-cost-limit-tests.db'
process.env.DATABASE_URL = DB_PATH
process.env.ADMIN_TOKEN = 'test-admin-token'

let app: { fetch: typeof fetch }
let db: any
let schema: any
let stopSyncScheduler: (() => void) | undefined
let costLimit: typeof import('../router/cost-limit')

const originalFetch = globalThis.fetch

beforeAll(async () => {
  await import('../db/migrate')
  ;({ db, schema } = await import('../db'))
  ;({ stopSyncScheduler } = await import('../sync/engine'))
  costLimit = await import('../router/cost-limit')
  ;({ default: app } = await import('../index'))

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('models.dev')) return Response.json({})
    const body = init?.body ? JSON.parse(String(init.body)) : null
    return Response.json({
      id: 'upstream-response',
      model: body?.model ?? 'unknown',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 1000 },
    })
  }) as typeof fetch

  await db.delete(schema.requestLogs)
  await db.delete(schema.dailyUsage)
  await db.delete(schema.providerDailySpend)
  await db.delete(schema.modelDeployments)
  await db.delete(schema.gatewayKeys)
  await db.delete(schema.providers)

  await db.insert(schema.gatewayKeys).values({
    id: 'gw-1', name: 'test-key-name', keyPlain: 'test-api-key',
  })
})

afterAll(() => {
  globalThis.fetch = originalFetch
  stopSyncScheduler?.()
})

beforeEach(async () => {
  await db.delete(schema.requestLogs)
  await db.delete(schema.providerDailySpend)
  await db.delete(schema.modelDeployments)
  await db.delete(schema.providers)
  costLimit.__resetInFlight()
  costLimit.invalidateSpendCache()
})

async function addProvider(
  id: string,
  limits: { daily?: number | null; monthly?: number | null } = {},
) {
  await db.insert(schema.providers).values({
    id,
    type: 'openai-compatible',
    endpoint: `https://${id}.test`,
    apiKey: 'k',
    syncEnabled: false,
    dailyCostLimitUsd: limits.daily ?? null,
    monthlyCostLimitUsd: limits.monthly ?? null,
  })
}

async function addDeployment(providerId: string, canonical: string, priceOutput = 15) {
  await db.insert(schema.modelDeployments).values({
    deploymentId: `${providerId}-${canonical}`,
    providerId,
    canonical,
    upstream: canonical,
    priceInput: 3,
    priceOutput,
    priceSource: 'models_dev',
    status: 'active',
    lastSyncAt: new Date().toISOString(),
  })
}

async function chat(model: string) {
  return app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-api-key' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  }))
}

// --- UTC windows -----------------------------------------------------------

describe('UTC window helpers', () => {
  test('the daily key is the UTC date, not the local one', () => {
    // 23:30 UTC-equivalent instant: local time may already be the next day.
    const instant = new Date('2026-08-21T23:30:00.000Z')
    expect(costLimit.utcDateOf(instant)).toBe('2026-08-21')
    expect(costLimit.utcMonthOf(instant)).toBe('2026-08')
  })

  test('the daily window resets at the next 00:00 UTC', () => {
    expect(costLimit.nextResetAt('daily', new Date('2026-08-21T23:30:00.000Z')))
      .toBe('2026-08-22T00:00:00.000Z')
  })

  test('the monthly window resets on the 1st, 00:00 UTC', () => {
    expect(costLimit.nextResetAt('monthly', new Date('2026-08-21T23:30:00.000Z')))
      .toBe('2026-09-01T00:00:00.000Z')
    expect(costLimit.nextResetAt('monthly', new Date('2026-12-05T00:00:00.000Z')))
      .toBe('2027-01-01T00:00:00.000Z')
  })
})

// --- Spend accounting ------------------------------------------------------

describe('spend accounting', () => {
  test('the monthly window is derived by summing the days, not stored separately', async () => {
    await addProvider('p-sum')
    const day1 = new Date('2026-08-01T10:00:00.000Z')
    const day2 = new Date('2026-08-02T10:00:00.000Z')

    await costLimit.addSpend('p-sum', 1.5, day1)
    await costLimit.addSpend('p-sum', 2.25, day2)
    costLimit.invalidateSpendCache()

    const onDay2 = await costLimit.getSpend('p-sum', day2)
    expect(onDay2.daily).toBeCloseTo(2.25, 10)
    expect(onDay2.monthly).toBeCloseTo(3.75, 10)
  })

  test('a UTC day rollover resets the daily counter and keeps the monthly one', async () => {
    await addProvider('p-roll')
    const today = new Date('2026-08-21T12:00:00.000Z')
    const tomorrow = new Date('2026-08-22T00:05:00.000Z')

    await costLimit.addSpend('p-roll', 5, today)
    costLimit.invalidateSpendCache()

    expect((await costLimit.getSpend('p-roll', today)).daily).toBeCloseTo(5, 10)
    costLimit.invalidateSpendCache()
    const next = await costLimit.getSpend('p-roll', tomorrow)
    expect(next.daily).toBe(0)
    expect(next.monthly).toBeCloseTo(5, 10)
  })

  test('a non-finite cost is refused rather than poisoning the row', async () => {
    await addProvider('p-nan')
    await costLimit.addSpend('p-nan', Infinity)
    await costLimit.addSpend('p-nan', NaN)
    costLimit.invalidateSpendCache()
    expect((await costLimit.getSpend('p-nan')).daily).toBe(0)
  })
})

// --- In-flight reservation -------------------------------------------------

describe('in-flight reservation', () => {
  const perRequest = (rate: number) => (rate * costLimit.RESERVE_OUTPUT_TOKENS) / 1_000_000

  test('a request reserves its own output rate x 4096, not a shared estimate', () => {
    expect(costLimit.reservationFor({ priceOutput: 15, pricePerCall: null }))
      .toBeCloseTo(perRequest(15), 12)
    expect(costLimit.reservationFor({ priceOutput: 1, pricePerCall: null }))
      .toBeCloseTo(perRequest(1), 12)
  })

  test('a flat per-call Deployment reserves its per-call price, not nothing', () => {
    expect(costLimit.reservationFor({ priceOutput: 0, pricePerCall: 0.04 })).toBe(0.04)
  })

  test('an unpriced Deployment reserves nothing rather than guessing', () => {
    expect(costLimit.reservationFor({ priceOutput: null, pricePerCall: null })).toBe(0)
    expect(costLimit.reservationFor({ priceOutput: Infinity, pricePerCall: null })).toBe(0)
  })

  test('the effective limit drops by the USD actually reserved', () => {
    expect(costLimit.effectiveLimit(1, 0)).toBe(1)
    expect(costLimit.effectiveLimit(1, 0.25)).toBeCloseTo(0.75, 12)
  })

  test('a null limit stays unlimited no matter how much is reserved', () => {
    expect(costLimit.effectiveLimit(null, 10)).toBeNull()
  })

  test('reservations of DIFFERENT rates sum to their own amounts', () => {
    // The bug this replaces: one aggregate count x whichever rate asked last.
    const expensive = costLimit.beginInFlight('p', costLimit.reservationFor({ priceOutput: 100, pricePerCall: null }))
    const cheap = costLimit.beginInFlight('p', costLimit.reservationFor({ priceOutput: 1, pricePerCall: null }))

    expect(costLimit.getInFlight('p')).toBe(2)
    expect(costLimit.getReservedUsd('p')).toBeCloseTo(perRequest(100) + perRequest(1), 12)

    costLimit.endInFlight(cheap)
    expect(costLimit.getReservedUsd('p')).toBeCloseTo(perRequest(100), 12)
    costLimit.endInFlight(expensive)
    expect(costLimit.getReservedUsd('p')).toBe(0)
    expect(costLimit.getInFlight('p')).toBe(0)
  })

  test('releasing twice does not free the reservation twice', () => {
    const a = costLimit.beginInFlight('p', 0.5)
    const b = costLimit.beginInFlight('p', 0.5)
    costLimit.endInFlight(a)
    costLimit.endInFlight(a)
    expect(costLimit.getInFlight('p')).toBe(1)
    expect(costLimit.getReservedUsd('p')).toBeCloseTo(0.5, 12)
    costLimit.endInFlight(b)
    expect(costLimit.getReservedUsd('p')).toBe(0)
  })
})

// --- evaluateCostLimit -----------------------------------------------------

describe('evaluateCostLimit', () => {
  const base = { providerId: 'p', providerName: 'p' }

  test('a null limit never blocks, however large the spend', () => {
    expect(costLimit.evaluateCostLimit({
      ...base, dailyLimit: null, monthlyLimit: null, spend: { daily: 9999, monthly: 9999 },
    })).toBeNull()
  })

  test('reaching the daily limit blocks', () => {
    const block = costLimit.evaluateCostLimit({
      ...base, dailyLimit: 1, monthlyLimit: null, spend: { daily: 1, monthly: 1 },
    })
    expect(block?.window).toBe('daily')
    expect(block?.limit).toBe(1)
  })

  test('reaching the monthly limit blocks even when the day has room', () => {
    const block = costLimit.evaluateCostLimit({
      ...base, dailyLimit: 100, monthlyLimit: 10, spend: { daily: 0.5, monthly: 10 },
    })
    expect(block?.window).toBe('monthly')
  })

  test('staying under both limits does not block', () => {
    expect(costLimit.evaluateCostLimit({
      ...base, dailyLimit: 1, monthlyLimit: 10, spend: { daily: 0.5, monthly: 5 },
    })).toBeNull()
  })

  test('in-flight reservations can block a Provider that is nominally under its limit', () => {
    const perRequest = (15 * costLimit.RESERVE_OUTPUT_TOKENS) / 1_000_000 // ~0.0614
    expect(costLimit.evaluateCostLimit({
      ...base, dailyLimit: 1, monthlyLimit: null, spend: { daily: 0.9, monthly: 0.9 },
    })).toBeNull()

    costLimit.beginInFlight('p', perRequest)
    costLimit.beginInFlight('p', perRequest)
    const block = costLimit.evaluateCostLimit({
      ...base, dailyLimit: 1, monthlyLimit: null, spend: { daily: 0.9, monthly: 0.9 },
    })
    expect(perRequest * 2).toBeGreaterThan(0.1)
    expect(block).not.toBeNull()
    expect(block!.effectiveLimit).toBeCloseTo(1 - 2 * perRequest, 12)
    expect(block!.effectiveLimit).toBeLessThan(block!.limit)
  })
})

// --- Routing + HTTP behaviour ---------------------------------------------

describe('routing under a Cost Limit', () => {
  test('a Provider at its daily limit loses ALL of its deployments', async () => {
    await addProvider('p-blocked', { daily: 1 })
    await addDeployment('p-blocked', 'model-a')
    await addDeployment('p-blocked', 'model-b')
    await costLimit.addSpend('p-blocked', 1.0)
    costLimit.invalidateSpendCache()

    // The limit is account-level, so a second, unrelated model is blocked too.
    expect((await chat('model-a')).status).toBe(503)
    expect((await chat('model-b')).status).toBe(503)
  })

  test('a Provider at its monthly limit is blocked even with a fresh day', async () => {
    await addProvider('p-month', { daily: 1000, monthly: 2 })
    await addDeployment('p-month', 'model-m')
    // Spend recorded on an earlier day this month: today's window is empty.
    await costLimit.addSpend('p-month', 2, new Date(`${costLimit.utcMonthOf()}-01T00:00:00.000Z`))
    costLimit.invalidateSpendCache()

    const res = await chat('model-m')
    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body.cost_limit[0].window).toBe('monthly')
  })

  test('an unlimited Provider routes normally', async () => {
    await addProvider('p-free')
    await addDeployment('p-free', 'model-free')
    await costLimit.addSpend('p-free', 9999)
    costLimit.invalidateSpendCache()

    expect((await chat('model-free')).status).toBe(200)
  })

  test('another Provider still serves the model when one is capped', async () => {
    await addProvider('p-cap', { daily: 1 })
    await addProvider('p-open')
    await addDeployment('p-cap', 'model-shared', 1)   // cheaper, but capped
    await addDeployment('p-open', 'model-shared', 50)
    await costLimit.addSpend('p-cap', 1)
    costLimit.invalidateSpendCache()

    const res = await chat('model-shared')
    expect(res.status).toBe(200)
    await Bun.sleep(20)

    const [log] = await db.select().from(schema.requestLogs)
    const attempts = JSON.parse(log.attempts)
    expect(attempts.some((a: any) => a.status === 'skipped_cost_limit')).toBe(true)
    expect(attempts.find((a: any) => a.status === 'success').provider).toBe('p-open')
  })

  test('the 503 body carries provider, spend, effective limit and reset time', async () => {
    await addProvider('p-body', { daily: 0.5 })
    await addDeployment('p-body', 'model-body')
    await costLimit.addSpend('p-body', 0.5)
    costLimit.invalidateSpendCache()

    const res = await chat('model-body')
    expect(res.status).toBe(503)

    const body = await res.json() as any
    const entry = body.cost_limit[0]
    expect(entry.provider).toBe('p-body')
    expect(entry.window).toBe('daily')
    expect(entry.spend_usd).toBeCloseTo(0.5, 10)
    expect(entry.limit_usd).toBe(0.5)
    expect(entry.effective_limit_usd).toBe(0.5) // nothing in flight
    expect(entry.reset_at).toBe(costLimit.nextResetAt('daily'))
    expect(body.error.message).toContain('p-body')
    expect(body.error.message).toContain('cost limit')
  })

  test('a blocked request is logged but adds nothing to spend', async () => {
    await addProvider('p-nolog', { daily: 0.5 })
    await addDeployment('p-nolog', 'model-nolog')
    await costLimit.addSpend('p-nolog', 0.5)
    costLimit.invalidateSpendCache()

    await db.delete(schema.requestLogs)
    expect((await chat('model-nolog')).status).toBe(503)
    await Bun.sleep(20)

    const logs = await db.select().from(schema.requestLogs)
    expect(logs).toHaveLength(1)
    expect(logs[0].success).toBe(false)
    expect(logs[0].finalProvider).toBeNull()

    costLimit.invalidateSpendCache()
    // Spend is unchanged: a request that never reached upstream cost nothing.
    expect((await costLimit.getSpend('p-nolog')).daily).toBeCloseTo(0.5, 10)
  })

  test('a successful request adds its cost to provider spend', async () => {
    await addProvider('p-spend', { daily: 100 })
    await addDeployment('p-spend', 'model-spend')
    costLimit.invalidateSpendCache()

    expect((await chat('model-spend')).status).toBe(200)
    await Bun.sleep(20)

    costLimit.invalidateSpendCache()
    // 1000 input @ $3/1M + 1000 output @ $15/1M
    expect((await costLimit.getSpend('p-spend')).daily).toBeCloseTo(0.018, 10)
  })

  test('an upstream failure yields 502, not the cost-limit 503', async () => {
    await addProvider('p-502')
    await addDeployment('p-502', 'model-502')

    const saved = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('models.dev')) return Response.json({})
      return new Response('nope', { status: 500 })
    }) as typeof fetch
    try {
      expect((await chat('model-502')).status).toBe(502)
    } finally {
      globalThis.fetch = saved
    }
  })
})

// --- Concurrency regressions ----------------------------------------------
//
// Each test here fails against the pre-review implementation: the limit was
// checked during selection (so two requests could both pass a limit with room
// for one), the reservation was released before `addSpend` had persisted the
// cost, and a cold `getSpend` overlapping an `addSpend` could cache the
// pre-write value for the rest of the UTC day.

describe('concurrency', () => {
  test('two concurrent requests cannot both pass a limit only one fits under', async () => {
    // reserve = $15/1M x 4096 = $0.0614 per request, so one claim exhausts a
    // $0.05 allowance and the second request must be refused.
    await addProvider('p-conc', { daily: 0.05 })
    await addDeployment('p-conc', 'model-conc', 15)
    costLimit.invalidateSpendCache()

    // Hold the upstream open so both requests are routing at the same time.
    const saved = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('models.dev')) return Response.json({})
      await Bun.sleep(60)
      return saved(input, init)
    }) as typeof fetch

    let statuses: number[]
    try {
      const [a, b] = await Promise.all([chat('model-conc'), chat('model-conc')])
      statuses = [a.status, b.status].sort()
    } finally {
      globalThis.fetch = saved
    }

    expect(statuses).toEqual([200, 503])
  })

  test('a cold spend read racing an addSpend does not cache the pre-write value', async () => {
    await addProvider('p-gen', { daily: 100 })
    await costLimit.addSpend('p-gen', 0.02)
    costLimit.invalidateSpendCache() // cold: the next read must hit the DB

    // Read and write overlap: the read's queries may well observe 0.02.
    const read = costLimit.getSpend('p-gen')
    const write = costLimit.addSpend('p-gen', 0.03)
    await Promise.all([read, write])

    // Whatever ended up cached must not be the pre-write value.
    const cached = costLimit.peekSpend('p-gen')
    if (cached) expect(cached.daily).toBeCloseTo(0.05, 10)

    // And a subsequent read — with no invalidation — must see the full spend.
    const after = await costLimit.getSpend('p-gen')
    expect(after.daily).toBeCloseTo(0.05, 10)
    expect(after.monthly).toBeCloseTo(0.05, 10)
  })

  test('the reservation outlives routeRequest for a non-streaming success', async () => {
    const { routeRequest } = await import('../router/price-router')
    await addProvider('p-hold', { daily: 100 })
    await addDeployment('p-hold', 'model-hold')
    costLimit.invalidateSpendCache()

    const result = await routeRequest({
      id: 'req-hold',
      model: 'model-hold',
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {},
      metadata: { sourceFormat: 'openai', gatewayKey: 'test-api-key', timestamp: Date.now() },
    })

    expect(result.finalProvider).toBe('p-hold')
    // Still held: the cost has not been persisted yet, so the request must
    // still be represented by its reservation.
    expect(costLimit.getReservedUsd('p-hold')).toBeGreaterThan(0)
    expect(costLimit.getInFlight('p-hold')).toBe(1)

    expect(typeof result.releaseInFlight).toBe('function')
    result.releaseInFlight!()
    expect(costLimit.getReservedUsd('p-hold')).toBe(0)
    expect(costLimit.getInFlight('p-hold')).toBe(0)
  })

  test('a served request is always represented by either a reservation or persisted spend', async () => {
    await addProvider('p-gap', { daily: 100 })
    await addDeployment('p-gap', 'model-gap')
    costLimit.invalidateSpendCache()

    expect((await chat('model-gap')).status).toBe(200)

    // The instant the client gets its response, logging is still in flight.
    // There must be no window in which the request is counted by neither side.
    const reserved = costLimit.getReservedUsd('p-gap')
    const spendNow = costLimit.peekSpend('p-gap')?.daily ?? 0
    expect(reserved > 0 || spendNow > 0).toBe(true)

    await Bun.sleep(50)
    // Once logging has completed the reservation is gone and the spend is real.
    expect(costLimit.getReservedUsd('p-gap')).toBe(0)
    costLimit.invalidateSpendCache()
    expect((await costLimit.getSpend('p-gap')).daily).toBeCloseTo(0.018, 10)
  })
})
