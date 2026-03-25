import { sqliteTable, text, integer, real, index, primaryKey } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['newapi', 'openai-compatible', 'anthropic'] }).notNull(),
  apiFormat: text('api_format', { enum: ['openai', 'claude', 'gemini'] }).notNull().default('openai'),
  endpoint: text('endpoint').notNull(),
  apiKey: text('api_key').default(''),
  costMultiplier: real('cost_multiplier').notNull().default(1.0),
  newApiUserId: integer('new_api_user_id'),
  accessToken: text('access_token'),
  modelsDevSlug: text('models_dev_slug'),
  blackGroupMatch: text('black_group_match'), // JSON array
  syncEnabled: integer('sync_enabled', { mode: 'boolean' }).notNull().default(true),
  syncIntervalMinutes: integer('sync_interval_minutes').notNull().default(60),
  lastSyncAt: text('last_sync_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const gatewayKeys = sqliteTable('gateway_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  keyPlain: text('key_plain').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const modelDeployments = sqliteTable('model_deployments', {
  deploymentId: text('deployment_id').primaryKey(),
  providerId: text('provider_id').notNull().references(() => providers.id, { onDelete: 'cascade' }),
  canonical: text('canonical').notNull(),
  upstream: text('upstream').notNull(),
  groupName: text('group_name'),
  apiKey: text('api_key'), // Per-group token for NewAPI deployments
  priceInput: real('price_input'),
  priceOutput: real('price_output'),
  priceSource: text('price_source', {
    enum: ['provider_api', 'models_dev', 'manual', 'unknown'],
  }).notNull().default('unknown'),
  manualPriceInput: real('manual_price_input'),
  manualPriceOutput: real('manual_price_output'),
  blacklisted: integer('blacklisted', { mode: 'boolean' }).notNull().default(false),
  status: text('status', { enum: ['active', 'stale'] }).notNull().default('active'),
  lastSyncAt: text('last_sync_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_deployments_canonical').on(table.canonical),
  index('idx_deployments_provider').on(table.providerId),
])

export const syncLogs = sqliteTable('sync_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  providerId: text('provider_id').notNull().references(() => providers.id, { onDelete: 'cascade' }),
  modelsAdded: integer('models_added').default(0),
  modelsUpdated: integer('models_updated').default(0),
  modelsRemoved: integer('models_removed').default(0),
  errors: text('errors'), // JSON array
  durationMs: integer('duration_ms'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const requestLogs = sqliteTable('request_logs', {
  id: text('id').primaryKey(),
  model: text('model').notNull(),
  gatewayKey: text('gateway_key').notNull(),
  sourceFormat: text('source_format', { enum: ['openai', 'gemini', 'claude'] }).notNull(),
  attempts: text('attempts').notNull(), // JSON array
  finalProvider: text('final_provider'),
  totalLatencyMs: integer('total_latency_ms').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cost: real('cost'),
  savedVsDirect: real('saved_vs_direct'),
  success: integer('success', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_logs_created_at').on(table.createdAt),
  index('idx_logs_model').on(table.model),
  index('idx_logs_gateway_key').on(table.gatewayKey),
  index('idx_logs_success').on(table.success),
])

export const dailyUsage = sqliteTable('daily_usage', {
  date: text('date').notNull(),
  gatewayKey: text('gateway_key').notNull(),
  model: text('model').notNull(),
  requestCount: integer('request_count').default(0),
  totalInputTokens: integer('total_input_tokens').default(0),
  totalOutputTokens: integer('total_output_tokens').default(0),
  totalCost: real('total_cost').default(0),
  totalSaved: real('total_saved').default(0),
}, (table) => [
  primaryKey({ columns: [table.date, table.gatewayKey, table.model] }),
])

export const kvCache = sqliteTable('kv_cache', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON string
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

export const modelPreferences = sqliteTable('model_preferences', {
  canonical: text('canonical').primaryKey(),
  preference: text('preference', { enum: ['favorite', 'blacklist'] }).notNull(),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})
