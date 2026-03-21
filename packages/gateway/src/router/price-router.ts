import { eq, and } from 'drizzle-orm'
import { db, schema } from '../db'
import type { UniversalRequest, UniversalResponse, RouteAttempt } from '@aigate/shared'
import { sendToOpenAICompatible, parseOpenAIResponse } from '../adapters/outbound/openai'
import {
  isInCooldown,
  enterCooldown,
  enterProviderCooldown,
  getProvidersInCooldown,
  liftExpiredCooldowns,
} from './cooldown'
import { formatOpenAIStreamChunk } from '../adapters/inbound/openai'

interface Deployment {
  deploymentId: string
  providerId: string
  upstream: string
  groupName: string | null
  effectivePrice: number
  priceInput: number
  priceOutput: number
  endpoint: string
  apiKey: string
}

function getEffectivePrice(d: {
  priceInput: number | null
  priceOutput: number | null
  manualPriceInput: number | null
  manualPriceOutput: number | null
  priceSource: string
}): { input: number; output: number; effective: number } {
  const input = d.manualPriceInput ?? d.priceInput ?? Infinity
  const output = d.manualPriceOutput ?? d.priceOutput ?? Infinity
  // Weighted: 30% input + 70% output (output dominates cost)
  const effective = input * 0.3 + output * 0.7
  return { input, output, effective }
}

async function getDeploymentsForModel(model: string): Promise<Deployment[]> {
  const rows = await db
    .select({
      deploymentId: schema.modelDeployments.deploymentId,
      providerId: schema.modelDeployments.providerId,
      upstream: schema.modelDeployments.upstream,
      groupName: schema.modelDeployments.groupName,
      priceInput: schema.modelDeployments.priceInput,
      priceOutput: schema.modelDeployments.priceOutput,
      manualPriceInput: schema.modelDeployments.manualPriceInput,
      manualPriceOutput: schema.modelDeployments.manualPriceOutput,
      priceSource: schema.modelDeployments.priceSource,
      endpoint: schema.providers.endpoint,
      apiKey: schema.providers.apiKey,
    })
    .from(schema.modelDeployments)
    .innerJoin(schema.providers, eq(schema.modelDeployments.providerId, schema.providers.id))
    .where(
      and(
        eq(schema.modelDeployments.canonical, model),
        eq(schema.modelDeployments.status, 'active'),
      ),
    )

  return rows.map((r) => {
    const prices = getEffectivePrice(r)
    return {
      deploymentId: r.deploymentId,
      providerId: r.providerId,
      upstream: r.upstream,
      groupName: r.groupName,
      effectivePrice: prices.effective,
      priceInput: prices.input,
      priceOutput: prices.output,
      endpoint: r.endpoint,
      apiKey: r.apiKey,
    }
  })
}

function classifyError(status: number): 'client' | 'auth' | 'rate_limit' | 'server' {
  if (status === 400 || status === 422) return 'client'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  return 'server'
}

export interface RouteResult {
  response?: UniversalResponse
  streamResponse?: Response
  attempts: RouteAttempt[]
  finalProvider: string | null
  totalLatencyMs: number
  maxPrice: number // For savedVsDirect calculation
}

