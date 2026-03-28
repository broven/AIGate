# Virtual Models Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Virtual Models feature that lets users create custom model aliases with ordered multi-model fallback chains and per-deployment enable/disable control.

**Architecture:** Three new DB tables + one new column on requestLogs. A new CRUD API at `/api/virtual-models`. The price-router gets an outer loop that resolves `virtual:` prefixed model names. A new dashboard page at `/virtual-models` with a drag-and-drop chain builder.

**Tech Stack:** Hono (backend), Drizzle ORM + SQLite, React 19 + React Router 7 (frontend), CSS variables (dark theme)

---

### Task 1: Database Schema — Drizzle table definitions

**Files:**
- Modify: `packages/gateway/src/db/schema.ts`

**Step 1: Add the three new tables to schema.ts**

Add after the `modelPreferences` table definition at the end of the file:

```typescript
export const virtualModels = sqliteTable('virtual_models', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').default(''),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

export const virtualModelEntries = sqliteTable('virtual_model_entries', {
  id: text('id').primaryKey(),
  virtualModelId: text('virtual_model_id').notNull().references(() => virtualModels.id, { onDelete: 'cascade' }),
  canonical: text('canonical').notNull(),
  priority: integer('priority').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_vm_entries_vm_id').on(table.virtualModelId),
])

export const virtualModelDeploymentOverrides = sqliteTable('virtual_model_deployment_overrides', {
  virtualModelId: text('virtual_model_id').notNull().references(() => virtualModels.id, { onDelete: 'cascade' }),
  deploymentId: text('deployment_id').notNull().references(() => modelDeployments.deploymentId, { onDelete: 'cascade' }),
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(true),
}, (table) => [
  primaryKey({ columns: [table.virtualModelId, table.deploymentId] }),
])
```

**Step 2: Commit**

```bash
git add packages/gateway/src/db/schema.ts
git commit -m "feat(schema): add virtual model Drizzle table definitions"
```

---

### Task 2: Database Migration — CREATE TABLE statements

**Files:**
- Modify: `packages/gateway/src/db/migrate.ts`

**Step 1: Add migration version 4**

Add a new entry to the `migrations` array:

```typescript
{
  version: 4,
  description: 'Add virtual models tables and requestLogs.virtual_model_name',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS virtual_models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS virtual_model_entries (
        id TEXT PRIMARY KEY,
        virtual_model_id TEXT NOT NULL REFERENCES virtual_models(id) ON DELETE CASCADE,
        canonical TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_vm_entries_vm_id ON virtual_model_entries(virtual_model_id);

      CREATE TABLE IF NOT EXISTS virtual_model_deployment_overrides (
        virtual_model_id TEXT NOT NULL REFERENCES virtual_models(id) ON DELETE CASCADE,
        deployment_id TEXT NOT NULL REFERENCES model_deployments(deployment_id) ON DELETE CASCADE,
        disabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (virtual_model_id, deployment_id)
      );
    `)

    try {
      db.exec('ALTER TABLE request_logs ADD COLUMN virtual_model_name TEXT')
    } catch { /* column already exists */ }
  },
},
```

**Step 2: Add virtualModelName column to the Drizzle schema for requestLogs**

In `packages/gateway/src/db/schema.ts`, add to the `requestLogs` table definition, after the `success` field:

```typescript
virtualModelName: text('virtual_model_name'),
```

**Step 3: Commit**

```bash
git add packages/gateway/src/db/schema.ts packages/gateway/src/db/migrate.ts
git commit -m "feat(db): add migration v4 for virtual models tables"
```

---

### Task 3: Backend API — Virtual Models CRUD

**Files:**
- Create: `packages/gateway/src/api/virtual-models.ts`
- Modify: `packages/gateway/src/index.ts`

**Step 1: Create the virtual models API file**

Create `packages/gateway/src/api/virtual-models.ts`:

```typescript
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'

const app = new Hono()

// GET /api/virtual-models — list all with entries and overrides
app.get('/', async (c) => {
  const vms = await db.select().from(schema.virtualModels)
  const entries = await db.select().from(schema.virtualModelEntries)
  const overrides = await db.select().from(schema.virtualModelDeploymentOverrides)

  const result = vms.map((vm) => ({
    ...vm,
    entries: entries
      .filter((e) => e.virtualModelId === vm.id)
      .sort((a, b) => a.priority - b.priority)
      .map((e) => ({
        ...e,
        disabledDeployments: overrides
          .filter((o) => o.virtualModelId === vm.id && o.disabled)
          .map((o) => o.deploymentId),
      })),
  }))

  return c.json(result)
})

