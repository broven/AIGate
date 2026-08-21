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
 * Manual prices are entered by an operator as the upstream's list price, so the
 * Cost Multiplier still has to be applied to reach what we actually pay.
 * Synced prices already have it baked in during sync — multiplying again would
 * charge the correction twice.
 */
export function getEffectivePrice(row: DeploymentPriceRow): EffectiveDeploymentPrice {
  const multiplier = row.costMultiplier ?? 1

  const input = row.manualPriceInput !== null && row.manualPriceInput !== undefined
    ? row.manualPriceInput * multiplier
    : row.priceInput ?? Infinity
  const output = row.manualPriceOutput !== null && row.manualPriceOutput !== undefined
    ? row.manualPriceOutput * multiplier
    : row.priceOutput ?? Infinity

  const perCall = row.pricePerCall ?? null
  const cacheRead = row.priceCacheRead ?? null
  const cacheWrite = row.priceCacheWrite ?? null

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
