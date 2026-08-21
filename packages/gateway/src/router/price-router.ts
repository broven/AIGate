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
import {
  beginInFlight,
  endInFlight,
  evaluateCostLimit,
  getSpend,
  peekSpend,
  reservationFor,
  type CostLimitBlock,
  type Reservation,
} from './cost-limit'
import { getEffectivePrice } from '../pricing/deployment-price'
import type { ApiFormat } from '../adapters/registry'

/** Why a Deployment was removed from the candidate set before it was ever tried. */
type BlockReason =
  | { kind: 'no_price' }
  | { kind: 'cost_limit'; block: CostLimitBlock }

interface Deployment {
  deploymentId: string
  providerId: string
  /** The canonical model this Deployment serves — not the virtual alias asked for. */
  canonical: string
  upstream: string
  groupName: string | null
  effectivePrice: number
  priceInput: number
  priceOutput: number
  priceCacheRead: number | null
  priceCacheWrite: number | null
  pricePerCall: number | null
  endpoint: string
  apiKey: string
  apiFormat: ApiFormat
  dailyLimit: number | null
  monthlyLimit: number | null
  /** Spend as read during candidate selection; the claim-time re-check prefers the live cache. */
  spendSnapshot: { daily: number; monthly: number } | null
  blocked: BlockReason | null
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
      priceCacheRead: schema.modelDeployments.priceCacheRead,
      priceCacheWrite: schema.modelDeployments.priceCacheWrite,
      pricePerCall: schema.modelDeployments.pricePerCall,
      manualPriceInput: schema.modelDeployments.manualPriceInput,
      manualPriceOutput: schema.modelDeployments.manualPriceOutput,
      priceSource: schema.modelDeployments.priceSource,
      endpoint: schema.providers.endpoint,
      providerApiKey: schema.providers.apiKey,
      providerAccessToken: schema.providers.accessToken,
      providerApiFormat: schema.providers.apiFormat,
      costMultiplier: schema.providers.costMultiplier,
      dailyCostLimitUsd: schema.providers.dailyCostLimitUsd,
      monthlyCostLimitUsd: schema.providers.monthlyCostLimitUsd,
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

  // Spend is read once per Provider per routing pass; getSpend caches by UTC day.
  const spendByProvider = new Map<string, { daily: number; monthly: number }>()
  for (const r of rows) {
    if (r.dailyCostLimitUsd === null && r.monthlyCostLimitUsd === null) continue
    if (spendByProvider.has(r.providerId)) continue
    spendByProvider.set(r.providerId, await getSpend(r.providerId))
  }

  return rows.map((r) => {
    const prices = getEffectivePrice(r)

    // An unpriced Deployment used to route with an Infinity price, which made
    // it the last resort everywhere and then billed the request at Infinity.
    // It is now excluded outright — but recorded, so the reason is visible.
    let blocked: BlockReason | null = prices.priced ? null : { kind: 'no_price' }

    if (!blocked) {
      const spend = spendByProvider.get(r.providerId)
      if (spend) {
        const block = evaluateCostLimit({
          providerId: r.providerId,
          providerName: r.providerId,
          dailyLimit: r.dailyCostLimitUsd,
          monthlyLimit: r.monthlyCostLimitUsd,
          spend,
        })
        if (block) blocked = { kind: 'cost_limit', block }
      }
    }

    return {
      deploymentId: r.deploymentId,
      providerId: r.providerId,
      canonical: model,
      upstream: r.upstream,
      groupName: r.groupName,
      effectivePrice: prices.effective,
      priceInput: prices.priceInput,
      priceOutput: prices.priceOutput,
      priceCacheRead: prices.priceCacheRead ?? null,
      priceCacheWrite: prices.priceCacheWrite ?? null,
      pricePerCall: prices.pricePerCall ?? null,
      endpoint: r.endpoint,
      // Priority: deployment-specific key > provider access token > provider API key
      apiKey: r.deploymentApiKey || r.providerAccessToken || r.providerApiKey || '',
      apiFormat: (r.providerApiFormat ?? 'openai') as ApiFormat,
      dailyLimit: r.dailyCostLimitUsd,
      monthlyLimit: r.monthlyCostLimitUsd,
      spendSnapshot: spendByProvider.get(r.providerId) ?? null,
      blocked,
    }
  })
}

