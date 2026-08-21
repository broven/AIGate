// Provider-level Cost Limit — spend accounting and the in-flight reservation.
//
// Cost is only known after a request completes, so a naive "spend < limit"
// check lets N concurrent requests all pass while the limit has room for one.
// We close that window with an **absolute** reservation rather than a
// percentage safety margin: the overshoot is caused by (in-flight count x
// per-request cost), and against a $0.11 daily allowance a percentage margin
// would be an order of magnitude smaller than the thing it must absorb.

import { sql, eq, and, like } from 'drizzle-orm'
import { db, schema } from '../db'

/**
 * Conservative output-token count assumed for a request still in flight.
 * Deliberately generous: under-reserving spends real money, over-reserving
 * only makes the gateway stop a little early.
 */
export const RESERVE_OUTPUT_TOKENS = 4096

export type SpendWindow = 'daily' | 'monthly'

// --- UTC window helpers -----------------------------------------------------

export function utcDateOf(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10) // YYYY-MM-DD
}

export function utcMonthOf(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7) // YYYY-MM
}

/** Start of the next window, UTC, ISO-8601. Windows are fixed to UTC, not local time. */
export function nextResetAt(window: SpendWindow, now: Date = new Date()): string {
  if (window === 'daily') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
}

// --- In-flight reservations -------------------------------------------------

/**
 * A held reservation. The amount is fixed when the Deployment is CLAIMED, from
 * that Deployment's own rates — an aggregate count multiplied by whichever
 * candidate happens to be asking next would under-reserve as soon as a Provider
 * mixes cheap and expensive models, or charges per call.
 */
export interface Reservation {
  readonly providerId: string
  readonly amountUsd: number
  released: boolean
}

interface ProviderReservations {
  totalUsd: number
  count: number
}

const reservedByProvider = new Map<string, ProviderReservations>()

/**
 * The worst-case cost of one request against this Deployment: a flat
 * `pricePerCall` if it has one, otherwise `output rate x RESERVE_OUTPUT_TOKENS`.
 * An unpriced Deployment reserves nothing because it is not routable anyway.
 */
export function reservationFor(rates: {
  priceOutput: number | null
  pricePerCall: number | null
}): number {
  if (rates.pricePerCall !== null && Number.isFinite(rates.pricePerCall)) {
    return Math.max(0, rates.pricePerCall)
  }
  const rate = rates.priceOutput
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return 0
  return (rate * RESERVE_OUTPUT_TOKENS) / 1_000_000
}

/** Hold `amountUsd` of a Provider's allowance until the request settles. */
export function beginInFlight(providerId: string, amountUsd = 0): Reservation {
  const entry = reservedByProvider.get(providerId) ?? { totalUsd: 0, count: 0 }
  const amount = Number.isFinite(amountUsd) ? Math.max(0, amountUsd) : 0
  entry.totalUsd += amount
  entry.count += 1
  reservedByProvider.set(providerId, entry)
  return { providerId, amountUsd: amount, released: false }
}

/** Release a held reservation. Idempotent — callers may release on more than one path. */
export function endInFlight(reservation: Reservation): void {
  if (reservation.released) return
  reservation.released = true
  const entry = reservedByProvider.get(reservation.providerId)
  if (!entry) return
  entry.totalUsd -= reservation.amountUsd
  entry.count -= 1
  if (entry.count <= 0) reservedByProvider.delete(reservation.providerId)
  else if (entry.totalUsd < 0) entry.totalUsd = 0
}

/** Total USD currently withheld from this Provider's allowance. */
export function getReservedUsd(providerId: string): number {
  return reservedByProvider.get(providerId)?.totalUsd ?? 0
}

/** Number of open requests — displayed to operators; never used for arithmetic. */
export function getInFlight(providerId: string): number {
  return reservedByProvider.get(providerId)?.count ?? 0
}

/** Test seam. */
export function __resetInFlight(): void {
  reservedByProvider.clear()
}

// --- Spend cache ------------------------------------------------------------

interface SpendEntry {
  utcDate: string
  daily: number
  monthly: number
}

const spendCache = new Map<string, SpendEntry>()

/**
 * Bumped every time a Provider's spend changes. `getSpend` samples it before
 * its queries and refuses to cache a result if it moved underneath them —
 * otherwise a cold read overlapping an `addSpend` can persist a pre-write value
 * for the rest of the UTC day and quietly undercount against the limit.
 */
const spendGeneration = new Map<string, number>()

function bumpGeneration(providerId: string): void {
  spendGeneration.set(providerId, (spendGeneration.get(providerId) ?? 0) + 1)
}

export function invalidateSpendCache(providerId?: string): void {
  if (providerId) {
    spendCache.delete(providerId)
    bumpGeneration(providerId)
  } else {
    for (const id of spendCache.keys()) bumpGeneration(id)
    spendCache.clear()
  }
}

/**
 * Synchronous read of the cached spend, or null when nothing is cached for
 * today. Used where a decision must be made with no `await` in the middle.
 */
