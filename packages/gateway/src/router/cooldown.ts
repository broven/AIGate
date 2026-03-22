interface CooldownEntry {
  until: number // ms epoch
  consecutiveFailures: number
}

const BASE_COOLDOWN_MS = 30_000 // 30 seconds
const MAX_COOLDOWN_MS = 15 * 60 * 1000 // 15 minutes

// Key: deploymentId
const cooldowns = new Map<string, CooldownEntry>()

export function isInCooldown(deploymentId: string): boolean {
  const entry = cooldowns.get(deploymentId)
  if (!entry) return false
  if (Date.now() >= entry.until) {
    cooldowns.delete(deploymentId)
    return false
  }
  return true
}

export function enterCooldown(
  deploymentId: string,
  retryAfterSeconds?: number,
): void {
  const prev = cooldowns.get(deploymentId)
  const failures = (prev?.consecutiveFailures ?? 0) + 1

  let durationMs: number
  if (retryAfterSeconds) {
    durationMs = retryAfterSeconds * 1000
  } else {
    durationMs = Math.min(BASE_COOLDOWN_MS * Math.pow(2, failures - 1), MAX_COOLDOWN_MS)
  }

  cooldowns.set(deploymentId, {
    until: Date.now() + durationMs,
    consecutiveFailures: failures,
  })
}

export function clearCooldown(deploymentId: string): void {
  cooldowns.delete(deploymentId)
}

export function getCooldownState(): Map<string, CooldownEntry> {
  const now = Date.now()
  for (const [k, entry] of cooldowns) {
    if (now >= entry.until) cooldowns.delete(k)
  }
  return new Map(cooldowns)
}

export function liftCooldown(deploymentId: string): void {
  cooldowns.delete(deploymentId)
}
