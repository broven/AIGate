// Resolving a Model Deployment's rates into the numbers the router and the
// cost calculation both use.

import type { DeploymentRates } from './cost'

export interface DeploymentPriceRow {
  priceInput: number | null
  priceOutput: number | null
  priceCacheRead?: number | null
  priceCacheWrite?: number | null
  pricePerCall?: number | null
  manualPriceInput: number | null
  manualPriceOutput: number | null
  /** Provider-level Cost Multiplier — a correction factor, not a markup. */
  costMultiplier?: number | null
}

export interface EffectiveDeploymentPrice extends DeploymentRates {
  priceInput: number
  priceOutput: number
  /** Blended $/1M used only for ranking candidates. */
  effective: number
  /** False when no usable rate exists — such a Deployment must not be routed to. */
  priced: boolean
}

/**
 * Nominal request size used to express a flat per-call price on the same
 * $/1M-token scale as token-priced Deployments, so the two can be ranked
 * against each other. Ranking only — never billing.
 */
const NOMINAL_REQUEST_TOKENS = 2000

/**
 * A Cost Multiplier of exactly 0 is the operator declaring the whole Provider
 * free — a flat-rate subscription, or an account whose usage never bills.
 * "Whatever the list price is, we pay 0" holds just as well when there IS no
 * list price, so a zero multiplier resolves an unpriced Deployment to 0 rather
 * than to unknown.
 *
 * Without this, a free Provider whose upstream publishes no prices (Ollama
 * Cloud, for one — models.dev lists its models with no `cost` at all) resolves
 * to `Infinity`, counts as unpriced, and is silently dropped from routing.
 * It also removes the `0 * Infinity = NaN` case, since the multiplier is
 * consulted before any rate is.
 */
function freeProvider(multiplier: number): boolean {
  return multiplier === 0
}

/**
 * Manual prices are entered by an operator as the upstream's list price, so the
 * Cost Multiplier still has to be applied to reach what we actually pay.
 * Synced prices already have it baked in during sync — multiplying again would
 * charge the correction twice.
 */
export function getEffectivePrice(row: DeploymentPriceRow): EffectiveDeploymentPrice {
  const multiplier = row.costMultiplier ?? 1
  const free = freeProvider(multiplier)

  const input = free
    ? 0
    : row.manualPriceInput !== null && row.manualPriceInput !== undefined
      ? row.manualPriceInput * multiplier
      : row.priceInput ?? Infinity
  const output = free
    ? 0
    : row.manualPriceOutput !== null && row.manualPriceOutput !== undefined
      ? row.manualPriceOutput * multiplier
      : row.priceOutput ?? Infinity

  // A free Provider costs nothing per call either, and its cache reads and
  // writes are free too — every rate it reports collapses to 0. A Deployment
  // that is not per-call priced stays that way; only its amount goes to zero.
  const declaredPerCall = row.pricePerCall ?? null
  const perCall = free
    ? (declaredPerCall === null ? null : 0)
    : declaredPerCall
  const cacheRead = free ? 0 : row.priceCacheRead ?? null
  const cacheWrite = free ? 0 : row.priceCacheWrite ?? null

  const priced = perCall !== null
    ? Number.isFinite(perCall)
    : Number.isFinite(input) && Number.isFinite(output)

  const effective = perCall !== null
    ? (perCall * 1_000_000) / NOMINAL_REQUEST_TOKENS
    : input * 0.3 + output * 0.7 // output dominates real spend

  return {
    priceInput: input,
    priceOutput: output,
    priceCacheRead: cacheRead,
    priceCacheWrite: cacheWrite,
    pricePerCall: perCall,
    effective,
    priced,
  }
}