export function peekSpend(
  providerId: string,
  now: Date = new Date(),
): { daily: number; monthly: number } | null {
  const cached = spendCache.get(providerId)
  if (!cached || cached.utcDate !== utcDateOf(now)) return null
  return { daily: cached.daily, monthly: cached.monthly }
}

/**
 * Current spend for a Provider in both windows. Cached per UTC day; a day
 * rollover invalidates the entry by construction because the cached date no
 * longer matches, which is also how the daily counter "resets" at 00:00 UTC.
 */
export async function getSpend(
  providerId: string,
  now: Date = new Date(),
): Promise<{ daily: number; monthly: number }> {
  const today = utcDateOf(now)
  let daily = 0
  let monthly = 0

  // Re-read if a write landed while the queries were in flight; the retry sees
  // the committed value. Bounded so a hot Provider cannot spin here.
  for (let attempt = 0; attempt < 3; attempt++) {
    const cached = spendCache.get(providerId)
    if (cached && cached.utcDate === today) {
      return { daily: cached.daily, monthly: cached.monthly }
    }

    const generation = spendGeneration.get(providerId) ?? 0

    const [dailyRow] = await db
      .select({ total: schema.providerDailySpend.costUsd })
      .from(schema.providerDailySpend)
      .where(
        and(
          eq(schema.providerDailySpend.providerId, providerId),
          eq(schema.providerDailySpend.utcDate, today),
        ),
      )
      .limit(1)

    // The monthly window is derived, never stored: SUM over this month's days.
    const [monthlyRow] = await db
      .select({ total: sql<number>`coalesce(sum(${schema.providerDailySpend.costUsd}), 0)` })
      .from(schema.providerDailySpend)
      .where(
        and(
          eq(schema.providerDailySpend.providerId, providerId),
          like(schema.providerDailySpend.utcDate, `${utcMonthOf(now)}%`),
        ),
      )

    daily = dailyRow?.total ?? 0
    monthly = monthlyRow?.total ?? 0

    if ((spendGeneration.get(providerId) ?? 0) === generation) {
      spendCache.set(providerId, { utcDate: today, daily, monthly })
      return { daily, monthly }
    }
  }

  // Still racing after three passes: return what was read but do NOT cache it.
  return { daily, monthly }
}

/**
 * Add a completed request's cost to the Provider's spend, atomically.
 * Non-finite costs are rejected here as well as at the caller — a poisoned
 * spend row would disable the Provider forever.
 */
export async function addSpend(
  providerId: string,
  costUsd: number,
  now: Date = new Date(),
): Promise<void> {
  if (!Number.isFinite(costUsd)) return
  const today = utcDateOf(now)

  await db
    .insert(schema.providerDailySpend)
    .values({ providerId, utcDate: today, costUsd })
    .onConflictDoUpdate({
      target: [schema.providerDailySpend.providerId, schema.providerDailySpend.utcDate],
      set: { costUsd: sql`cost_usd + ${costUsd}` },
    })

  // Only after the write has committed: a getSpend whose queries straddle this
  // point sees the generation move and re-reads instead of caching a stale value.
  const cached = spendCache.get(providerId)
  if (cached && cached.utcDate === today) {
    cached.daily += costUsd
    cached.monthly += costUsd
  } else {
    spendCache.delete(providerId)
  }
  bumpGeneration(providerId)
}

// --- Limit evaluation -------------------------------------------------------

/**
 * Effective limit = limit - (USD reserved by the requests actually in flight).
 *
 * Visible in the dashboard and in the 503 body: operators need to see the
 * number that actually gated the request, not the one they typed in.
 */
export function effectiveLimit(limit: number | null, reservedUsd: number): number | null {
  if (limit === null) return null
  if (!Number.isFinite(reservedUsd) || reservedUsd <= 0) return limit
  return limit - reservedUsd
}

export interface CostLimitBlock {
  providerId: string
  /** Human-facing Provider label. Providers have no separate name column — the id is the name. */
  providerName: string
  window: SpendWindow
  spend: number
  limit: number
  effectiveLimit: number
  resetAt: string
}

/**
 * Decide whether a Provider may still be scheduled. Either window over its
 * effective limit blocks the Provider entirely — every one of its Model
 * Deployments leaves the candidate set together, because the allowance is
 * account-level, not per-model.
 */
export function evaluateCostLimit(params: {
  providerId: string
  providerName: string
  dailyLimit: number | null
  monthlyLimit: number | null
  spend: { daily: number; monthly: number }
  now?: Date
}): CostLimitBlock | null {
  const now = params.now ?? new Date()
  const reserved = getReservedUsd(params.providerId)

  const windows: Array<[SpendWindow, number | null, number]> = [
    ['daily', params.dailyLimit, params.spend.daily],
    ['monthly', params.monthlyLimit, params.spend.monthly],
  ]

  for (const [window, limit, spend] of windows) {
    if (limit === null || limit === undefined) continue // null limit never blocks
    const effective = effectiveLimit(limit, reserved)!
    if (spend >= effective) {
      return {
        providerId: params.providerId,
        providerName: params.providerName,
        window,
        spend,
        limit,
        effectiveLimit: effective,
        resetAt: nextResetAt(window, now),
      }
    }
  }

  return null
}
