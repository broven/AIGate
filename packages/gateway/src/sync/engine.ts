import { eq, and, notInArray, inArray } from 'drizzle-orm'
import { db, schema } from '../db'
import { syncNewAPIProvider, type SyncedModel } from './newapi'
import { syncOpenAICompatibleProvider } from './openai-compat'
import { syncAnthropicProvider } from './anthropic'
import type { SyncResult } from '@aigate/shared'

type ProviderRow = typeof schema.providers.$inferSelect

export async function syncProvider(provider: ProviderRow): Promise<SyncResult> {
  const startTime = Date.now()
  const blackGroupMatch = provider.blackGroupMatch
    ? (JSON.parse(provider.blackGroupMatch) as string[])
    : []

  let syncResult: { models: SyncedModel[]; errors: string[] }

  if (provider.type === 'newapi') {
    syncResult = await syncNewAPIProvider(
      provider.endpoint,
      provider.apiKey || '',
      provider.costMultiplier,
      blackGroupMatch,
      provider.accessToken ?? undefined,
      provider.newApiUserId ?? undefined,
    )
  } else if (provider.type === 'anthropic') {
    syncResult = await syncAnthropicProvider(
      provider.endpoint,
      provider.apiKey || '',
      provider.costMultiplier,
    )
  } else {
    syncResult = await syncOpenAICompatibleProvider(
      provider.endpoint,
      provider.apiKey || '',
      provider.costMultiplier,
    )
  }

  let modelsAdded = 0
  let modelsUpdated = 0

  // Upsert models
  const seenDeploymentIds: string[] = []

  for (const model of syncResult.models) {
    const deploymentId = model.groupName
      ? `${provider.id}-${model.groupName}-${model.canonical}`
      : `${provider.id}-${model.canonical}`

    seenDeploymentIds.push(deploymentId)

    // Check if exists
    const [existing] = await db
      .select({ deploymentId: schema.modelDeployments.deploymentId })
      .from(schema.modelDeployments)
      .where(eq(schema.modelDeployments.deploymentId, deploymentId))
      .limit(1)

    if (existing) {
      await db
        .update(schema.modelDeployments)
        .set({
          canonical: model.canonical,
          upstream: model.upstream,
          apiKey: model.apiKey,
          priceInput: model.priceInput,
          priceOutput: model.priceOutput,
          priceSource: model.priceSource,
          status: 'active',
          lastSyncAt: new Date().toISOString(),
        })
        .where(eq(schema.modelDeployments.deploymentId, deploymentId))
      modelsUpdated++
    } else {
      await db.insert(schema.modelDeployments).values({
        deploymentId,
        providerId: provider.id,
        canonical: model.canonical,
        upstream: model.upstream,
        groupName: model.groupName,
        apiKey: model.apiKey,
        priceInput: model.priceInput,
        priceOutput: model.priceOutput,
        priceSource: model.priceSource,
        status: 'active',
        lastSyncAt: new Date().toISOString(),
      })
      modelsAdded++
    }
  }

  // Also un-blacklist synced deployments (group may have been un-blacklisted)
  if (seenDeploymentIds.length > 0) {
    await db
      .update(schema.modelDeployments)
      .set({ blacklisted: false })
      .where(
        and(
          eq(schema.modelDeployments.providerId, provider.id),
          eq(schema.modelDeployments.blacklisted, true),
          inArray(schema.modelDeployments.deploymentId, seenDeploymentIds),
        ),
      )
  }

  // Handle unseen deployments: preserve blacklisted-group ones, delete the rest
  let modelsRemoved = 0
  if (seenDeploymentIds.length > 0) {
    // Find unseen deployments for this provider
    const unseenRows = await db
      .select({
        deploymentId: schema.modelDeployments.deploymentId,
        groupName: schema.modelDeployments.groupName,
      })
      .from(schema.modelDeployments)
      .where(
        and(
          eq(schema.modelDeployments.providerId, provider.id),
          notInArray(schema.modelDeployments.deploymentId, seenDeploymentIds),
        ),
      )

    const toDelete: string[] = []
    const toBlacklist: string[] = []

    for (const row of unseenRows) {
      // Check if this deployment belongs to a blacklisted group
      const isGroupBlacklisted = row.groupName && blackGroupMatch.some(
        (pattern) => row.groupName!.toLowerCase().includes(pattern.toLowerCase()),
      )
      if (isGroupBlacklisted) {
        toBlacklist.push(row.deploymentId)
      } else {
        toDelete.push(row.deploymentId)
      }
    }

    // Mark blacklisted-group deployments
    if (toBlacklist.length > 0) {
      await db
        .update(schema.modelDeployments)
        .set({ blacklisted: true })
        .where(inArray(schema.modelDeployments.deploymentId, toBlacklist))
    }

    // Delete truly removed deployments
    if (toDelete.length > 0) {
      await db
        .delete(schema.modelDeployments)
        .where(inArray(schema.modelDeployments.deploymentId, toDelete))
      modelsRemoved = toDelete.length
    }
  }

  // Update provider last sync time
  await db
    .update(schema.providers)
    .set({ lastSyncAt: new Date().toISOString() })
    .where(eq(schema.providers.id, provider.id))

  const durationMs = Date.now() - startTime
  const result: SyncResult = {
    providerId: provider.id,
    modelsAdded,
    modelsUpdated,
    modelsRemoved,
    errors: syncResult.errors,
    durationMs,
  }

  // Log sync result
  await db.insert(schema.syncLogs).values({
    providerId: provider.id,
    modelsAdded,
    modelsUpdated,
    modelsRemoved,
    errors: syncResult.errors.length > 0 ? JSON.stringify(syncResult.errors) : null,
    durationMs,
  })

  console.log(
    `[sync] ${provider.id}: +${modelsAdded} updated=${modelsUpdated} removed=${modelsRemoved} errors=${syncResult.errors.length} (${durationMs}ms)`,
  )

  return result
}

// Sync scheduler
const syncTimers = new Map<string, ReturnType<typeof setInterval>>()

export async function startSyncScheduler(): Promise<void> {
  console.log('[sync] Starting sync scheduler')

  const providers = await db
    .select()
    .from(schema.providers)
    .where(eq(schema.providers.syncEnabled, true))

  for (const provider of providers) {
    scheduleProvider(provider)
  }
}

function scheduleProvider(provider: ProviderRow): void {
  // Clear existing timer
  const existing = syncTimers.get(provider.id)
  if (existing) clearInterval(existing)

  const intervalMs = provider.syncIntervalMinutes * 60 * 1000

  // Run initial sync after a short delay
  setTimeout(() => {
    syncProvider(provider).catch((err) =>
      console.error(`[sync] Error syncing ${provider.id}:`, err),
    )
  }, 5000)

  // Schedule recurring sync
  const timer = setInterval(() => {
    syncProvider(provider).catch((err) =>
      console.error(`[sync] Error syncing ${provider.id}:`, err),
    )
  }, intervalMs)

  syncTimers.set(provider.id, timer)
  console.log(`[sync] Scheduled ${provider.id} every ${provider.syncIntervalMinutes}m`)
}

export function stopSyncScheduler(): void {
  for (const [id, timer] of syncTimers) {
    clearInterval(timer)
  }
  syncTimers.clear()
}
