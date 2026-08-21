import { describe, expect, test } from 'bun:test'
import { computeCost, computeSavedVsDirect } from '../pricing/cost'
import { getEffectivePrice } from '../pricing/deployment-price'
import { buildPricingIndex, lookupFirstPartyPrice } from '../sync/models-dev'
import { parseOpenAIResponse } from '../adapters/outbound/openai'
import { parseAnthropicResponse } from '../adapters/outbound/anthropic'
import { parseGeminiResponse } from '../adapters/outbound/gemini'

describe('computeCost — base formula', () => {
  test('prices input and output separately, per 1M tokens', () => {
    const cost = computeCost(
      { priceInput: 3, priceOutput: 15 },
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    )
    expect(cost).toBe(18)
  })

  test('scales linearly below 1M tokens', () => {
    const cost = computeCost(
      { priceInput: 3, priceOutput: 15 },
      { inputTokens: 1000, outputTokens: 500 },
    )
    expect(cost).toBeCloseTo((1000 * 3 + 500 * 15) / 1_000_000, 12)
  })
})

describe('computeCost — cache and reasoning dimensions', () => {
  test('cache reads and writes bill at their own rates', () => {
    const cost = computeCost(
      { priceInput: 3, priceOutput: 15, priceCacheRead: 0.3, priceCacheWrite: 3.75 },
      { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 10_000, cacheWriteTokens: 2000 },
    )
    expect(cost).toBeCloseTo(
      (1000 * 3 + 100 * 15 + 10_000 * 0.3 + 2000 * 3.75) / 1_000_000,
      12,
    )
  })

  test('falls back to the input rate when no cache rate is published', () => {
    const withFallback = computeCost(
      { priceInput: 3, priceOutput: 15 },
      { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 5000 },
    )
    expect(withFallback).toBeCloseTo((1000 * 3 + 5000 * 3) / 1_000_000, 12)
  })

  test('reasoning tokens bill at the output rate', () => {
    const cost = computeCost(
      { priceInput: 3, priceOutput: 15 },
      { inputTokens: 0, outputTokens: 100, reasoningTokens: 900 },
    )
    expect(cost).toBeCloseTo((1000 * 15) / 1_000_000, 12)
  })
})

describe('usage normalization keeps the buckets disjoint', () => {
  test('Anthropic cache_read / cache_creation are carried through as-is', () => {
    const parsed = parseAnthropicResponse({
      id: 'msg_1',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 200,
      },
    } as any)

    // Anthropic's input_tokens already excludes the cache buckets.
    expect(parsed.usage.inputTokens).toBe(100)
    expect(parsed.usage.cachedInputTokens).toBe(4000)
    expect(parsed.usage.cacheWriteTokens).toBe(200)
  })

  test('OpenAI cached_tokens are split OUT of prompt_tokens', () => {
    const parsed = parseOpenAIResponse({
      id: 'x',
      model: 'gpt-4o',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens_details: { reasoning_tokens: 250 },
      },
    } as any)

    // prompt_tokens INCLUDES the cached ones; billing them again would double-charge.
    expect(parsed.usage.inputTokens).toBe(200)
    expect(parsed.usage.cachedInputTokens).toBe(800)
    // completion_tokens INCLUDES reasoning; same hazard.
    expect(parsed.usage.outputTokens).toBe(50)
    expect(parsed.usage.reasoningTokens).toBe(250)

    // The totals still reconcile against the raw report.
    expect(parsed.usage.inputTokens + parsed.usage.cachedInputTokens!).toBe(1000)
    expect(parsed.usage.outputTokens + parsed.usage.reasoningTokens!).toBe(300)
  })

  test('Gemini thoughts are additive, cachedContent is subtractive', () => {
    const parsed = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 200,
        cachedContentTokenCount: 600,
        thoughtsTokenCount: 400,
      },
    } as any)

    expect(parsed.usage.inputTokens).toBe(400)
    expect(parsed.usage.cachedInputTokens).toBe(600)
    // candidatesTokenCount EXCLUDES thoughts, so thoughts are extra output.
    expect(parsed.usage.outputTokens).toBe(200)
    expect(parsed.usage.reasoningTokens).toBe(400)
  })
})