// POST /api/virtual-models — create
app.post('/', async (c) => {
  const body = await c.req.json<{
    name: string
    description?: string
    entries: Array<{
      canonical: string
      priority: number
      disabledDeployments?: string[]
    }>
  }>()

  if (!body.name || !body.name.trim()) {
    return c.json({ error: { message: 'name is required' } }, 400)
  }
  if (!body.entries || body.entries.length === 0) {
    return c.json({ error: { message: 'at least one entry is required' } }, 400)
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await db.insert(schema.virtualModels).values({
    id,
    name: body.name.trim(),
    description: body.description?.trim() || '',
    createdAt: now,
    updatedAt: now,
  })

  for (const entry of body.entries) {
    const entryId = crypto.randomUUID()
    await db.insert(schema.virtualModelEntries).values({
      id: entryId,
      virtualModelId: id,
      canonical: entry.canonical,
      priority: entry.priority,
      createdAt: now,
    })

    if (entry.disabledDeployments) {
      for (const deploymentId of entry.disabledDeployments) {
        await db.insert(schema.virtualModelDeploymentOverrides).values({
          virtualModelId: id,
          deploymentId,
          disabled: true,
        })
      }
    }
  }

  return c.json({ id })
})

// PUT /api/virtual-models/:id — update
app.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    name?: string
    description?: string
    entries?: Array<{
      canonical: string
      priority: number
      disabledDeployments?: string[]
    }>
  }>()

  const existing = await db.select().from(schema.virtualModels).where(eq(schema.virtualModels.id, id))
  if (existing.length === 0) {
    return c.json({ error: { message: 'virtual model not found' } }, 404)
  }

  const now = new Date().toISOString()

  await db.update(schema.virtualModels).set({
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.description !== undefined ? { description: body.description.trim() } : {}),
    updatedAt: now,
  }).where(eq(schema.virtualModels.id, id))

  if (body.entries) {
    // Delete old entries and overrides, then re-insert
    await db.delete(schema.virtualModelEntries).where(eq(schema.virtualModelEntries.virtualModelId, id))
    await db.delete(schema.virtualModelDeploymentOverrides).where(eq(schema.virtualModelDeploymentOverrides.virtualModelId, id))

    for (const entry of body.entries) {
      const entryId = crypto.randomUUID()
      await db.insert(schema.virtualModelEntries).values({
        id: entryId,
        virtualModelId: id,
        canonical: entry.canonical,
        priority: entry.priority,
        createdAt: now,
      })

      if (entry.disabledDeployments) {
        for (const deploymentId of entry.disabledDeployments) {
          await db.insert(schema.virtualModelDeploymentOverrides).values({
            virtualModelId: id,
            deploymentId,
            disabled: true,
          })
        }
      }
    }
  }

  return c.json({ ok: true })
})

// DELETE /api/virtual-models/:id — delete (cascade handles entries + overrides)
app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await db.delete(schema.virtualModels).where(eq(schema.virtualModels.id, id))
  return c.json({ ok: true })
})

