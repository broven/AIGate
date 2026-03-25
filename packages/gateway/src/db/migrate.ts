import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'

const DB_PATH = process.env.DATABASE_URL || './data/aigate.db'

const dir = dirname(DB_PATH)
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true })
}

const sqlite = new Database(DB_PATH)
sqlite.exec('PRAGMA journal_mode = WAL')
sqlite.exec('PRAGMA foreign_keys = ON')

// Create tables directly (simpler than drizzle-kit for embedded SQLite)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('newapi', 'openai-compatible', 'anthropic')),
    api_format TEXT NOT NULL DEFAULT 'openai' CHECK(api_format IN ('openai', 'claude', 'gemini')),
    endpoint TEXT NOT NULL,
    api_key TEXT DEFAULT '',
    cost_multiplier REAL NOT NULL DEFAULT 1.0,
    new_api_user_id INTEGER,
    access_token TEXT,
    black_group_match TEXT,
    sync_enabled INTEGER NOT NULL DEFAULT 1,
    sync_interval_minutes INTEGER NOT NULL DEFAULT 60,
    last_sync_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS gateway_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    key_plain TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS model_deployments (
    deployment_id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    canonical TEXT NOT NULL,
    upstream TEXT NOT NULL,
    group_name TEXT,
    api_key TEXT,
    price_input REAL,
    price_output REAL,
    price_source TEXT NOT NULL DEFAULT 'unknown' CHECK(price_source IN ('provider_api', 'models_dev', 'manual', 'unknown')),
    manual_price_input REAL,
    manual_price_output REAL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'stale')),
    last_sync_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_deployments_canonical ON model_deployments(canonical);
  CREATE INDEX IF NOT EXISTS idx_deployments_provider ON model_deployments(provider_id);

  CREATE TABLE IF NOT EXISTS sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    models_added INTEGER DEFAULT 0,
    models_updated INTEGER DEFAULT 0,
    models_removed INTEGER DEFAULT 0,
    errors TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS request_logs (
    id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    gateway_key TEXT NOT NULL,
    source_format TEXT NOT NULL CHECK(source_format IN ('openai', 'gemini', 'claude')),
    attempts TEXT NOT NULL,
    final_provider TEXT,
    total_latency_ms INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost REAL,
    saved_vs_direct REAL,
    success INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_logs_created_at ON request_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_logs_model ON request_logs(model);
  CREATE INDEX IF NOT EXISTS idx_logs_gateway_key ON request_logs(gateway_key);
  CREATE INDEX IF NOT EXISTS idx_logs_success ON request_logs(success);

  CREATE TABLE IF NOT EXISTS daily_usage (
    date TEXT NOT NULL,
    gateway_key TEXT NOT NULL,
    model TEXT NOT NULL,
    request_count INTEGER DEFAULT 0,
    total_input_tokens INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    total_cost REAL DEFAULT 0,
    total_saved REAL DEFAULT 0,
    PRIMARY KEY (date, gateway_key, model)
  );

  CREATE TABLE IF NOT EXISTS model_preferences (
    canonical TEXT PRIMARY KEY,
    preference TEXT NOT NULL CHECK(preference IN ('favorite', 'blacklist')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS kv_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// Migrations for existing databases
const migrations = [
  `ALTER TABLE model_deployments ADD COLUMN api_key TEXT`,
  `ALTER TABLE providers ALTER COLUMN api_key DROP NOT NULL`, // SQLite ignores this but harmless
  `DELETE FROM model_deployments WHERE status = 'stale'`,
  `ALTER TABLE providers ADD COLUMN api_format TEXT NOT NULL DEFAULT 'openai'`,
  `ALTER TABLE sync_logs ADD COLUMN models_removed INTEGER DEFAULT 0`,
  `ALTER TABLE gateway_keys ADD COLUMN key_plain TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE gateway_keys DROP COLUMN key_hash`,
  `ALTER TABLE gateway_keys DROP COLUMN key_prefix`,
  // Normalize version dots to dashes in model_preferences (user-set data, not auto-synced)
  `UPDATE model_preferences SET canonical = REPLACE(canonical, '3.5', '3-5') WHERE canonical LIKE '%3.5%'`,
  `UPDATE model_preferences SET canonical = REPLACE(canonical, '2.5', '2-5') WHERE canonical LIKE '%2.5%'`,
  `UPDATE model_preferences SET canonical = REPLACE(canonical, '4.5', '4-5') WHERE canonical LIKE '%4.5%'`,
  `UPDATE model_preferences SET canonical = REPLACE(canonical, '4.6', '4-6') WHERE canonical LIKE '%4.6%'`,
  `ALTER TABLE model_deployments ADD COLUMN blacklisted INTEGER NOT NULL DEFAULT 0`,
]

for (const sql of migrations) {
  try {
    sqlite.exec(sql)
  } catch {
    // Column already exists or migration already applied
  }
}

// One-shot: widen providers.type CHECK to include 'anthropic'.
// Only runs if the CHECK constraint still uses the old list.
// SQLite doesn't support ALTER CHECK, so we recreate the table inside a transaction.
const currentDDL = sqlite
  .query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='providers'`)
  .get() as { sql: string } | null
if (currentDDL && !currentDDL.sql.includes("'anthropic'")) {
  console.log('[migrate] Widening providers.type CHECK to include anthropic…')
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite.exec('BEGIN IMMEDIATE')
  try {
    sqlite.exec(`
      CREATE TABLE providers_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('newapi', 'openai-compatible', 'anthropic')),
        api_format TEXT NOT NULL DEFAULT 'openai' CHECK(api_format IN ('openai', 'claude', 'gemini')),
        endpoint TEXT NOT NULL,
        api_key TEXT DEFAULT '',
        cost_multiplier REAL NOT NULL DEFAULT 1.0,
        new_api_user_id INTEGER,
        access_token TEXT,
        black_group_match TEXT,
        sync_enabled INTEGER NOT NULL DEFAULT 1,
        sync_interval_minutes INTEGER NOT NULL DEFAULT 60,
        last_sync_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    sqlite.exec('INSERT INTO providers_new SELECT * FROM providers')
    sqlite.exec('DROP TABLE providers')
    sqlite.exec('ALTER TABLE providers_new RENAME TO providers')
    sqlite.exec('COMMIT')
    console.log('[migrate] providers.type CHECK widened successfully')
  } catch (e) {
    sqlite.exec('ROLLBACK')
    console.error('[migrate] Failed to widen providers.type CHECK:', e)
  }
  sqlite.exec('PRAGMA foreign_keys = ON')
}

console.log('Database migrated successfully')
sqlite.close()
