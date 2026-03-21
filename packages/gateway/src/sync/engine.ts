import { eq, and, notInArray } from 'drizzle-orm'
import { db, schema } from '../db'
import { syncNewAPIProvider, type SyncedModel } from './newapi'
import { syncOpenAICompatibleProvider } from './openai-compat'
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

  // Mark stale: models that were active but not seen in this sync
  let modelsStale = 0
  if (seenDeploymentIds.length > 0) {
    const staleResult = await db
      .update(schema.modelDeployments)
      .set({ status: 'stale' })
      .where(
        and(
          eq(schema.modelDeployments.providerId, provider.id),
          eq(schema.modelDeployments.status, 'active'),
          notInArray(schema.modelDeployments.deploymentId, seenDeploymentIds),
        ),
      )
    // Count isn't directly available from drizzle update, approximate
    modelsStale = 0 // Will be calculated from db after
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
    modelsStale,
    errors: syncResult.errors,
    durationMs,
  }

  // Log sync result
  await db.insert(schema.syncLogs).values({
    providerId: provider.id,
    modelsAdded,
    modelsUpdated,
    modelsStale,
    errors: syncResult.errors.length > 0 ? JSON.stringify(syncResult.errors) : null,
    durationMs,
  })

  console.log(
    `[sync] ${provider.id}: +${modelsAdded} updated=${modelsUpdated} stale=${modelsStale} errors=${syncResult.errors.length} (${durationMs}ms)`,
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