describe('computeCost — per-call pricing', () => {
  test('pricePerCall ignores token rates entirely', () => {
    const cost = computeCost(
      { priceInput: 3, priceOutput: 15, pricePerCall: 0.02 },
      { inputTokens: 999_999, outputTokens: 999_999 },
    )
    expect(cost).toBe(0.02)
  })

  test('a zero per-call price is a real price, not a missing one', () => {
    expect(
      computeCost({ priceInput: null, priceOutput: null, pricePerCall: 0 }, { inputTokens: 10, outputTokens: 10 }),
    ).toBe(0)
  })

  test('a non-finite per-call price yields null', () => {
    expect(
      computeCost({ priceInput: 3, priceOutput: 15, pricePerCall: Infinity }, { inputTokens: 1, outputTokens: 1 }),
    ).toBeNull()
  })
})

describe('computeCost — non-finite guards', () => {
  test('a missing rate yields null, not Infinity', () => {
    expect(computeCost({ priceInput: null, priceOutput: 15 }, { inputTokens: 10, outputTokens: 10 })).toBeNull()
    expect(computeCost({ priceInput: 3, priceOutput: null }, { inputTokens: 10, outputTokens: 10 })).toBeNull()
  })

  test('an unpriced model under a non-zero multiplier stays unpriced, and a NaN rate never bills', () => {
    const prices = getEffectivePrice({
      priceInput: null,
      priceOutput: null,
      manualPriceInput: null,
      manualPriceOutput: null,
      priceCacheRead: null,
      priceCacheWrite: null,
      pricePerCall: null,
      costMultiplier: 1,
    })
    expect(prices.priced).toBe(false)

    // The guard has to hold for NaN as much as for Infinity, whatever produced
    // it — 0 * Infinity is the way it used to arise here.
    expect(Number.isNaN(0 * Infinity)).toBe(true)
    expect(computeCost({ priceInput: NaN, priceOutput: NaN }, { inputTokens: 10, outputTokens: 10 })).toBeNull()
    expect(
      computeCost(
        { priceInput: prices.priceInput, priceOutput: prices.priceOutput },
        { inputTokens: 0, outputTokens: 0 },
      ),
    ).toBeNull()
  })

  test('an unpriced deployment is not routable', () => {
    const priced = getEffectivePrice({
      priceInput: 3,
      priceOutput: 15,
      manualPriceInput: null,
      manualPriceOutput: null,
      priceCacheRead: null,
      priceCacheWrite: null,
      pricePerCall: null,
      costMultiplier: 1,
    })
    expect(priced.priced).toBe(true)

    const halfPriced = getEffectivePrice({
      priceInput: 3,
      priceOutput: null,
      manualPriceInput: null,
      manualPriceOutput: null,
      priceCacheRead: null,
      priceCacheWrite: null,
      pricePerCall: null,
      costMultiplier: 1,
    })
    expect(halfPriced.priced).toBe(false)
  })
})

describe('getEffectivePrice — Cost Multiplier is applied exactly once', () => {
  test('manual prices are corrected by the multiplier', () => {
    const p = getEffectivePrice({
      priceInput: 100,
      priceOutput: 100,
      manualPriceInput: 10,
      manualPriceOutput: 20,
      priceCacheRead: null,
      priceCacheWrite: null,
      pricePerCall: null,
      costMultiplier: 0.5,
    })
    expect(p.priceInput).toBe(5)
    expect(p.priceOutput).toBe(10)
  })

  test('synced prices already include it and are NOT multiplied again', () => {
    const p = getEffectivePrice({
      priceInput: 3,
      priceOutput: 15,
      manualPriceInput: null,
      manualPriceOutput: null,
      priceCacheRead: null,
      priceCacheWrite: null,
      pricePerCall: null,
      costMultiplier: 0.5,
    })
    expect(p.priceInput).toBe(3)
    expect(p.priceOutput).toBe(15)
  })
})

