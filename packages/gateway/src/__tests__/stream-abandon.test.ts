import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

const DB_PATH = '/tmp/aigate-stream-abandon-tests.db'
process.env.DATABASE_URL = DB_PATH
process.env.ADMIN_TOKEN = 'test-admin-token'

let app: { fetch: typeof fetch }
let db: any
let schema: any
let stopSyncScheduler: (() => void) | undefined
let costLimit: typeof import('../router/cost-limit')

const originalFetch = globalThis.fetch

/** True once the upstream body has been cancelled by the gateway. */
let upstreamCancelled = false
/** Resolves when the upstream stream is closed from either end. */
let upstreamClosed: Promise<void>

beforeAll(async () => {
  await import('../db/migrate')
  ;({ db, schema } = await import('../db'))
  ;({ stopSyncScheduler } = await import('../sync/engine'))
  costLimit = await import('../router/cost-limit')
  ;({ default: app } = await import('../index'))

  await db.delete(schema.gatewayKeys)
  await db.insert(schema.gatewayKeys).values({
    id: 'gw-1', name: 'test-key-name', keyPlain: 'test-api-key',
  })

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('models.dev')) return Response.json({})

    // An upstream that keeps generating until someone cancels it.
    let markClosed: () => void
    upstreamClosed = new Promise<void>((resolve) => { markClosed = resolve })
    let timer: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode(
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
        )
        controller.enqueue(chunk)
        timer = setInterval(() => {
          try { controller.enqueue(chunk) } catch { /* closed */ }
        }, 5)
      },
      cancel() {
        upstreamCancelled = true
        if (timer) clearInterval(timer)
        markClosed!()
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as typeof fetch
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
  upstreamCancelled = false
})

describe('unsupported stream conversion', () => {
  test('cancels the abandoned upstream stream and releases the reservation', async () => {
    // claude upstream -> openai client is not a supported stream conversion,
    // so the gateway answers 501 and nobody ever reads the upstream body.
    await db.insert(schema.providers).values({
      id: 'p-claude', type: 'openai-compatible', apiFormat: 'claude',
      endpoint: 'https://claude.test', apiKey: 'k', syncEnabled: false,
      dailyCostLimitUsd: 100,
    })
    await db.insert(schema.modelDeployments).values({
      deploymentId: 'p-claude-model-s', providerId: 'p-claude',
      canonical: 'model-s', upstream: 'model-s',
      priceInput: 3, priceOutput: 15, priceSource: 'models_dev',
      status: 'active', lastSyncAt: new Date().toISOString(),
    })

    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-api-key' },
      body: JSON.stringify({ model: 'model-s', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }))
    expect(res.status).toBe(501)
    await res.text()

    // The upstream must not be left generating (and billing) after the request
    // has been answered.
    await upstreamClosed
    expect(upstreamCancelled).toBe(true)

    // The 501 is still logged (PLAN A3) and the reservation is still released.
    await Bun.sleep(30)
    const logs = await db.select().from(schema.requestLogs)
    expect(logs).toHaveLength(1)
    expect(logs[0].usageMissing).toBe(true)
    expect(costLimit.getReservedUsd('p-claude')).toBe(0)
  })
})
