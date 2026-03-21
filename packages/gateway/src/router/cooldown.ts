interface CooldownEntry {
  until: number // ms epoch
  consecutiveFailures: number
}

const BASE_COOLDOWN_MS = 30_000 // 30 seconds
const MAX_COOLDOWN_MS = 15 * 60 * 1000 // 15 minutes

// Key format: "{providerId}:{model}"
const cooldowns = new Map<string, CooldownEntry>()

function key(providerId: string, model: string): string {
  return `${providerId}:${model}`
}

export function isInCooldown(providerId: string, model: string): boolean {
  const entry = cooldowns.get(key(providerId, model))
  if (!entry) return false
  if (Date.now() >= entry.until) {
    cooldowns.delete(key(providerId, model))
    return false
  }
  return true
}

export function enterCooldown(
  providerId: string,
  model: string,
  retryAfterSeconds?: number,
): void {
  const k = key(providerId, model)
  const prev = cooldowns.get(k)
  const failures = (prev?.consecutiveFailures ?? 0) + 1

  let durationMs: number
  if (retryAfterSeconds) {
    durationMs = retryAfterSeconds * 1000
  } else {
    durationMs = Math.min(BASE_COOLDOWN_MS * Math.pow(2, failures - 1), MAX_COOLDOWN_MS)
  }

  cooldowns.set(k, {
    until: Date.now() + durationMs,
    consecutiveFailures: failures,
  })
}

export function enterProviderCooldown(providerId: string): void {
  // Cooldown all models for this provider (auth failure)
  for (const [k, entry] of cooldowns) {
    if (k.startsWith(`${providerId}:`)) {
      entry.until = Date.now() + MAX_COOLDOWN_MS
    }
  }
  // Also add a wildcard entry
  cooldowns.set(`${providerId}:*`, {
    until: Date.now() + MAX_COOLDOWN_MS,
    consecutiveFailures: 1,
  })
}

export function clearCooldown(providerId: string, model: string): void {
  cooldowns.delete(key(providerId, model))
}

export function getCooldownState(): Map<string, CooldownEntry> {
  // Clean expired entries
  const now = Date.now()
  for (const [k, entry] of cooldowns) {
    if (now >= entry.until) cooldowns.delete(k)
  }
  return new Map(cooldowns)
}

export function liftExpiredCooldowns(providerId: string, model: string): void {
  const k = key(providerId, model)
  cooldowns.delete(k)
}

export function getProvidersInCooldown(model: string): Set<string> {
  const now = Date.now()
  const result = new Set<string>()
  for (const [k, entry] of cooldowns) {
    if (now < entry.until) {
      const [pid, m] = k.split(':')
      if (m === model || m === '*') {
        result.add(pid!)
      }
    }
  }
  return result
}
