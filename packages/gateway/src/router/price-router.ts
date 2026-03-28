import { eq, and } from 'drizzle-orm'
import { db, schema } from '../db'
import type { UniversalRequest, UniversalResponse, RouteAttempt } from '@aigate/shared'
import { sendToOpenAICompatible, parseOpenAIResponse } from '../adapters/outbound/openai'
import { sendToAnthropic, parseAnthropicResponse } from '../adapters/outbound/anthropic'
import { sendToGemini, parseGeminiResponse } from '../adapters/outbound/gemini'
import {
  isInCooldown,
  enterCooldown,
  liftCooldown,
} from './cooldown'
import type { ApiFormat } from '../adapters/registry'

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
  apiFormat: ApiFormat
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
  // Skip blacklisted models
  const blacklisted = await db
    .select({ canonical: schema.modelPreferences.canonical })
    .from(schema.modelPreferences)
    .where(
      and(
        eq(schema.modelPreferences.canonical, model),
        eq(schema.modelPreferences.preference, 'blacklist'),
      ),
    )
  if (blacklisted.length > 0) return []

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
      providerApiKey: schema.providers.apiKey,
      providerAccessToken: schema.providers.accessToken,
      providerApiFormat: schema.providers.apiFormat,
      deploymentApiKey: schema.modelDeployments.apiKey,
    })
    .from(schema.modelDeployments)
    .innerJoin(schema.providers, eq(schema.modelDeployments.providerId, schema.providers.id))
    .where(
      and(
        eq(schema.modelDeployments.canonical, model),
        eq(schema.modelDeployments.status, 'active'),
        eq(schema.modelDeployments.blacklisted, false),
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
      // Priority: deployment-specific key > provider access token > provider API key
      apiKey: r.deploymentApiKey || r.providerAccessToken || r.providerApiKey || '',
      apiFormat: (r.providerApiFormat ?? 'openai') as ApiFormat,
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
  upstreamFormat?: ApiFormat
  attempts: RouteAttempt[]
  finalProvider: string | null
  totalLatencyMs: number
  allPricePairs: { priceInput: number; priceOutput: number }[]
}

async function resolveVirtualModel(name: string): Promise<Array<{
  canonical: string
  priority: number
  disabledDeploymentIds: Set<string>
}> | null> {
  const vms = await db
    .select()
    .from(schema.virtualModels)
    .where(eq(schema.virtualModels.name, name))

  if (vms.length === 0) return null

  const vm = vms[0]
  const entries = await db
    .select()
    .from(schema.virtualModelEntries)
    .where(eq(schema.virtualModelEntries.virtualModelId, vm.id))

  const overrides = await db
    .select()
    .from(schema.virtualModelDeploymentOverrides)
    .where(eq(schema.virtualModelDeploymentOverrides.virtualModelId, vm.id))

  const disabledByVmId = new Map<string, Set<string>>()
  for (const override of overrides) {
    if (!override.disabled) continue
    if (!disabledByVmId.has(override.virtualModelId)) {
      disabledByVmId.set(override.virtualModelId, new Set())
    }
    disabledByVmId.get(override.virtualModelId)!.add(override.deploymentId)
  }

  const disabled = disabledByVmId.get(vm.id) ?? new Set<string>()

  return entries
    .sort((a, b) => a.priority - b.priority)
    .map((entry) => ({
      canonical: entry.canonical,
      priority: entry.priority,
      disabledDeploymentIds: disabled,
    }))
}

export async function routeRequest(req: UniversalRequest): Promise<RouteResult> {
  const startTime = Date.now()
  const attempts: RouteAttempt[] = []

  const VIRTUAL_PREFIX = 'virtual:'
  if (req.model.startsWith(VIRTUAL_PREFIX)) {
    const vmName = req.model.slice(VIRTUAL_PREFIX.length)
    const entries = await resolveVirtualModel(vmName)

    if (!entries || entries.length === 0) {
      return {
        attempts: [],
        finalProvider: null,
        totalLatencyMs: Date.now() - startTime,
        allPricePairs: [],
      }
    }

    const allAttempts: RouteAttempt[] = []
    const allPrices: { priceInput: number; priceOutput: number }[] = []

    for (const entry of entries) {
      const deployments = (await getDeploymentsForModel(entry.canonical))
        .filter((deployment) => !entry.disabledDeploymentIds.has(deployment.deploymentId))

      if (deployments.length === 0) continue

      allPrices.push(...deployments
        .filter((deployment) => deployment.priceInput < Infinity && deployment.priceOutput < Infinity)
        .map((deployment) => ({ priceInput: deployment.priceInput, priceOutput: deployment.priceOutput })))

      const sorted = [...deployments].sort((a, b) => a.effectivePrice - b.effectivePrice)
      const available = sorted.filter((deployment) => !isInCooldown(deployment.deploymentId))
      const cooledDown = sorted.filter((deployment) => isInCooldown(deployment.deploymentId))

      for (const deployment of cooledDown) {
        allAttempts.push({
          provider: deployment.providerId,
          deploymentId: deployment.deploymentId,
          groupName: deployment.groupName,
          price: deployment.effectivePrice,
          priceInput: deployment.priceInput,
          priceOutput: deployment.priceOutput,
          status: 'skipped_cooldown',
        })
      }

      for (const deployment of available) {
        const result = await tryDeployment(req, deployment)
        allAttempts.push(result.attempt)

        if (result.attempt.status === 'success') {
          return {
            response: result.response,
            streamResponse: result.streamResponse,
            upstreamFormat: deployment.apiFormat,
            attempts: allAttempts,
            finalProvider: deployment.providerId,
            totalLatencyMs: Date.now() - startTime,
            allPricePairs: allPrices,
          }
        }
      }

      for (const deployment of cooledDown) {
        liftCooldown(deployment.deploymentId)
        const result = await tryDeployment(req, deployment)
        const idx = allAttempts.findIndex(
          (attempt) => attempt.deploymentId === deployment.deploymentId && attempt.status === 'skipped_cooldown',
        )
        if (idx != -1) allAttempts[idx] = result.attempt
        else allAttempts.push(result.attempt)

        if (result.attempt.status === 'success') {
          return {
            response: result.response,
            streamResponse: result.streamResponse,
            upstreamFormat: deployment.apiFormat,
            attempts: allAttempts,
            finalProvider: deployment.providerId,
            totalLatencyMs: Date.now() - startTime,
            allPricePairs: allPrices,
          }
        }
      }
    }

    return {
      attempts: allAttempts,
      finalProvider: null,
      totalLatencyMs: Date.now() - startTime,
      allPricePairs: allPrices,
    }
  }

  const allDeployments = await getDeploymentsForModel(req.model)

  if (allDeployments.length === 0) {
    return {
      attempts: [],
      finalProvider: null,
      totalLatencyMs: Date.now() - startTime,
      allPricePairs: [],
    }
  }

  // Collect all finite price pairs so the logger can compute true worst-case
  // cost at logging time using actual token counts (avoids paired-rate skew).
  const allPricePairs = allDeployments
    .filter((d) => d.priceInput < Infinity && d.priceOutput < Infinity)
    .map((d) => ({ priceInput: d.priceInput, priceOutput: d.priceOutput }))

  // Sort by price
  const sorted = [...allDeployments].sort((a, b) => a.effectivePrice - b.effectivePrice)

  // Phase 1: Try non-cooldown deployments
  const available = sorted.filter((d) => !isInCooldown(d.deploymentId))
  const cooledDown = sorted.filter((d) => isInCooldown(d.deploymentId))

  // Log skipped deployments
  for (const d of cooledDown) {
    attempts.push({
      provider: d.providerId,
      deploymentId: d.deploymentId,
      groupName: d.groupName,
      price: d.effectivePrice,
      priceInput: d.priceInput,
      priceOutput: d.priceOutput,
      status: 'skipped_cooldown',
    })
  }

  const failedDeployments = new Set<string>()

  // Try available deployments
  for (const deployment of available) {
    const result = await tryDeployment(req, deployment)
    attempts.push(result.attempt)

    if (result.attempt.status === 'success') {
      return {
        response: result.response,
        streamResponse: result.streamResponse,
        upstreamFormat: deployment.apiFormat,
        attempts,
        finalProvider: deployment.providerId,
        totalLatencyMs: Date.now() - startTime,
        allPricePairs,
      }
    }
    failedDeployments.add(deployment.deploymentId)
  }

  // Phase 2: Lift prior cooldowns and retry previously-excluded deployments
  for (const deployment of cooledDown) {
    if (failedDeployments.has(deployment.deploymentId)) continue
    liftCooldown(deployment.deploymentId)

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
        upstreamFormat: deployment.apiFormat,
        attempts,
        finalProvider: deployment.providerId,
        totalLatencyMs: Date.now() - startTime,
        allPricePairs,
      }
    }
  }

  // All failed
  return {
    attempts,
    finalProvider: null,
    totalLatencyMs: Date.now() - startTime,
    allPricePairs,
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
    // Select outbound adapter based on provider's API format
    const sendFn = deployment.apiFormat === 'claude' ? sendToAnthropic
      : deployment.apiFormat === 'gemini' ? sendToGemini
      : sendToOpenAICompatible

    const upstreamResponse = await sendFn(
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
            groupName: deployment.groupName,
            price: deployment.effectivePrice,
            priceInput: deployment.priceInput,
            priceOutput: deployment.priceOutput,
            status: 'failed',
            error: `${upstreamResponse.status}: ${errorBody.slice(0, 200)}`,
            latencyMs,
          },
        }
      }

      // All non-client errors: cooldown this deployment
      if (errorType === 'rate_limit') {
        const retryAfter = parseInt(upstreamResponse.headers.get('retry-after') || '', 10)
        enterCooldown(deployment.deploymentId, isNaN(retryAfter) ? undefined : retryAfter)
      } else {
        enterCooldown(deployment.deploymentId)
      }

      return {
        attempt: {
          provider: deployment.providerId,
          deploymentId: deployment.deploymentId,
          groupName: deployment.groupName,
          price: deployment.effectivePrice,
          priceInput: deployment.priceInput,
          priceOutput: deployment.priceOutput,
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
          groupName: deployment.groupName,
          price: deployment.effectivePrice,
          priceInput: deployment.priceInput,
          priceOutput: deployment.priceOutput,
          status: 'success',
          latencyMs,
        },
        streamResponse: upstreamResponse,
      }
    }

    // Non-streaming: parse full response
    const rawJson = await upstreamResponse.json()
    const parseFn = deployment.apiFormat === 'claude' ? parseAnthropicResponse
      : deployment.apiFormat === 'gemini' ? parseGeminiResponse
      : parseOpenAIResponse
    const parsed = parseFn(rawJson as Record<string, unknown>)

    return {
      attempt: {
        provider: deployment.providerId,
        deploymentId: deployment.deploymentId,
        groupName: deployment.groupName,
        price: deployment.effectivePrice,
        priceInput: deployment.priceInput,
        priceOutput: deployment.priceOutput,
        status: 'success',
        latencyMs,
      },
      response: parsed,
    }
  } catch (error) {
    const latencyMs = Date.now() - attemptStart
    enterCooldown(deployment.deploymentId)

    return {
      attempt: {
        provider: deployment.providerId,
        deploymentId: deployment.deploymentId,
        groupName: deployment.groupName,
        price: deployment.effectivePrice,
        priceInput: deployment.priceInput,
        priceOutput: deployment.priceOutput,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        latencyMs,
      },
    }
  }
}