export default app
```

**Step 2: Register the route in index.ts**

In `packages/gateway/src/index.ts`, add the import and route registration.

After the existing import for `modelsApi`:
```typescript
import virtualModelsApi from './api/virtual-models'
```

After `app.route('/api/models', modelsApi)`:
```typescript
app.route('/api/virtual-models', virtualModelsApi)
```

**Step 3: Commit**

```bash
git add packages/gateway/src/api/virtual-models.ts packages/gateway/src/index.ts
git commit -m "feat(api): add virtual models CRUD endpoints"
```

---

### Task 4: Routing Logic — Virtual model resolution in price-router

**Files:**
- Modify: `packages/gateway/src/router/price-router.ts`

**Step 1: Add virtual model resolution**

Add this function before the `routeRequest` function:

```typescript
async function resolveVirtualModel(name: string): Promise<Array<{
  canonical: string
  priority: number
  disabledDeploymentIds: Set<string>
}> | null> {
  const vms = await db
    .select()
    .from(schema.virtualModels)
    .where(eq(schema.virtualModels.name, name))

  if (vms.length === 0) return null

  const vm = vms[0]
  const entries = await db
    .select()
    .from(schema.virtualModelEntries)
    .where(eq(schema.virtualModelEntries.virtualModelId, vm.id))

  const overrides = await db
    .select()
    .from(schema.virtualModelDeploymentOverrides)
    .where(eq(schema.virtualModelDeploymentOverrides.virtualModelId, vm.id))

  const disabledByVmId = new Map<string, Set<string>>()
  for (const o of overrides) {
    if (!o.disabled) continue
    // Group by entry — but overrides are per VM, not per entry.
    // We store a flat set since deployment IDs are globally unique.
    if (!disabledByVmId.has(o.virtualModelId)) {
      disabledByVmId.set(o.virtualModelId, new Set())
    }
    disabledByVmId.get(o.virtualModelId)!.add(o.deploymentId)
  }

  const disabled = disabledByVmId.get(vm.id) ?? new Set<string>()

  return entries
    .sort((a, b) => a.priority - b.priority)
    .map((e) => ({
      canonical: e.canonical,
      priority: e.priority,
      disabledDeploymentIds: disabled,
    }))
}
```

**Step 2: Modify routeRequest to handle virtual: prefix**

Replace the beginning of `routeRequest` to add virtual model handling. The function signature stays the same. At the top of `routeRequest`, before `const allDeployments = await getDeploymentsForModel(req.model)`:

```typescript
// Virtual model resolution
const VIRTUAL_PREFIX = 'virtual:'
if (req.model.startsWith(VIRTUAL_PREFIX)) {
  const vmName = req.model.slice(VIRTUAL_PREFIX.length)
  const entries = await resolveVirtualModel(vmName)

  if (!entries || entries.length === 0) {
    return {
      attempts: [],
      finalProvider: null,
      totalLatencyMs: Date.now() - startTime,
      allPricePairs: [],
    }
  }

  const allAttempts: RouteAttempt[] = []
  const allPrices: { priceInput: number; priceOutput: number }[] = []

  for (const entry of entries) {
    // Get deployments for this canonical, filtering out disabled ones
    const deployments = (await getDeploymentsForModel(entry.canonical))
      .filter((d) => !entry.disabledDeploymentIds.has(d.deploymentId))

    if (deployments.length === 0) continue

    allPrices.push(...deployments
      .filter((d) => d.priceInput < Infinity && d.priceOutput < Infinity)
      .map((d) => ({ priceInput: d.priceInput, priceOutput: d.priceOutput })))

    // Sort by price within this tier
    const sorted = [...deployments].sort((a, b) => a.effectivePrice - b.effectivePrice)
    const available = sorted.filter((d) => !isInCooldown(d.deploymentId))
    const cooledDown = sorted.filter((d) => isInCooldown(d.deploymentId))

    for (const d of cooledDown) {
      allAttempts.push({
        provider: d.providerId,
        deploymentId: d.deploymentId,
        groupName: d.groupName,
        price: d.effectivePrice,
        priceInput: d.priceInput,
        priceOutput: d.priceOutput,
        status: 'skipped_cooldown',
      })
    }

    // Try available deployments
    for (const deployment of available) {
      const result = await tryDeployment(req, deployment)
      allAttempts.push(result.attempt)

      if (result.attempt.status === 'success') {
        return {
          response: result.response,
          streamResponse: result.streamResponse,
          upstreamFormat: deployment.apiFormat,
          attempts: allAttempts,
          finalProvider: deployment.providerId,
          totalLatencyMs: Date.now() - startTime,
          allPricePairs: allPrices,
        }
      }
    }

    // Retry cooled-down deployments in this tier
    for (const deployment of cooledDown) {
      liftCooldown(deployment.deploymentId)
      const result = await tryDeployment(req, deployment)
      const idx = allAttempts.findIndex(
        (a) => a.deploymentId === deployment.deploymentId && a.status === 'skipped_cooldown',
      )
      if (idx !== -1) allAttempts[idx] = result.attempt
      else allAttempts.push(result.attempt)

      if (result.attempt.status === 'success') {
        return {
          response: result.response,
          streamResponse: result.streamResponse,
          upstreamFormat: deployment.apiFormat,
          attempts: allAttempts,
          finalProvider: deployment.providerId,
          totalLatencyMs: Date.now() - startTime,
          allPricePairs: allPrices,
        }
      }
    }
  }

  // All tiers exhausted
  return {
    attempts: allAttempts,
    finalProvider: null,
    totalLatencyMs: Date.now() - startTime,
    allPricePairs: allPrices,
  }
}
```

Make sure the import at the top of price-router.ts includes `schema`:
```typescript
import { db, schema } from '../db'
```
(The `db` and `schema` import should already exist — verify and add if missing.)

**Step 3: Commit**

```bash
git add packages/gateway/src/router/price-router.ts
git commit -m "feat(router): add virtual model resolution with tiered fallback"
```

---

### Task 5: /v1/models Integration — Expose virtual models

**Files:**
- Modify: `packages/gateway/src/index.ts`

**Step 1: Update the `/v1/models` endpoint**

In `packages/gateway/src/index.ts`, find the `app.get('/v1/models', ...)` handler. After the line that builds the `models` array (the `const models = [...new Set(...)].filter(...)` line), add:

```typescript
// Include virtual models
const virtualModelRows = await db
  .select({ name: schema.virtualModels.name })
  .from(schema.virtualModels)
