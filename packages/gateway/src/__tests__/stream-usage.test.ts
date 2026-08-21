import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { extractUsageFromStream } from '../logging/stream-usage-extractor'
import type { ApiFormat } from '../adapters/registry'

const DB_PATH = '/tmp/aigate-stream-usage-tests.db'
process.env.DATABASE_URL = DB_PATH
process.env.ADMIN_TOKEN = 'test-admin-token'

// --- Extractor unit tests --------------------------------------------------

function sse(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l))
      controller.close()
    },
  })
}

async function drain(
  lines: string[],
  format: ApiFormat,
): Promise<{ usage: Awaited<ReturnType<typeof extractUsageFromStream>['usage']>; text: string }> {
  const { passthrough, usage } = extractUsageFromStream(sse(lines), format)
  const text = await new Response(passthrough).text()
  return { usage: await usage, text }
}

describe('stream usage extraction', () => {
  test('a stream with no usage chunk resolves null, not zero', async () => {
    const { usage, text } = await drain(
      [
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: [DONE]\n\n',
      ],
      'openai',
    )
    expect(usage).toBeNull()
    // The client still sees every byte.
    expect(text).toContain('[DONE]')
  })

  test('openai usage lands in disjoint buckets', async () => {
    const { usage } = await drain(
      [
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1000,"completion_tokens":500,' +
          '"prompt_tokens_details":{"cached_tokens":400},' +
          '"completion_tokens_details":{"reasoning_tokens":200}}}\n\n',
        'data: [DONE]\n\n',
      ],
      'openai',
    )
    // 1000 prompt = 600 fresh + 400 cached; 500 completion = 300 text + 200 reasoning
    expect(usage).toEqual({
      inputTokens: 600,
      outputTokens: 300,
      cachedInputTokens: 400,
      cacheWriteTokens: undefined,
      reasoningTokens: 200,
    })
  })

  test('anthropic usage is accumulated across events and cache buckets kept apart', async () => {
    const { usage } = await drain(
      [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":700,' +
          '"cache_creation_input_tokens":50,"output_tokens":1}}}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","usage":{"output_tokens":420}}\n\n',
      ],
      'claude',
    )
    expect(usage?.inputTokens).toBe(100)
    expect(usage?.cachedInputTokens).toBe(700)
    expect(usage?.cacheWriteTokens).toBe(50)
    expect(usage?.outputTokens).toBe(420)
  })

  test('gemini thoughts are split out of the output bucket', async () => {
    const { usage } = await drain(
      [
        'data: {"usageMetadata":{"promptTokenCount":900,"candidatesTokenCount":300,' +
          '"cachedContentTokenCount":400,"thoughtsTokenCount":100}}\n\n',
      ],
      'gemini',
    )
    expect(usage?.inputTokens).toBe(500)   // 900 - 400 cached
    expect(usage?.cachedInputTokens).toBe(400)
    expect(usage?.outputTokens).toBe(300)
    expect(usage?.reasoningTokens).toBe(100)
  })

  test('a usage event split across chunk boundaries is still parsed', async () => {
    const line = 'data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n'
    const { usage } = await drain([line.slice(0, 17), line.slice(17)], 'openai')
    expect(usage?.inputTokens).toBe(10)
    expect(usage?.outputTokens).toBe(20)
  })
})

// --- End-to-end: an unmetered stream must not look free --------------------

describe('a streaming request whose upstream reports no usage', () => {
  let app: { fetch: typeof fetch }
  let db: any
  let schema: any
  let stopSyncScheduler: (() => void) | undefined
  const originalFetch = globalThis.fetch

  function upstreamStream(withUsage: boolean) {
    const enc = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
        if (withUsage) {
          controller.enqueue(enc.encode(
            'data: {"usage":{"prompt_tokens":1000,"completion_tokens":1000}}\n\n',
          ))
        }
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
  }

  let sendUsage = false

  beforeAll(async () => {
    await import('../db/migrate')
    ;({ db, schema } = await import('../db'))
    ;({ stopSyncScheduler } = await import('../sync/engine'))
    ;({ default: app } = await import('../index'))

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('models.dev')) return Response.json({})
      return new Response(upstreamStream(sendUsage), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

    await db.delete(schema.requestLogs)
    await db.delete(schema.dailyUsage)
    await db.delete(schema.providerDailySpend)
    await db.delete(schema.modelDeployments)
    await db.delete(schema.gatewayKeys)
    await db.delete(schema.providers)

    await db.insert(schema.gatewayKeys).values({
      id: 'gw-1', name: 'stream-key', keyPlain: 'test-api-key',
    })
    await db.insert(schema.providers).values({
      id: 'p-stream', type: 'openai-compatible', endpoint: 'https://p.test',
      apiKey: 'k', syncEnabled: false,
    })
    await db.insert(schema.modelDeployments).values({
      deploymentId: 'p-stream-m', providerId: 'p-stream', canonical: 'model-s',
      upstream: 'model-s', priceInput: 3, priceOutput: 15,
      priceSource: 'models_dev', status: 'active', lastSyncAt: new Date().toISOString(),
    })
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
    stopSyncScheduler?.()
  })

  beforeEach(async () => {
    await db.delete(schema.requestLogs)
    await db.delete(schema.dailyUsage)
    await db.delete(schema.providerDailySpend)
  })

  async function streamChat() {
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-api-key' },
      body: JSON.stringify({
        model: 'model-s', stream: true, messages: [{ role: 'user', content: 'hi' }],
      }),
    }))
    // The log is written after the body drains, so the client must read it all.
    await res.text()
    await Bun.sleep(30)
    return res
  }

  test('is flagged usageMissing with a null cost', async () => {
    sendUsage = false
    const res = await streamChat()
    expect(res.status).toBe(200)

    const [log] = await db.select().from(schema.requestLogs)
    expect(log.usageMissing).toBe(true)
    expect(log.cost).toBeNull()
    expect(log.inputTokens).toBeNull()
    expect(log.outputTokens).toBeNull()
    // It still succeeded — unmetered is not the same as failed.
    expect(log.success).toBe(true)
    expect(log.finalProvider).toBe('p-stream')
  })

  test('contributes a request to daily_usage but no tokens or cost', async () => {
    sendUsage = false
    await streamChat()

    const [row] = await db.select().from(schema.dailyUsage)
    expect(row.requestCount).toBe(1)
    expect(row.totalInputTokens).toBe(0)
    expect(row.totalOutputTokens).toBe(0)
    expect(row.totalCost).toBe(0)
  })

  test('adds nothing to the Provider spend, so a Cost Limit is not fooled', async () => {
    sendUsage = false
    await streamChat()

    const rows = await db.select().from(schema.providerDailySpend)
    expect(rows.filter((r: any) => r.costUsd > 0)).toHaveLength(0)
  })

  test('the same stream WITH a usage chunk is fully metered', async () => {
    sendUsage = true
    await streamChat()

    const [log] = await db.select().from(schema.requestLogs)
    expect(log.usageMissing).toBe(false)
    expect(log.inputTokens).toBe(1000)
    expect(log.outputTokens).toBe(1000)
    expect(log.cost).toBeCloseTo(0.018, 10) // 1000@$3/1M + 1000@$15/1M

    const [row] = await db.select().from(schema.dailyUsage)
    expect(row.requestCount).toBe(1)
    expect(row.totalCost).toBeCloseTo(0.018, 10)
  })
})