/**
 * Split a candidate list into routable Deployments and diagnostic attempts for
 * the ones removed before they were tried, so a request that reaches nothing
 * still explains itself in `request_logs`.
 */
function partitionBlocked(deployments: Deployment[]): {
  routable: Deployment[]
  attempts: RouteAttempt[]
  costLimitBlocks: CostLimitBlock[]
} {
  const routable: Deployment[] = []
  const attempts: RouteAttempt[] = []
  const costLimitBlocks: CostLimitBlock[] = []

  for (const d of deployments) {
    if (!d.blocked) {
      routable.push(d)
      continue
    }
    const limitBlock = d.blocked.kind === 'cost_limit' ? d.blocked.block : null
    if (limitBlock) costLimitBlocks.push(limitBlock)
    attempts.push({
      provider: d.providerId,
      deploymentId: d.deploymentId,
      groupName: d.groupName,
      price: d.effectivePrice,
      priceInput: d.priceInput,
      priceOutput: d.priceOutput,
      status: limitBlock ? 'skipped_cost_limit' : 'skipped_no_price',
      error: limitBlock
        ? `Provider ${limitBlock.providerName} reached its ${limitBlock.window} cost limit `
          + `(spend $${limitBlock.spend.toFixed(6)} >= effective limit $${limitBlock.effectiveLimit.toFixed(6)})`
        : 'No usable price — deployment excluded from routing',
    })
  }

  return { routable, attempts, costLimitBlocks }
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
  virtualModelName?: string
  /** Rates of the Deployment that actually served the request, for billing. */
  finalRates?: {
    priceInput: number
    priceOutput: number
    priceCacheRead: number | null
    priceCacheWrite: number | null
    pricePerCall: number | null
  }
  /** Canonical model of the Deployment that served the request (never the virtual alias). */
  finalCanonical?: string
  /** Providers removed from the candidate set by their Cost Limit. */
  costLimitBlocks: CostLimitBlock[]
  /**
   * Releases the in-flight reservation held for a successful request. It must
   * outlive the router call on EVERY path: the reservation is what stands in
   * for this request's cost until `addSpend` has persisted it, so releasing it
   * any earlier opens a window in which the request is counted by neither.
   * Call it only once logging has completed.
   */
  releaseInFlight?: () => void
}

function ratesOf(d: Deployment): NonNullable<RouteResult['finalRates']> {
  return {
    priceInput: d.priceInput,
    priceOutput: d.priceOutput,
    priceCacheRead: d.priceCacheRead,
    priceCacheWrite: d.priceCacheWrite,
    pricePerCall: d.pricePerCall,
  }
}

async function resolveVirtualModel(name: string): Promise<{
  mode: string
  entries: Array<{
    canonical: string
    priority: number
    disabledDeploymentIds: Set<string>
  }>
} | null> {
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

  return {
    mode: vm.mode,
    entries: entries
      .sort((a, b) => a.priority - b.priority)
      .map((entry) => ({
        canonical: entry.canonical,
        priority: entry.priority,
        disabledDeploymentIds: disabled,
      })),
  }
}

export async function routeRequest(req: UniversalRequest): Promise<RouteResult> {
  const startTime = Date.now()

  // Virtual models have priority over regular models
  const vm = await resolveVirtualModel(req.model)

  if (vm && vm.entries.length > 0) {
    if (vm.mode === 'merge') {
      return routeMerge(req, vm.entries, startTime)
    }
    return routeFallback(req, vm.entries, startTime)
  }

  // Regular model routing
  return routeRegular(req, startTime)
}