const virtualModelIds = virtualModelRows.map((r) => `virtual:${r.name}`)
```

Then update the returned `data` array to include virtual models:

```typescript
return c.json({
  object: 'list',
  data: [
    ...models.map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'aigate',
    })),
    ...virtualModelIds.map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'aigate-virtual',
    })),
  ],
})
```

Note: The `db` and `schema` are already dynamically imported in this handler — add `virtualModels` to the destructured schema if needed, or just use `schema.virtualModels` directly.

**Step 2: Commit**

```bash
git add packages/gateway/src/index.ts
git commit -m "feat(api): expose virtual models in /v1/models endpoint"
```

---

### Task 6: Request Logging — Record virtual model name

**Files:**
- Modify: `packages/gateway/src/logging/request-logger.ts`
- Modify: `packages/gateway/src/index.ts`

**Step 1: Add virtualModelName to LogParams and insert**

In `packages/gateway/src/logging/request-logger.ts`:

Add `virtualModelName?: string` to the `LogParams` interface.

In the `db.insert(schema.requestLogs).values({...})` call, add:
```typescript
virtualModelName: params.virtualModelName ?? null,
```

**Step 2: Pass virtualModelName from handleLLMRequest**

In `packages/gateway/src/index.ts`, in the `handleLLMRequest` function, wherever `logRequest({...})` is called (there are 3-4 call sites), add the `virtualModelName` field:

```typescript
virtualModelName: universalReq.model.startsWith('virtual:') ? universalReq.model.slice(8) : undefined,
```

**Step 3: Commit**

```bash
git add packages/gateway/src/logging/request-logger.ts packages/gateway/src/index.ts
git commit -m "feat(logging): record virtual model name in request logs"
```

---

### Task 7: Frontend API Client — Virtual model types and functions

**Files:**
- Modify: `packages/dashboard/src/lib/api.ts`

**Step 1: Add types and API functions**

Add after the existing `getBenchmarks` export:

```typescript
// Virtual Models
export interface VirtualModel {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  entries: VirtualModelEntry[]
}

export interface VirtualModelEntry {
  id: string
  virtualModelId: string
  canonical: string
  priority: number
  createdAt: string
  disabledDeployments: string[]
}

export const getVirtualModels = () => request<VirtualModel[]>('/virtual-models')

export const createVirtualModel = (data: {
  name: string
  description?: string
  entries: Array<{ canonical: string; priority: number; disabledDeployments?: string[] }>
}) =>
  request<{ id: string }>('/virtual-models', { method: 'POST', body: JSON.stringify(data) })

export const updateVirtualModel = (id: string, data: {
  name?: string
  description?: string
  entries?: Array<{ canonical: string; priority: number; disabledDeployments?: string[] }>
}) =>
  request<{ ok: boolean }>(`/virtual-models/${id}`, { method: 'PUT', body: JSON.stringify(data) })

export const deleteVirtualModel = (id: string) =>
  request<{ ok: boolean }>(`/virtual-models/${id}`, { method: 'DELETE' })
