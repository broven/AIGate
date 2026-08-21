import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { buildPricingIndex, lookupPrice, __setModelsDevCacheForTests } from '../sync/models-dev'
import { syncNewAPIProvider } from '../sync/newapi'
import { syncOpenAICompatibleProvider } from '../sync/openai-compat'

// ---------------------------------------------------------------------------
// models.dev provider-scoped matching (A6)
// ---------------------------------------------------------------------------

const MODELS_DEV_FIXTURE = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        name: 'Sonnet 4.5',
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
  'some-reseller': {
    id: 'some-reseller',
    name: 'Some Reseller',
    models: {
      // Same model id, wildly different price — the exact hazard a bare-id
      // index creates.
      'claude-sonnet-4-5': { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5', cost: { input: 999, output: 999 } },
    },
  },
  'cloudflare-workers-ai': {
    id: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    models: {
      '@cf/meta/llama-3.1-8b': {
        id: '@cf/meta/llama-3.1-8b',
        name: 'Llama 3.1 8B',
        cost: { input: 0.28, output: 0.83 },
      },
    },
  },
} as any

describe('models.dev lookup is provider-scoped', () => {
  const pricing = buildPricingIndex(MODELS_DEV_FIXTURE)

  test('an exact id under the right slug resolves', () => {
    expect(lookupPrice(pricing, 'claude-sonnet-4-5', 'anthropic')).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    })
  })

  test('the same id under another slug does NOT bleed its price', () => {
    expect(lookupPrice(pricing, 'claude-sonnet-4-5', 'some-reseller')!.input).toBe(999)
    expect(lookupPrice(pricing, 'claude-sonnet-4-5', 'anthropic')!.input).toBe(3)
  })

  test('without a provider context it refuses to guess', () => {
    expect(lookupPrice(pricing, 'claude-sonnet-4-5')).toBeNull()
    expect(lookupPrice(pricing, 'claude-sonnet-4-5', null)).toBeNull()
  })

  test('no bidirectional prefix fuzzing — a near miss is a miss', () => {
    expect(lookupPrice(pricing, 'claude-sonnet-4', 'anthropic')).toBeNull()
    expect(lookupPrice(pricing, 'claude-sonnet-4-5-20250929', 'anthropic')).toBeNull()
  })

  test('an unknown slug resolves nothing', () => {
    expect(lookupPrice(pricing, 'claude-sonnet-4-5', 'not-a-provider')).toBeNull()
  })

  test('cache rates are captured, not discarded', () => {
    const p = lookupPrice(pricing, 'claude-sonnet-4-5', 'anthropic')!
    expect(p.cacheRead).toBe(0.3)
    expect(p.cacheWrite).toBe(3.75)
  })

  test('a model with no cache rates reports null rather than 0', () => {
    const p = lookupPrice(pricing, '@cf/meta/llama-3.1-8b', 'cloudflare-workers-ai')!
    expect(p.cacheRead).toBeNull()
    expect(p.cacheWrite).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// NewAPI quota_type handling (A5)
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch

function mockNewAPI(pricingBody: unknown) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/pricing')) return Response.json(pricingBody)
    if (url.includes('/api/token/')) {
      return Response.json({
        data: [{ id: 1, key: 'group-token', name: 'aigate-default', group: 'default', status: 1 }],
      })
    }
    if (url.includes('models.dev')) return Response.json(MODELS_DEV_FIXTURE)
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
}

beforeEach(() => {
  __setModelsDevCacheForTests(MODELS_DEV_FIXTURE)
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('NewAPI pricing branches', () => {
  test('quota_type=1 writes pricePerCall and leaves token rates unset', async () => {
    mockNewAPI({
      success: true,
      group_ratio: { default: 2 },
      usable_group: {},
      data: [
        {
          model_name: 'per-call-model',
          model_ratio: 0,
          model_price: 0.05,
          quota_type: 1,
          completion_ratio: 4,
          enable_groups: ['default'],
        },
      ],
    })

    const { models } = await syncNewAPIProvider('https://relay.test', 'k', 0.5, [])
    expect(models).toHaveLength(1)

    // price * group_ratio * costMultiplier. No BASE_FACTOR (that is the
    // $2/1M ratio unit conversion) and no completion_ratio (there is no
    // token split to weight).
    expect(models[0].pricePerCall).toBeCloseTo(0.05 * 2 * 0.5, 12)
    expect(models[0].priceInput).toBeNull()
    expect(models[0].priceOutput).toBeNull()
    expect(models[0].priceSource).toBe('provider_api')
  })

  test('quota_type != 1 takes the model_ratio branch, unchanged', async () => {
    mockNewAPI({
      success: true,
      group_ratio: { default: 2 },
      usable_group: {},
      data: [
        {
          model_name: 'ratio-model',
          model_ratio: 1.5,
          model_price: 0,
          quota_type: 0,
          completion_ratio: 4,
          enable_groups: ['default'],
        },
      ],
    })

    const { models } = await syncNewAPIProvider('https://relay.test', 'k', 0.5, [])
    // BASE_FACTOR=2 and the group ratio are the confirmed-correct path.
    const base = 1.5 * 2 /* group */ * 2 /* BASE_FACTOR */ * 0.5 /* multiplier */
    expect(models[0].priceInput).toBeCloseTo(base, 5)
    expect(models[0].priceOutput).toBeCloseTo(base * 4, 5)
    expect(models[0].pricePerCall).toBeNull()
  })

  test('a model_price with a non-per-call quota_type is not billed per call', async () => {
    mockNewAPI({
      success: true,
      group_ratio: { default: 1 },
      usable_group: {},
      data: [
        {
          model_name: 'ambiguous-model',
          model_ratio: 1,
          model_price: 0.05,
          quota_type: 0,
          completion_ratio: 1,
          enable_groups: ['default'],
        },
      ],
    })

    const { models } = await syncNewAPIProvider('https://relay.test', 'k', 1, [])
    expect(models[0].pricePerCall).toBeNull()
    expect(models[0].priceInput).toBeCloseTo(1 * 1 * 2, 5)
  })

  test('models.dev fallback needs an explicit slug', async () => {
    const body = {
      success: true,
      group_ratio: { default: 1 },
      usable_group: {},
      data: [
        {
          model_name: 'claude-sonnet-4-5',
          model_ratio: 0,
          model_price: 0,
          quota_type: 0,
          completion_ratio: 1,
          enable_groups: ['default'],
        },
      ],
    }

    mockNewAPI(body)
    const without = await syncNewAPIProvider('https://relay.test', 'k', 1, [])
    expect(without.models[0].priceInput).toBeNull()
    expect(without.models[0].priceSource).toBe('unknown')

    mockNewAPI(body)
    const withSlug = await syncNewAPIProvider(
      'https://relay.test', 'k', 1, [], undefined, undefined, 'anthropic',
    )
    expect(withSlug.models[0].priceInput).toBe(3)
    expect(withSlug.models[0].priceOutput).toBe(15)
    expect(withSlug.models[0].priceCacheRead).toBe(0.3)
    expect(withSlug.models[0].priceSource).toBe('models_dev')
  })
})

describe('yunwu normalization lands in the right branch', () => {
  const yunwuBody = (priceType: number) => ({
    success: true,
    data: {
      model_info: { 'yw-model': { name: 'yw-model' } },
      model_completion_ratio: { 'yw-model': 3 },
      group_special: { 'yw-model': ['default'] },
      model_group: {
        default: { GroupRatio: 1, ModelPrice: { 'yw-model': { priceType, price: 2 } } },
      },
    },
  })

  test('priceType=1 becomes a per-call price', async () => {
    mockNewAPI(yunwuBody(1))
    const { models } = await syncNewAPIProvider('https://yunwu.test', 'k', 1, [])
    expect(models[0].pricePerCall).toBe(2)
    expect(models[0].priceInput).toBeNull()
  })

  test('priceType=0 becomes a per-token ratio, not a per-call charge', async () => {
    // Previously normalization forced model_ratio:0 and stuffed everything into
    // model_price, so a ratio-priced yunwu model was billed as if per-call.
    mockNewAPI(yunwuBody(0))
    const { models } = await syncNewAPIProvider('https://yunwu.test', 'k', 1, [])
    expect(models[0].pricePerCall).toBeNull()
    expect(models[0].priceInput).toBeCloseTo(2 * 1 * 2, 5)
    expect(models[0].priceOutput).toBeCloseTo(2 * 1 * 2 * 3, 5)
  })
})

// ---------------------------------------------------------------------------
// C1: model list and price source are decoupled
// ---------------------------------------------------------------------------

describe('openai-compatible: modelsDevSlug drives pricing', () => {
  function mockModelsEndpoint(body: unknown, ok = true) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('models.dev')) return Response.json(MODELS_DEV_FIXTURE)
      if (url.includes('/v1/models')) {
        return ok ? Response.json(body) : new Response('GET not supported for requested URI', { status: 405 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
  }

  test('a responding /v1/models still gets its prices from the slug', async () => {
    // This is the vLLM / Ollama / Azure case: the endpoint lists models and
    // publishes no prices at all.
    mockModelsEndpoint({ data: [{ id: 'claude-sonnet-4-5', object: 'model' }] })

    const { models } = await syncOpenAICompatibleProvider('https://vllm.test', 'k', 1, 'anthropic')
    expect(models).toHaveLength(1)
    expect(models[0].upstream).toBe('claude-sonnet-4-5')
    expect(models[0].priceInput).toBe(3)
    expect(models[0].priceSource).toBe('models_dev')
  })

  test('the slug outranks the endpoint list, not the endpoint list source', async () => {
    // The list still comes from /v1/models — only pricing is redirected.
    mockModelsEndpoint({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'a-local-finetune' }] })

    const { models } = await syncOpenAICompatibleProvider('https://vllm.test', 'k', 1, 'anthropic')
    expect(models.map((m) => m.upstream).sort()).toEqual(['a-local-finetune', 'claude-sonnet-4-5'])
    // The finetune is not in models.dev, so it stays unpriced — and A1 keeps
    // unpriced deployments out of routing rather than pricing them at Infinity.
    expect(models.find((m) => m.upstream === 'a-local-finetune')!.priceInput).toBeNull()
  })

  test('without a slug, a price-less endpoint yields unpriced deployments', async () => {
    mockModelsEndpoint({ data: [{ id: 'claude-sonnet-4-5' }] })

    const { models } = await syncOpenAICompatibleProvider('https://vllm.test', 'k', 1)
    expect(models[0].priceInput).toBeNull()
    expect(models[0].priceSource).toBe('unknown')
  })

  test('OpenRouter-style inline pricing is used when the slug misses', async () => {
    mockModelsEndpoint({
      data: [{ id: 'a-local-finetune', pricing: { prompt: '0.000001', completion: '0.000002' } }],
    })

    const { models } = await syncOpenAICompatibleProvider('https://openrouter.test', 'k', 1, 'anthropic')
    expect(models[0].priceInput).toBeCloseTo(1, 6)
    expect(models[0].priceOutput).toBeCloseTo(2, 6)
    expect(models[0].priceSource).toBe('provider_api')
  })

  test('a 405 on /v1/models falls back to the slug for the LIST too', async () => {
    // Cloudflare Workers AI: no /v1/models at all.
    mockModelsEndpoint(null, false)

    const { models } = await syncOpenAICompatibleProvider(
      'https://api.cloudflare.com/client/v4/accounts/acct/ai', 'k', 1, 'cloudflare-workers-ai',
    )
    expect(models).toHaveLength(1)
    expect(models[0].upstream).toBe('@cf/meta/llama-3.1-8b')
    expect(models[0].priceInput).toBe(0.28)
    expect(models[0].priceSource).toBe('models_dev')
  })
})
