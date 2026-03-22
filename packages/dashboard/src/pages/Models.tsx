// Data Flow:
// getModels() → ModelDeployment[] ──┐
//                                    ├→ groupBy(canonical) → filter → render
// getProviders() → Provider[]  ─────┘   (client-side)
//                  (lookup map)
//
// State layers:
//   serverData ← usePolling(getModels, 30s)
//   providers  ← useEffect(getProviders, [])
//   edits      ← Record<deploymentId, {input, output}>  (dirty edit buffer)
//   expanded   ← Set<canonical>
//   filters    ← {search, provider, status}

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { getModels, getProviders, updateModelPrice, type ModelDeployment, type Provider } from '../lib/api'
import { usePolling } from '../hooks/usePolling'

interface PriceEdit {
  input: string
  output: string
}

function effectivePrice(d: ModelDeployment): { input: number | null; output: number | null } {
  return {
    input: d.manualPriceInput ?? d.priceInput,
    output: d.manualPriceOutput ?? d.priceOutput,
  }
}

function derivedPriceSource(d: ModelDeployment): string {
  if (d.manualPriceInput !== null && d.manualPriceInput !== undefined) return 'manual'
  if (d.priceSource === 'manual') return 'unknown' // stale DB state from cleared override
  return d.priceSource
}

function formatPrice(v: number | null): string {
  if (v === null || v === undefined) return '—'
  return `$${v.toFixed(2)}`
}

function priceRangeStr(prices: (number | null)[]): string {
  const valid = prices.filter((p): p is number => p !== null && p !== undefined && p > 0)
  if (valid.length === 0) return '—'
  const min = Math.min(...valid)
  const max = Math.max(...valid)
  if (min === max) return `$${min.toFixed(2)}`
  return `$${min.toFixed(2)}–$${max.toFixed(2)}`
}

const SOURCE_BADGE_CLASS: Record<string, string> = {
  provider_api: 'blue',
  models_dev: 'yellow',
  manual: 'green',
  unknown: '',
}