```

**Step 2: Commit**

```bash
git add packages/dashboard/src/lib/api.ts
git commit -m "feat(dashboard): add virtual model API client functions"
```

---

### Task 8: Dashboard Page — VirtualModels list and create/edit UI

**Files:**
- Create: `packages/dashboard/src/pages/VirtualModels.tsx`
- Modify: `packages/dashboard/src/App.tsx`

**Step 1: Create the VirtualModels page**

Create `packages/dashboard/src/pages/VirtualModels.tsx` with the full page implementation. This is the largest task. The page should include:

1. **List view**: Table showing all virtual models with name, description, model chain as pill badges, and edit/delete actions
2. **Create/Edit mode**: Inline form (not a separate route) with:
   - Name and description inputs
   - Model chain builder with "Add Model" dropdown (populated from existing canonical models via `getModels()`)
   - Draggable model cards (use simple up/down buttons instead of HTML5 drag — simpler, no library needed)
   - Each model card expandable to show deployments with toggle switches
   - Arrow connector between cards
   - Save/Cancel buttons
3. **Empty state** explaining virtual models

```typescript
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  getVirtualModels, createVirtualModel, updateVirtualModel, deleteVirtualModel,
  getModels, type VirtualModel, type ModelDeployment,
} from '../lib/api'
import { usePolling } from '../hooks/usePolling'
import { displayName } from '../lib/model-utils'

interface EntryDraft {
  canonical: string
  disabledDeployments: Set<string>
}

