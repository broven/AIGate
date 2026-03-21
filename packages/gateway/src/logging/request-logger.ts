import { db, schema } from '../db'
import { sql } from 'drizzle-orm'
import type { RouteAttempt, UniversalResponse } from '@aigate/shared'
import type { RouteResult } from '../router/price-router'

interface LogParams {
  requestId: string
  model: string
  gatewayKey: string
  sourceFormat: 'openai' | 'gemini' | 'claude'
  routeResult: RouteResult
  response?: UniversalResponse
}

export async function logRequest(params: LogParams): Promise<void> {
  const { requestId, model, gatewayKey, sourceFormat, routeResult, response } = params

  const inputTokens = response?.usage.inputTokens ?? null
  const outputTokens = response?.usage.outputTokens ?? null

  // Calculate cost using the final provider's price
  let cost: number | null = null
  let savedVsDirect: number | null = null

  if (routeResult.finalProvider && inputTokens !== null && outputTokens !== null) {
    const successAttempt = routeResult.attempts.find(
      (a) => a.status === 'success',
    )
    if (successAttempt) {
      // price is effective price ($/1M tokens weighted)
      // For accurate cost: use actual input/output prices from deployment
      cost = successAttempt.price * (inputTokens + outputTokens) / 1_000_000
      if (routeResult.maxPrice > 0 && routeResult.maxPrice < Infinity) {
        const worstCost = routeResult.maxPrice * (inputTokens + outputTokens) / 1_000_000
        savedVsDirect = worstCost - cost
      }
    }
  }

  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  try {
    // Insert request log
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
      cost,
      savedVsDirect,
      success: routeResult.finalProvider !== null,
      createdAt: new Date().toISOString(),
    })

    // Update daily usage aggregation
    if (routeResult.finalProvider) {
      await db
        .insert(schema.dailyUsage)
        .values({
          date,
          gatewayKey,
          model,
          requestCount: 1,
          totalInputTokens: inputTokens ?? 0,
          totalOutputTokens: outputTokens ?? 0,
          totalCost: cost ?? 0,
          totalSaved: savedVsDirect ?? 0,
        })
        .onConflictDoUpdate({
          target: [schema.dailyUsage.date, schema.dailyUsage.gatewayKey, schema.dailyUsage.model],
          set: {
            requestCount: sql`request_count + 1`,
            totalInputTokens: sql`total_input_tokens + ${inputTokens ?? 0}`,
            totalOutputTokens: sql`total_output_tokens + ${outputTokens ?? 0}`,
            totalCost: sql`total_cost + ${cost ?? 0}`,
            totalSaved: sql`total_saved + ${savedVsDirect ?? 0}`,
          },
        })
    }
  } catch (error) {
    console.error('Failed to log request:', error)
  }
}