export async function routeRequest(req: UniversalRequest): Promise<RouteResult> {
  const startTime = Date.now()
  const attempts: RouteAttempt[] = []
  const allDeployments = await getDeploymentsForModel(req.model)

  if (allDeployments.length === 0) {
    return {
      attempts: [],
      finalProvider: null,
      totalLatencyMs: Date.now() - startTime,
      maxPrice: 0,
    }
  }

  // Track max price for savings calculation
  const maxPrice = Math.max(
    ...allDeployments
      .filter((d) => d.effectivePrice < Infinity)
      .map((d) => d.effectivePrice),
    0,
  )

  // Sort by price
  const sorted = [...allDeployments].sort((a, b) => a.effectivePrice - b.effectivePrice)

  // Phase 1: Try non-cooldown providers
  const cooldownProviders = getProvidersInCooldown(req.model)
  const available = sorted.filter((d) => !cooldownProviders.has(d.providerId))
  const inCooldown = sorted.filter((d) => cooldownProviders.has(d.providerId))

  // Log skipped providers
  for (const d of inCooldown) {
    attempts.push({
      provider: d.providerId,
      deploymentId: d.deploymentId,
      price: d.effectivePrice,
      status: 'skipped_cooldown',
    })
  }

  const failedThisCycle = new Set<string>()

  // Try available providers
  for (const deployment of available) {
    const result = await tryDeployment(req, deployment)
    attempts.push(result.attempt)

    if (result.attempt.status === 'success') {
      return {
        response: result.response,
        streamResponse: result.streamResponse,
        attempts,
        finalProvider: deployment.providerId,
        totalLatencyMs: Date.now() - startTime,
        maxPrice,
      }
    }
    failedThisCycle.add(deployment.providerId)
  }

  // Phase 2: Lift prior cooldowns and retry previously-excluded providers
  for (const deployment of inCooldown) {
    if (failedThisCycle.has(deployment.providerId)) continue
    liftExpiredCooldowns(deployment.providerId, req.model)

    const result = await tryDeployment(req, deployment)
    // Replace the skipped_cooldown entry
    const idx = attempts.findIndex(
      (a) => a.deploymentId === deployment.deploymentId && a.status === 'skipped_cooldown',
    )
    if (idx !== -1) {
      attempts[idx] = result.attempt
    } else {
      attempts.push(result.attempt)
    }

    if (result.attempt.status === 'success') {
      return {
        response: result.response,
        streamResponse: result.streamResponse,
        attempts,
        finalProvider: deployment.providerId,
        totalLatencyMs: Date.now() - startTime,
        maxPrice,
      }
    }
  }

  // All failed
  return {
    attempts,
    finalProvider: null,
    totalLatencyMs: Date.now() - startTime,
    maxPrice,
  }
}

async function tryDeployment(
  req: UniversalRequest,
  deployment: Deployment,
): Promise<{
  attempt: RouteAttempt
  response?: UniversalResponse
  streamResponse?: Response
}> {
  const attemptStart = Date.now()

  try {
    const upstreamResponse = await sendToOpenAICompatible(
      req,
      deployment.endpoint,
      deployment.apiKey,
      deployment.upstream,
    )

    const latencyMs = Date.now() - attemptStart

    if (!upstreamResponse.ok) {
      const errorType = classifyError(upstreamResponse.status)
      const errorBody = await upstreamResponse.text().catch(() => '')

      // Client errors: don't fallback, don't cooldown
      if (errorType === 'client') {
        return {
          attempt: {
            provider: deployment.providerId,
            deploymentId: deployment.deploymentId,
            price: deployment.effectivePrice,
            status: 'failed',
            error: `${upstreamResponse.status}: ${errorBody.slice(0, 200)}`,
            latencyMs,
          },
        }
      }

      // Auth errors: cooldown entire provider
      if (errorType === 'auth') {
        enterProviderCooldown(deployment.providerId)
      } else if (errorType === 'rate_limit') {
        const retryAfter = parseInt(upstreamResponse.headers.get('retry-after') || '', 10)
        enterCooldown(
          deployment.providerId,
          req.model,
          isNaN(retryAfter) ? undefined : retryAfter,
        )
      } else {
        enterCooldown(deployment.providerId, req.model)
      }

      return {
        attempt: {
          provider: deployment.providerId,
          deploymentId: deployment.deploymentId,
          price: deployment.effectivePrice,
          status: 'failed',
          error: `${upstreamResponse.status}: ${errorBody.slice(0, 200)}`,
          latencyMs,
        },
      }
    }

    // Streaming: return the raw response for pipe-through
    if (req.parameters.stream) {
      return {
        attempt: {
          provider: deployment.providerId,
          deploymentId: deployment.deploymentId,
          price: deployment.effectivePrice,
          status: 'success',
          latencyMs,
        },
        streamResponse: upstreamResponse,
      }
    }

    // Non-streaming: parse full response
    const rawJson = await upstreamResponse.json()
    const parsed = parseOpenAIResponse(rawJson as Record<string, unknown>)

    return {
      attempt: {
        provider: deployment.providerId,
        deploymentId: deployment.deploymentId,
        price: deployment.effectivePrice,
        status: 'success',
        latencyMs,
      },
      response: parsed,
    }
  } catch (error) {
    const latencyMs = Date.now() - attemptStart
    enterCooldown(deployment.providerId, req.model)

    return {
      attempt: {
        provider: deployment.providerId,
        deploymentId: deployment.deploymentId,
        price: deployment.effectivePrice,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        latencyMs,
      },
    }
  }
}