export default function VirtualModels() {
  const fetchVMs = useCallback(() => getVirtualModels(), [])
  const { data: virtualModels, error, loading, refresh } = usePolling(fetchVMs, 30000)

  const [deployments, setDeployments] = useState<ModelDeployment[] | null>(null)
  useEffect(() => {
    getModels().then(setDeployments).catch(() => {})
  }, [])

  // Canonical list for the "Add Model" dropdown
  const canonicalList = useMemo(() => {
    if (!deployments) return []
    const set = new Set(deployments.filter((d) => d.status === 'active').map((d) => d.canonical))
    return [...set].sort()
  }, [deployments])

  // Deployments grouped by canonical
  const deploymentsByCanonical = useMemo(() => {
    if (!deployments) return new Map<string, ModelDeployment[]>()
    const map = new Map<string, ModelDeployment[]>()
    for (const d of deployments) {
      if (d.status !== 'active') continue
      const arr = map.get(d.canonical) || []
      arr.push(d)
      map.set(d.canonical, arr)
    }
    return map
  }, [deployments])

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null) // null = list view, 'new' = create, uuid = edit
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editEntries, setEditEntries] = useState<EntryDraft[]>([])
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  function startCreate() {
    setEditingId('new')
    setEditName('')
    setEditDescription('')
    setEditEntries([])
    setExpandedEntries(new Set())
    setSaveError(null)
  }

  function startEdit(vm: VirtualModel) {
    setEditingId(vm.id)
    setEditName(vm.name)
    setEditDescription(vm.description)
    setEditEntries(vm.entries.map((e) => ({
      canonical: e.canonical,
      disabledDeployments: new Set(e.disabledDeployments),
    })))
    setExpandedEntries(new Set())
    setSaveError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setSaveError(null)
  }

  function addModel(canonical: string) {
    setEditEntries((prev) => [...prev, { canonical, disabledDeployments: new Set() }])
  }

  function removeEntry(index: number) {
    setEditEntries((prev) => prev.filter((_, i) => i !== index))
  }

  function moveEntry(index: number, direction: -1 | 1) {
    setEditEntries((prev) => {
      const next = [...prev]
      const target = index + direction
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function toggleDeployment(entryIndex: number, deploymentId: string) {
    setEditEntries((prev) => {
      const next = [...prev]
      const entry = { ...next[entryIndex], disabledDeployments: new Set(next[entryIndex].disabledDeployments) }
      if (entry.disabledDeployments.has(deploymentId)) {
        entry.disabledDeployments.delete(deploymentId)
      } else {
        entry.disabledDeployments.add(deploymentId)
      }
      next[entryIndex] = entry
      return next
    })
  }

  function toggleExpandEntry(index: number) {
    setExpandedEntries((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  async function handleSave() {
    if (!editName.trim()) {
      setSaveError('Name is required')
      return
    }
    if (editEntries.length === 0) {
      setSaveError('Add at least one model')
      return
    }

    setSaving(true)
    setSaveError(null)

    const payload = {
      name: editName.trim(),
      description: editDescription.trim(),
      entries: editEntries.map((e, i) => ({
        canonical: e.canonical,
        priority: i,
        disabledDeployments: [...e.disabledDeployments],
      })),
    }

    try {
      if (editingId === 'new') {
        await createVirtualModel(payload)
      } else {
        await updateVirtualModel(editingId!, payload)
      }
      setEditingId(null)
      refresh()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this virtual model?')) return
    setDeleting(id)
    try {
      await deleteVirtualModel(id)
      refresh()
    } catch {
      // ignore
    } finally {
      setDeleting(null)
    }
  }

  // Effective price for display
  function effectiveInputPrice(d: ModelDeployment): number | null {
    return d.manualPriceInput ?? d.priceInput
  }

  // Loading
  if (loading && !virtualModels) {
    return (
      <div>
        <h1 className="page-title">Virtual Models</h1>
        <div className="empty-state"><p>Loading...</p></div>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <h1 className="page-title">Virtual Models</h1>
        <div className="toast error" style={{ position: 'static', marginBottom: 16 }}>{error.message}</div>
      </div>
    )
  }

  // Edit / Create view
  if (editingId !== null) {
    return (
      <div>
        <h1 className="page-title">{editingId === 'new' ? 'Create Virtual Model' : 'Edit Virtual Model'}</h1>

        <div className="card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, color: 'var(--text-secondary)' }}>Name</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="my-smart-model"
                style={{
                  width: '100%', padding: '8px 12px',
                  background: 'var(--bg-primary)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)', fontSize: 13,
                }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                Clients use: <code>virtual:{editName || 'name'}</code>
              </span>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, color: 'var(--text-secondary)' }}>Description</label>
              <input
                type="text"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Optional description"
                style={{
                  width: '100%', padding: '8px 12px',
                  background: 'var(--bg-primary)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)', fontSize: 13,
                }}
              />
            </div>
          </div>

          <label style={{ display: 'block', marginBottom: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
            Model Chain (tried in order, top to bottom)
          </label>

          {editEntries.map((entry, index) => {
            const deps = deploymentsByCanonical.get(entry.canonical) || []
            const isExpanded = expandedEntries.has(index)
            const enabledCount = deps.filter((d) => !entry.disabledDeployments.has(d.deploymentId)).length

            return (
              <div key={index}>
                {index > 0 && (
                  <div style={{ textAlign: 'center', padding: '4px 0', color: 'var(--text-muted)', fontSize: 16 }}>↓</div>
                )}
                <div style={{
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                  background: 'var(--bg-surface)', marginBottom: 4,
                }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                    cursor: 'pointer',
                  }} onClick={() => toggleExpandEntry(index)}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <button className="btn" style={{ padding: '0 4px', fontSize: 10, lineHeight: 1 }}
                        onClick={(e) => { e.stopPropagation(); moveEntry(index, -1) }}
                        disabled={index === 0}>▲</button>
                      <button className="btn" style={{ padding: '0 4px', fontSize: 10, lineHeight: 1 }}
                        onClick={(e) => { e.stopPropagation(); moveEntry(index, 1) }}
                        disabled={index === editEntries.length - 1}>▼</button>
                    </div>
                    <span style={{ color: 'var(--accent-blue)', fontSize: 11 }}>{isExpanded ? '▼' : '▶'}</span>
                    <strong style={{ flex: 1 }}>{displayName(entry.canonical)}</strong>
                    <span className="badge" style={{ fontSize: 11 }}>{enabledCount}/{deps.length} deployments</span>
                    <button className="btn" style={{ padding: '2px 8px', fontSize: 11, color: 'var(--accent-red)' }}
                      onClick={(e) => { e.stopPropagation(); removeEntry(index) }}>Remove</button>
                  </div>

                  {isExpanded && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px 8px 44px' }}>
                      {deps.length === 0 ? (
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No active deployments</span>
                      ) : deps.map((d) => {
                        const enabled = !entry.disabledDeployments.has(d.deploymentId)
                        const price = effectiveInputPrice(d)
                        return (
                          <div key={d.deploymentId} style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0',
                            opacity: enabled ? 1 : 0.4,
                          }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 1 }}>
                              <input
                                type="checkbox"
                                className="custom-checkbox"
                                checked={enabled}
                                onChange={() => toggleDeployment(index, d.deploymentId)}
                              />
                              <span className="badge" style={{ fontSize: 10 }}>{d.providerId}{d.groupName ? `-${d.groupName}` : ''}</span>
                              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{d.upstream}</span>
                            </label>
                            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {price !== null ? `$${price.toFixed(2)}` : '—'}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {/* Add Model dropdown */}
          <div style={{ marginTop: 12 }}>
            <select
              className="filter-select"
              value=""
              onChange={(e) => { if (e.target.value) addModel(e.target.value) }}
              style={{ minWidth: 200 }}
            >
              <option value="">+ Add Model...</option>
              {canonicalList.map((c) => (
                <option key={c} value={c}>{displayName(c)}</option>
              ))}
            </select>
          </div>

          {saveError && (
            <div className="toast error" style={{ position: 'static', marginTop: 12 }}>{saveError}</div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn" onClick={cancelEdit} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // List view
  return (
    <div>
      <div className="section-header" style={{ marginBottom: 16 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Virtual Models</h1>
        <button className="btn btn-primary" onClick={startCreate}>Create Virtual Model</button>
      </div>

      {(!virtualModels || virtualModels.length === 0) ? (
        <div className="empty-state">
          <h3>No virtual models yet</h3>
          <p>Create a virtual model to define custom fallback chains across different models.</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>
            Clients use <code>virtual:name</code> as the model identifier.
          </p>
          <button className="btn btn-primary" onClick={startCreate} style={{ marginTop: 12 }}>
            Create Virtual Model
          </button>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Model Chain</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {virtualModels.map((vm) => (
                <tr key={vm.id}>
                  <td>
                    <code style={{ color: 'var(--accent-blue)' }}>virtual:{vm.name}</code>
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>{vm.description || '—'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                      {vm.entries.map((e, i) => (
                        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {i > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>→</span>}
                          <span className="badge" style={{ fontSize: 11 }}>{displayName(e.canonical)}</span>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }}
                        onClick={() => startEdit(vm)}>Edit</button>
                      <button className="btn" style={{ padding: '2px 8px', fontSize: 11, color: 'var(--accent-red)' }}
                        onClick={() => handleDelete(vm.id)}
                        disabled={deleting === vm.id}>
                        {deleting === vm.id ? '...' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
```

**Step 2: Add the route and sidebar link in App.tsx**

In `packages/dashboard/src/App.tsx`:

Add import:
```typescript
import VirtualModels from './pages/VirtualModels'
```

Add NavLink in the sidebar, after the Models NavLink and before the Logs NavLink:
```tsx
<NavLink to="/virtual-models" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M16 3h5v5" /><path d="M8 3H3v5" /><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" /><path d="m15 9 6-6" />
  </svg>
  Virtual Models
</NavLink>
```

Add Route inside `<Routes>`, after the `/models` route:
```tsx
<Route path="/virtual-models" element={<VirtualModels />} />
```

**Step 3: Commit**

```bash
git add packages/dashboard/src/pages/VirtualModels.tsx packages/dashboard/src/App.tsx
git commit -m "feat(dashboard): add Virtual Models page with create/edit UI"
```

---

### Task 9: Verify — Build and manual test

**Step 1: Build the project**

Run from the project root:
```bash
bun install
cd packages/gateway && bun run build 2>&1 || echo "No build step — OK for Bun"
cd ../dashboard && bun run build
```

Fix any TypeScript compilation errors.

**Step 2: Start the server and verify**

```bash
cd /path/to/project
ADMIN_TOKEN=test bun run packages/gateway/src/index.ts
```

Verify:
- Database migration v4 runs: `[migrate] v4: Add virtual models tables...`
- Check `GET /api/virtual-models` returns `[]`
- Create a virtual model via `POST /api/virtual-models`
- Verify it appears in `GET /v1/models` with `virtual:` prefix

**Step 3: Verify dashboard builds cleanly**

Check the dashboard build output from Step 1 has no errors.

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build issues from virtual models implementation"
```