export default function Models() {
  // Providers: fetch once on mount
  const [providers, setProviders] = useState<Provider[] | null>(null)
  const [providerError, setProviderError] = useState<string | null>(null)

  useEffect(() => {
    getProviders()
      .then(setProviders)
      .catch((err) => setProviderError(err instanceof Error ? err.message : 'Failed to load providers'))
  }, [])

  // Models: poll every 30s
  const fetchModels = useCallback(() => getModels(), [])
  const { data: models, error: modelError, loading: modelLoading } = usePolling(fetchModels, 30000)

  // Derived state
  const providerMap = useMemo(() => {
    if (!providers) return new Map<string, Provider>()
    return new Map(providers.map((p) => [p.id, p]))
  }, [providers])

  // UI state
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [edits, setEdits] = useState<Record<string, PriceEdit>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [providerFilter, setProviderFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'stale'>('')

  // Block page on either fetch error
  const error = modelError?.message || providerError
  const loading = modelLoading || providers === null

  // Group models by canonical
  const groups = useMemo(() => {
    if (!models) return []
    const map = new Map<string, ModelDeployment[]>()
    for (const m of models) {
      const arr = map.get(m.canonical) || []
      arr.push(m)
      map.set(m.canonical, arr)
    }
    return Array.from(map.entries())
      .map(([canonical, deployments]) => ({ canonical, deployments }))
      .sort((a, b) => a.canonical.localeCompare(b.canonical))
  }, [models])

  // Filter groups
  const filtered = useMemo(() => {
    return groups.filter((g) => {
      if (search && !g.canonical.toLowerCase().includes(search.toLowerCase())) return false
      if (providerFilter && !g.deployments.some((d) => d.providerId === providerFilter)) return false
      if (statusFilter) {
        const hasStatus = g.deployments.some((d) => d.status === statusFilter)
        if (!hasStatus) return false
      }
      return true
    })
  }, [groups, search, providerFilter, statusFilter])

  // Stats
  const stats = useMemo(() => {
    if (!models) return { models: 0, deployments: 0, providers: 0 }
    const uniqueCanonicals = new Set(models.map((m) => m.canonical))
    const uniqueProviders = new Set(models.map((m) => m.providerId))
    return { models: uniqueCanonicals.size, deployments: models.length, providers: uniqueProviders.size }
  }, [models])

  // Unique providers for filter dropdown
  const providerOptions = useMemo(() => {
    if (!models) return []
    const ids = [...new Set(models.map((m) => m.providerId))]
    return ids.map((id) => ({ id, label: id }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [models, providerMap])

  function toggleExpand(canonical: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(canonical)) next.delete(canonical)
      else next.add(canonical)
      return next
    })
  }

  function getEditValue(d: ModelDeployment): PriceEdit {
    if (edits[d.deploymentId]) return edits[d.deploymentId]
    const eff = effectivePrice(d)
    return {
      input: eff.input !== null ? String(eff.input) : '',
      output: eff.output !== null ? String(eff.output) : '',
    }
  }

  function setEditField(deploymentId: string, field: 'input' | 'output', value: string) {
    setEdits((prev) => ({
      ...prev,
      [deploymentId]: {
        ...prev[deploymentId] || getEditValue(models!.find((m) => m.deploymentId === deploymentId)!),
        [field]: value,
      },
    }))
  }

  function isDirty(d: ModelDeployment): boolean {
    const edit = edits[d.deploymentId]
    if (!edit) return false
    const eff = effectivePrice(d)
    const origInput = eff.input !== null ? String(eff.input) : ''
    const origOutput = eff.output !== null ? String(eff.output) : ''
    return edit.input !== origInput || edit.output !== origOutput
  }

  async function handleSave(d: ModelDeployment) {
    const edit = edits[d.deploymentId]
    if (!edit) return

    const priceInput = edit.input.trim() === '' ? null : parseFloat(edit.input)
    const priceOutput = edit.output.trim() === '' ? null : parseFloat(edit.output)

    if (priceInput !== null && isNaN(priceInput)) return
    if (priceOutput !== null && isNaN(priceOutput)) return

    setSaving((prev) => ({ ...prev, [d.deploymentId]: true }))
    setSaveErrors((prev) => {
      const next = { ...prev }
      delete next[d.deploymentId]
      return next
    })

    try {
      await updateModelPrice(d.deploymentId, priceInput, priceOutput)
      // Clear edit buffer so next poll updates this row
      setEdits((prev) => {
        const next = { ...prev }
        delete next[d.deploymentId]
        return next
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed'
      setSaveErrors((prev) => ({ ...prev, [d.deploymentId]: msg }))
      setTimeout(() => {
        setSaveErrors((prev) => {
          const next = { ...prev }
          delete next[d.deploymentId]
          return next
        })
      }, 5000)
    } finally {
      setSaving((prev) => ({ ...prev, [d.deploymentId]: false }))
    }
  }

  function statusRollup(deployments: ModelDeployment[]): 'active' | 'stale' {
    return deployments.some((d) => d.status === 'stale') ? 'stale' : 'active'
  }

  function providerIdLabel(providerId: string, groupName: string | null): string {
    if (groupName) return `${providerId}-${groupName}`
    return providerId
  }

  // Loading state
  if (loading && !models) {
    return (
      <div>
        <h1 className="page-title">Models</h1>
        <div className="empty-state"><p>Loading...</p></div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div>
        <h1 className="page-title">Models</h1>
        <div className="toast error" style={{ position: 'static', marginBottom: 16 }}>{error}</div>
      </div>
    )
  }

  // Empty state
  if (models && models.length === 0) {
    return (
      <div>
        <h1 className="page-title">Models</h1>
        <div className="empty-state">
          <h3>No models yet</h3>
          <p>Add a provider and run sync to discover models.</p>
          <Link to="/providers" className="btn btn-primary">Go to Providers</Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="section-header" style={{ marginBottom: 16 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Models</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="badge">{stats.models} models</span>
          <span className="badge">{stats.deployments} deployments</span>
          <span className="badge">{stats.providers} providers</span>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search models..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1, maxWidth: 300, padding: '6px 12px',
            background: 'var(--bg-primary)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)', fontSize: 13,
          }}
        />
        <select
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
          style={{
            padding: '6px 12px', background: 'var(--bg-primary)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)', fontSize: 13,
          }}
        >
          <option value="">All Providers</option>
          {providerOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as '' | 'active' | 'stale')}
          style={{
            padding: '6px 12px', background: 'var(--bg-primary)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)', fontSize: 13,
          }}
        >
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="stale">Stale</option>
        </select>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="empty-state">
          <p>No matching models</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Deployments</th>
                <th>Price Range (in / out)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((group) => {
                const isExpanded = expanded.has(group.canonical)
                const status = statusRollup(group.deployments)
                const inputPrices = group.deployments.map((d) => effectivePrice(d).input)
                const outputPrices = group.deployments.map((d) => effectivePrice(d).output)

                return (
                  <ModelGroup
                    key={group.canonical}
                    canonical={group.canonical}
                    deployments={group.deployments}
                    isExpanded={isExpanded}
                    status={status}
                    inputPriceRange={priceRangeStr(inputPrices)}
                    outputPriceRange={priceRangeStr(outputPrices)}
                    onToggle={() => toggleExpand(group.canonical)}
                    getEditValue={getEditValue}
                    setEditField={setEditField}
                    isDirty={isDirty}
                    handleSave={handleSave}
                    saving={saving}
                    saveErrors={saveErrors}
                    providerIdLabel={providerIdLabel}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

interface ModelGroupProps {
  canonical: string
  deployments: ModelDeployment[]
  isExpanded: boolean
  status: 'active' | 'stale'
  inputPriceRange: string
  outputPriceRange: string
  onToggle: () => void
  getEditValue: (d: ModelDeployment) => PriceEdit
  setEditField: (id: string, field: 'input' | 'output', value: string) => void
  isDirty: (d: ModelDeployment) => boolean
  handleSave: (d: ModelDeployment) => void
  saving: Record<string, boolean>
  saveErrors: Record<string, string>
  providerIdLabel: (id: string, groupName: string | null) => string
}

function ModelGroup({
  canonical, deployments, isExpanded, status,
  inputPriceRange, outputPriceRange, onToggle,
  getEditValue, setEditField, isDirty, handleSave,
  saving, saveErrors, providerIdLabel,
}: ModelGroupProps) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{ cursor: 'pointer', background: isExpanded ? 'var(--bg-hover)' : undefined }}
      >
        <td>
          <span style={{ color: 'var(--accent-blue)', marginRight: 6, fontSize: 11 }}>
            {isExpanded ? '▼' : '▶'}
          </span>
          <strong>{canonical}</strong>
        </td>
        <td>
          <span className="badge" style={{ fontSize: 11 }}>
            {deployments.length} deployment{deployments.length !== 1 ? 's' : ''}
          </span>
        </td>
        <td>{inputPriceRange} / {outputPriceRange}</td>
        <td>
          <span className="status-dot" />
          <span className={`badge ${status === 'active' ? 'green' : 'yellow'}`}>
            {status}
          </span>
        </td>
      </tr>
      {isExpanded && [...deployments].sort((a, b) => (effectivePrice(a).input ?? Infinity) - (effectivePrice(b).input ?? Infinity)).map((d) => (
        <DeploymentRow
          key={d.deploymentId}
          deployment={d}
          editValue={getEditValue(d)}
          onEditField={(field, value) => setEditField(d.deploymentId, field, value)}
          dirty={isDirty(d)}
          onSave={() => handleSave(d)}
          isSaving={saving[d.deploymentId] || false}
          error={saveErrors[d.deploymentId]}
          providerLabel={providerIdLabel(d.providerId, d.groupName)}
        />
      ))}
    </>
  )
}

interface DeploymentRowProps {
  deployment: ModelDeployment
  editValue: PriceEdit
  onEditField: (field: 'input' | 'output', value: string) => void
  dirty: boolean
  onSave: () => void
  isSaving: boolean
  error?: string
  providerLabel: string
}

function DeploymentRow({
  deployment, editValue, onEditField, dirty, onSave, isSaving, error, providerLabel,
}: DeploymentRowProps) {
  const source = derivedPriceSource(deployment)
  const badgeClass = SOURCE_BADGE_CLASS[source] || ''

  return (
    <>
      <tr style={{ background: 'var(--bg-primary)' }}>
        <td style={{ paddingLeft: 40 }}>
          <span className="badge" style={{ fontSize: 11, marginRight: 8 }}>{providerLabel}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{deployment.upstream}</span>
        </td>
        <td>
          <span className={`badge ${badgeClass}`} style={{ fontSize: 10 }}>{source}</span>
        </td>
        <td>
          <input
            type="text"
            value={editValue.input}
            onChange={(e) => onEditField('input', e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="—"
            style={{
              width: 80, padding: '2px 6px', background: 'var(--bg-surface)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12,
            }}
          />
          <span style={{ margin: '0 4px', color: 'var(--text-muted)' }}>/</span>
          <input
            type="text"
            value={editValue.output}
            onChange={(e) => onEditField('output', e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="—"
            style={{
              width: 80, padding: '2px 6px', background: 'var(--bg-surface)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12,
            }}
          />
        </td>
        <td>
          <span className={`badge ${deployment.status === 'active' ? 'green' : 'yellow'}`} style={{ fontSize: 11, marginRight: 8 }}>
            {deployment.status}
          </span>
          <button
            className="btn btn-primary"
            disabled={!dirty || isSaving}
            onClick={(e) => { e.stopPropagation(); onSave() }}
            style={{ padding: '2px 8px', fontSize: 11 }}
          >
            {isSaving ? '...' : 'Save'}
          </button>
        </td>
      </tr>
      {error && (
        <tr style={{ background: 'var(--bg-primary)' }}>
          <td colSpan={4} style={{ paddingLeft: 40, color: 'var(--accent-red)', fontSize: 12 }}>
            {error}
          </td>
        </tr>
      )}
    </>
  )
}