describe('computeSavedVsDirect', () => {
  const pricing = buildPricingIndex({
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic',
      models: {
        'claude-sonnet-4-5': { id: 'claude-sonnet-4-5', name: 'Sonnet', cost: { input: 3, output: 15 } },
      },
    },
  } as any)

  test('resolvable first party produces a savings figure', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    const firstParty = lookupFirstPartyPrice(pricing, 'claude-sonnet-4-5')
    expect(firstParty).not.toBeNull()

    const actual = computeCost({ priceInput: 1, priceOutput: 5 }, usage)
    const saved = computeSavedVsDirect(actual, {
      priceInput: firstParty!.input,
      priceOutput: firstParty!.output,
    }, usage)

    expect(actual).toBe(6)
    expect(saved).toBe(12) // 18 at list price - 6 actually paid
  })

  test('unresolvable first party yields null rather than an approximation', () => {
    // No vendor prefix maps this id, so there is no official price to compare to.
    expect(lookupFirstPartyPrice(pricing, 'some-local-finetune-v3')).toBeNull()
    expect(
      computeSavedVsDirect(6, null, { inputTokens: 1000, outputTokens: 1000 }),
    ).toBeNull()
  })

  test('a first party present by name but absent from models.dev yields null', () => {
    expect(lookupFirstPartyPrice(pricing, 'claude-opus-9')).toBeNull()
  })

  test('null actual cost yields null savings', () => {
    expect(
      computeSavedVsDirect(null, { priceInput: 3, priceOutput: 15 }, { inputTokens: 1, outputTokens: 1 }),
    ).toBeNull()
  })
})

describe('getEffectivePrice — a zero Cost Multiplier declares the Provider free', () => {
  const free = {
    manualPriceInput: null,
    manualPriceOutput: null,
    priceCacheRead: null,
    priceCacheWrite: null,
    pricePerCall: null,
    costMultiplier: 0,
  }

  test('an unpriced Deployment resolves to 0 and stays routable', () => {
    // Ollama Cloud is the real case: a flat-rate subscription whose models
    // models.dev lists with no cost at all. Before this rule those Deployments
    // resolved to Infinity, counted as unpriced, and silently left routing.
    const p = getEffectivePrice({ ...free, priceInput: null, priceOutput: null })
    expect(p.priced).toBe(true)
    expect(p.priceInput).toBe(0)
    expect(p.priceOutput).toBe(0)
    expect(p.effective).toBe(0)
  })

  test('a priced Deployment is also free — the multiplier still means what it says', () => {
    const p = getEffectivePrice({ ...free, priceInput: 3, priceOutput: 15 })
    expect(p.priced).toBe(true)
    expect(p.priceInput).toBe(0)
    expect(p.priceOutput).toBe(0)
  })

  test('manual prices are overridden too', () => {
    const p = getEffectivePrice({
      ...free,
      priceInput: null,
      priceOutput: null,
      manualPriceInput: 99,
      manualPriceOutput: 99,
    })
    expect(p.priceInput).toBe(0)
    expect(p.priceOutput).toBe(0)
  })

  test('cache and per-call rates collapse to 0, and a non-per-call Deployment stays non-per-call', () => {
    const perToken = getEffectivePrice({
      ...free,
      priceInput: 3,
      priceOutput: 15,
      priceCacheRead: 0.3,
      priceCacheWrite: 3.75,
    })
    expect(perToken.priceCacheRead).toBe(0)
    expect(perToken.priceCacheWrite).toBe(0)
    expect(perToken.pricePerCall).toBeNull()

    const perCall = getEffectivePrice({ ...free, priceInput: null, priceOutput: null, pricePerCall: 0.1 })
    expect(perCall.pricePerCall).toBe(0)
    expect(perCall.priced).toBe(true)
    expect(perCall.effective).toBe(0)
  })

  test('a free Deployment outranks every priced one', () => {
    const freeP = getEffectivePrice({ ...free, priceInput: null, priceOutput: null })
    const cheap = getEffectivePrice({
      priceInput: 0.03,
      priceOutput: 0.12,
      manualPriceInput: null,
      manualPriceOutput: null,
      priceCacheRead: null,
      priceCacheWrite: null,
      pricePerCall: null,
      costMultiplier: 1,
    })
    expect(freeP.effective).toBeLessThan(cheap.effective)
  })

  test('a negative or absent multiplier is not a free declaration', () => {
    const absent = getEffectivePrice({
      priceInput: null,
      priceOutput: null,
      manualPriceInput: null,
      manualPriceOutput: null,
      priceCacheRead: null,
      priceCacheWrite: null,
      pricePerCall: null,
      costMultiplier: null,
    })
    expect(absent.priced).toBe(false)
  })

  test('the resolved zero rates produce a real 0 cost, not null', () => {
    const p = getEffectivePrice({ ...free, priceInput: null, priceOutput: null })
    expect(
      computeCost({ priceInput: p.priceInput, priceOutput: p.priceOutput }, { inputTokens: 5000, outputTokens: 900 }),
    ).toBe(0)
  })
})
