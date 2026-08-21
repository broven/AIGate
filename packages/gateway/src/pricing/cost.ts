// Cost computation — the single place that turns token counts and rates into dollars.

export interface DeploymentRates {
  /** $/1M uncached input tokens */
  priceInput: number | null
  /** $/1M output tokens */
  priceOutput: number | null
  /** $/1M cache-read input tokens */
  priceCacheRead?: number | null
  /** $/1M cache-write input tokens */
  priceCacheWrite?: number | null
  /** Flat $ per request. When set it replaces the whole token calculation. */
  pricePerCall?: number | null
}

export interface TokenUsage {
  /** Uncached prompt tokens. */
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number | null
  cacheWriteTokens?: number | null
  /** Reasoning tokens not counted in outputTokens; billed at the output rate. */
  reasoningTokens?: number | null
}

/**
 * Compute the dollar cost of one request.
 *
 * Returns `null` — never a number — whenever the result would not be a finite
 * dollar amount. Two separate failure shapes are folded into that one answer:
 *
 *  - a missing rate, which `getEffectivePrice` surfaces as `Infinity`;
 *  - `NaN`, which appears when a zero cost multiplier meets an `Infinity`
 *    rate (`0 * Infinity`). It is the close relative of `Infinity` and is
 *    just as poisonous once summed into an aggregate row.
 *
 * A non-finite cost written to `daily_usage` permanently corrupts that row, so
 * the guard lives here rather than at each call site.
 */
export function computeCost(rates: DeploymentRates, usage: TokenUsage): number | null {
  if (rates.pricePerCall !== null && rates.pricePerCall !== undefined) {
    return Number.isFinite(rates.pricePerCall) ? rates.pricePerCall : null
  }

  const input = rates.priceInput ?? Infinity
  const output = rates.priceOutput ?? Infinity

  const cachedInput = usage.cachedInputTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const reasoning = usage.reasoningTokens ?? 0

  // Cache rates fall back to the plain input rate: a provider that reports
  // cache hits but publishes no cache price still charged us something, and
  // the full input rate is the conservative (never-understated) assumption.
  const cacheReadRate = rates.priceCacheRead ?? input
  const cacheWriteRate = rates.priceCacheWrite ?? input

  let total = usage.inputTokens * input + (usage.outputTokens + reasoning) * output
  if (cachedInput > 0) total += cachedInput * cacheReadRate
  if (cacheWrite > 0) total += cacheWrite * cacheWriteRate

  const cost = total / 1_000_000
  return Number.isFinite(cost) ? cost : null
}

/**
 * "Saved vs Direct": what this request would have cost at the first-party
 * vendor's official list price, minus what it actually cost.
 *
 * `firstPartyRates` is null when the first party could not be resolved, and the
 * result is then null too — an approximate baseline would render a fabricated
 * savings figure as though it were measured.
 */
export function computeSavedVsDirect(
  actualCost: number | null,
  firstPartyRates: DeploymentRates | null,
  usage: TokenUsage,
): number | null {
  if (actualCost === null || !Number.isFinite(actualCost)) return null
  if (!firstPartyRates) return null

  const baseline = computeCost(firstPartyRates, usage)
  if (baseline === null) return null

  const saved = baseline - actualCost
  return Number.isFinite(saved) ? saved : null
}