async function routeFallback(
  req: UniversalRequest,
  entries: Array<{ canonical: string; priority: number; disabledDeploymentIds: Set<string> }>,
  startTime: number,
): Promise<RouteResult> {
  const allAttempts: RouteAttempt[] = []
  const allCostLimitBlocks: CostLimitBlock[] = []

  for (const entry of entries) {
    const candidates = (await getDeploymentsForModel(entry.canonical))
      .filter((deployment) => !entry.disabledDeploymentIds.has(deployment.deploymentId))

    if (candidates.length === 0) continue

    const { routable, attempts: blockedAttempts, costLimitBlocks } = partitionBlocked(candidates)
    allAttempts.push(...blockedAttempts)
    allCostLimitBlocks.push(...costLimitBlocks)

    const outcome = await attemptDeployments(req, routable, allAttempts, allCostLimitBlocks)
    if (outcome) {
      return {
        ...outcome,
        attempts: allAttempts,
        totalLatencyMs: Date.now() - startTime,
        costLimitBlocks: allCostLimitBlocks,
        virtualModelName: req.model,
      }
    }
  }

  return {
    attempts: allAttempts,
    finalProvider: null,
    totalLatencyMs: Date.now() - startTime,
    costLimitBlocks: allCostLimitBlocks,
    virtualModelName: req.model,
  }
}

async function routeMerge(
  req: UniversalRequest,
  entries: Array<{ canonical: string; priority: number; disabledDeploymentIds: Set<string> }>,
  startTime: number,
): Promise<RouteResult> {
  // Pool all deployments from all entries together
  const allDeployments: Deployment[] = []
  for (const entry of entries) {
    const deployments = (await getDeploymentsForModel(entry.canonical))
      .filter((deployment) => !entry.disabledDeploymentIds.has(deployment.deploymentId))
    allDeployments.push(...deployments)
  }

  const { routable, attempts, costLimitBlocks } = partitionBlocked(allDeployments)

  const outcome = await attemptDeployments(req, routable, attempts, costLimitBlocks)
  if (outcome) {
    return {
      ...outcome,
      attempts,
      totalLatencyMs: Date.now() - startTime,
      costLimitBlocks,
      virtualModelName: req.model,
    }
  }

  return {
    attempts,
    finalProvider: null,
    totalLatencyMs: Date.now() - startTime,
    costLimitBlocks,
    virtualModelName: req.model,
  }
}

async function routeRegular(req: UniversalRequest, startTime: number): Promise<RouteResult> {
  const allDeployments = await getDeploymentsForModel(req.model)
  const { routable, attempts, costLimitBlocks } = partitionBlocked(allDeployments)

  const outcome = await attemptDeployments(req, routable, attempts, costLimitBlocks)
  if (outcome) {
    return {
      ...outcome,
      attempts,
      totalLatencyMs: Date.now() - startTime,
      costLimitBlocks,
    }
  }

  return {
    attempts,
    finalProvider: null,
    totalLatencyMs: Date.now() - startTime,
    costLimitBlocks,
  }
}

/**
 * Try a set of routable Deployments cheapest-first, deferring cooled-down ones
 * to a second pass. Appends every attempt to `attempts` and returns the
 * successful outcome, or null if nothing succeeded.
 */
async function attemptDeployments(
  req: UniversalRequest,
  routable: Deployment[],
  attempts: RouteAttempt[],
  costLimitBlocks: CostLimitBlock[],
): Promise<Pick<RouteResult, 'response' | 'streamResponse' | 'upstreamFormat' | 'finalProvider' | 'finalCanonical' | 'finalRates' | 'releaseInFlight'> | null> {
  if (routable.length === 0) return null

  const sorted = [...routable].sort((a, b) => a.effectivePrice - b.effectivePrice)
  const available = sorted.filter((d) => !isInCooldown(d.deploymentId))
  const cooledDown = sorted.filter((d) => isInCooldown(d.deploymentId))

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

  for (const deployment of available) {
    const result = await tryDeploymentTracked(req, deployment)
    attempts.push(result.attempt)
    if (result.costLimitBlock) costLimitBlocks.push(result.costLimitBlock)

    if (result.attempt.status === 'success') {
      return {
        response: result.response,
        streamResponse: result.streamResponse,
        upstreamFormat: deployment.apiFormat,
        finalProvider: deployment.providerId,
        finalCanonical: deployment.canonical,
        finalRates: ratesOf(deployment),
        releaseInFlight: result.releaseInFlight,
      }
    }
    failedDeployments.add(deployment.deploymentId)
  }

  for (const deployment of cooledDown) {
    if (failedDeployments.has(deployment.deploymentId)) continue
    liftCooldown(deployment.deploymentId)

    const result = await tryDeploymentTracked(req, deployment)
    if (result.costLimitBlock) costLimitBlocks.push(result.costLimitBlock)
    const idx = attempts.findIndex(
      (a) => a.deploymentId === deployment.deploymentId && a.status === 'skipped_cooldown',
    )
    if (idx !== -1) attempts[idx] = result.attempt
    else attempts.push(result.attempt)

    if (result.attempt.status === 'success') {
      return {
        response: result.response,
        streamResponse: result.streamResponse,
        upstreamFormat: deployment.apiFormat,
        finalProvider: deployment.providerId,
        finalCanonical: deployment.canonical,
        finalRates: ratesOf(deployment),
        releaseInFlight: result.releaseInFlight,
      }
    }
  }

  return null
}

