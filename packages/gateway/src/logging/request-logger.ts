import { db, schema } from '../db'
import { sql } from 'drizzle-orm'
import type { UniversalResponse } from '@aigate/shared'
import type { RouteResult } from '../router/price-router'
import { computeCost, computeSavedVsDirect, type TokenUsage } from '../pricing/cost'
import { getModelsDevPricing, lookupFirstPartyPrice } from '../sync/models-dev'
import { addSpend, utcDateOf } from '../router/cost-limit'

interface LogParams {
  requestId: string
  model: string
  gatewayKey: string
  sourceFormat: 'openai' | 'gemini' | 'claude'
  routeResult: RouteResult
  response?: UniversalResponse
  virtualModelName?: string
}

/**
 * The baseline "Saved vs Direct" is measured against: the first-party vendor's
 * official list price for this canonical model. Resolving it can fail — an
 * unknown vendor prefix, a model models.dev doesn't list — and when it does the
 * savings figure is omitted rather than approximated.
 */
async function firstPartyRates(canonical: string) {
  try {
    const pricing = await getModelsDevPricing()
    const price = lookupFirstPartyPrice(pricing, canonical)
    if (!price) return null
    return {
      priceInput: price.input,
      priceOutput: price.output,
      priceCacheRead: price.cacheRead,
      priceCacheWrite: price.cacheWrite,
      pricePerCall: null,
    }
  } catch {
    return null
  }
}

export async function logRequest(params: LogParams): Promise<void> {
  const { requestId, model, gatewayKey, sourceFormat, routeResult, response } = params

  // A request that reached an upstream but never reported usage is NOT free.
  // It is recorded as unknown so it can never be confused with a genuinely
  // zero-cost request when the numbers are summed later.
  const usageKnown = response !== undefined
  const usageMissing = routeResult.finalProvider !== null && !usageKnown

  const inputTokens = usageKnown ? response!.usage.inputTokens : null
  const outputTokens = usageKnown ? response!.usage.outputTokens : null
  const cachedInputTokens = usageKnown ? response!.usage.cachedInputTokens ?? null : null
  const cacheWriteTokens = usageKnown ? response!.usage.cacheWriteTokens ?? null : null
  const reasoningTokens = usageKnown ? response!.usage.reasoningTokens ?? null : null

  let cost: number | null = null
  let savedVsDirect: number | null = null

  if (routeResult.finalProvider && usageKnown && routeResult.finalRates) {
    const usage: TokenUsage = {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cachedInputTokens,
      cacheWriteTokens,
      reasoningTokens,
    }
    cost = computeCost(routeResult.finalRates, usage)
    // The baseline is the first-party price of the CANONICAL model that was
    // actually served (PLAN A7). For a virtual model, `model` is the alias the
    // client asked for and would resolve to nothing — or to an unrelated model
    // that happens to look like a vendor name.
    const baselineModel = routeResult.finalCanonical ?? model
    savedVsDirect = computeSavedVsDirect(cost, await firstPartyRates(baselineModel), usage)
  }

  // Only finite values may reach an aggregate: an Infinity or NaN summed into
  // daily_usage poisons that row permanently (see docs/adr/0003).
  const costIsBillable = cost !== null && Number.isFinite(cost)
  const savedIsBillable = savedVsDirect !== null && Number.isFinite(savedVsDirect)
  const billableCost = costIsBillable ? cost! : null
  const billableSaved = savedIsBillable ? savedVsDirect! : null

  const date = utcDateOf()

  try {
    await db.insert(schema.requestLogs).values({
      id: requestId,
      model,
      gatewayKey,
      sourceFormat,
      attempts: JSON.stringify(routeResult.attempts),
      finalProvider: routeResult.finalProvider,
      totalLatencyMs: routeResult.totalLatencyMs,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      reasoningTokens,
      usageMissing,
      cost: billableCost,
      savedVsDirect: billableSaved,
      success: routeResult.finalProvider !== null,
      virtualModelName: params.virtualModelName ?? null,
      createdAt: new Date().toISOString(),
    })

    if (routeResult.finalProvider) {
      // The request happened, so requestCount always advances. Tokens and cost
      // only advance when they are actually known and finite.
      await db
        .insert(schema.dailyUsage)
        .values({
          date,
          gatewayKey,
          model,
          requestCount: 1,
          totalInputTokens: inputTokens ?? 0,
          totalOutputTokens: outputTokens ?? 0,
          totalCost: billableCost ?? 0,
          totalSaved: billableSaved ?? 0,
        })
        .onConflictDoUpdate({
          target: [schema.dailyUsage.date, schema.dailyUsage.gatewayKey, schema.dailyUsage.model],
          set: {
            requestCount: sql`request_count + 1`,
            totalInputTokens: sql`total_input_tokens + ${inputTokens ?? 0}`,
            totalOutputTokens: sql`total_output_tokens + ${outputTokens ?? 0}`,
            totalCost: sql`total_cost + ${billableCost ?? 0}`,
            totalSaved: sql`total_saved + ${billableSaved ?? 0}`,
          },
        })

      // Provider-level Spend, the counter the Cost Limit reads.
      if (billableCost !== null) {
        await addSpend(routeResult.finalProvider, billableCost)
      }
    }
  } catch (error) {
    console.error('Failed to log request:', error)
  }
}