/**
 * Claim a Deployment: re-check its Provider's Cost Limit and take the
 * reservation in ONE synchronous step.
 *
 * Candidate selection ran several `await`s ago, so two concurrent requests can
 * both have passed that filter while neither was yet reflected in the other's
 * effective limit. The re-check here is the one that actually gates dispatch,
 * and because nothing is awaited between reading the spend and holding the
 * reservation, the second request always sees the first one's claim.
 */
function claimDeployment(
  deployment: Deployment,
): { reservation: Reservation } | { block: CostLimitBlock } {
  const amountUsd = reservationFor(deployment)

  if (deployment.dailyLimit === null && deployment.monthlyLimit === null) {
    return { reservation: beginInFlight(deployment.providerId, amountUsd) }
  }

  // Cached spend, or the value read during selection — never a fresh query,
  // which would reintroduce the await this function exists to avoid.
  const spend =
    peekSpend(deployment.providerId)
    ?? deployment.spendSnapshot
    ?? { daily: 0, monthly: 0 }

  const block = evaluateCostLimit({
    providerId: deployment.providerId,
    providerName: deployment.providerId,
    dailyLimit: deployment.dailyLimit,
    monthlyLimit: deployment.monthlyLimit,
    spend,
  })
  if (block) return { block }

  return { reservation: beginInFlight(deployment.providerId, amountUsd) }
}

/**
 * `tryDeployment` wrapped in the in-flight reservation that the Cost Limit's
 * effective ceiling is computed from.
 *
 * On success the reservation is handed to the caller rather than released here:
 * the request is still unaccounted for until `logRequest` has persisted its
 * cost, and a stream is still spending money after `routeRequest` returns.
 * Only a failed attempt — which will never reach `addSpend` — releases early.
 */
async function tryDeploymentTracked(
  req: UniversalRequest,
  deployment: Deployment,
): Promise<{
  attempt: RouteAttempt
  response?: UniversalResponse
  streamResponse?: Response
  releaseInFlight?: () => void
  costLimitBlock?: CostLimitBlock
}> {
  const claim = claimDeployment(deployment)

  if ('block' in claim) {
    const block = claim.block
    return {
      attempt: {
        provider: deployment.providerId,
        deploymentId: deployment.deploymentId,
        groupName: deployment.groupName,
        price: deployment.effectivePrice,
        priceInput: deployment.priceInput,
        priceOutput: deployment.priceOutput,
        status: 'skipped_cost_limit',
        error: `Provider ${block.providerName} reached its ${block.window} cost limit `
          + `(spend $${block.spend.toFixed(6)} >= effective limit $${block.effectiveLimit.toFixed(6)})`,
      },
      costLimitBlock: block,
    }
  }

  const reservation = claim.reservation
  const release = () => endInFlight(reservation)

  let result: Awaited<ReturnType<typeof tryDeployment>>
  try {
    result = await tryDeployment(req, deployment)
  } catch (error) {
    release()
    throw error
  }

  if (result.attempt.status === 'success') {
    return { ...result, releaseInFlight: release }
  }

  release()
  return result
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
