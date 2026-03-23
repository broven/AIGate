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
import { getModels, getProviders, getModelPreferences, setModelPreferences, updateModelPrice, getBenchmarks, type ModelDeployment, type Provider } from '../lib/api'
import { usePolling } from '../hooks/usePolling'
import { displayName, getAliases } from '../lib/model-utils'

const DIMENSION_LABELS: Record<string, string> = {
  artificial_analysis_intelligence_index: 'Intelligence Index',
  artificial_analysis_coding_index: 'Coding Index',
  artificial_analysis_math_index: 'Math Index',
  mmlu_pro: 'MMLU Pro',
  gpqa: 'GPQA',
  hle: 'HLE',
  livecodebench: 'LiveCodeBench',
  scicode: 'SciCode',
  math_500: 'MATH-500',
  aime: 'AIME',
  aime_25: 'AIME 2025',
  ifbench: 'IFBench',
  lcr: 'LCR',
  terminalbench_hard: 'TerminalBench Hard',
  tau2: 'TAU2',
}

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

  // Benchmarks: poll every 60s
  const fetchBenchmarks = useCallback(() => getBenchmarks(), [])
  const { data: benchmarks } = usePolling(fetchBenchmarks, 60000)
  const hasBenchmarks = benchmarks?.configured === true

  // Derived state
  const providerMap = useMemo(() => {
    if (!providers) return new Map<string, Provider>()
    return new Map(providers.map((p) => [p.id, p]))
  }, [providers])

  // Preferences: fetch once on mount and after mutations
  const [preferences, setPreferences] = useState<Map<string, 'favorite' | 'blacklist'>>(new Map())
  useEffect(() => {
    getModelPreferences().then((rows) => {
      setPreferences(new Map(rows.map((r) => [r.canonical, r.preference])))
    }).catch(() => {})
  }, [])

  // UI state
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [edits, setEdits] = useState<Record<string, PriceEdit>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [providerFilter, setProviderFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'stale'>('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectedDimension, setSelectedDimension] = useState('artificial_analysis_intelligence_index')
  const [sortBy, setSortBy] = useState<'name' | 'deployments' | 'score'>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  // Block page on either fetch error
  const error = modelError?.message || providerError
  const loading = modelLoading || providers === null

  // Benchmark lookup: canonical → { dim → score }
  const benchmarkMap = useMemo(() => {
    const map = new Map<string, Record<string, number | null>>()
    if (!benchmarks?.points) return map
    for (const point of benchmarks.points) {
      if (!map.has(point.canonical)) {
        map.set(point.canonical, point.benchmarks)
      }
    }
    return map
  }, [benchmarks])

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
      .sort((a, b) => {
        const prefA = preferences.get(a.canonical)
        const prefB = preferences.get(b.canonical)
        const tierA = prefA === 'favorite' ? 0 : prefA === 'blacklist' ? 2 : 1
        const tierB = prefB === 'favorite' ? 0 : prefB === 'blacklist' ? 2 : 1
        if (tierA !== tierB) return tierA - tierB

        const dir = sortDir === 'asc' ? 1 : -1
        if (sortBy === 'deployments') {
          return (a.deployments.length - b.deployments.length) * dir
        }
        if (sortBy === 'score') {
          const scoreA = benchmarkMap.get(a.canonical)?.[selectedDimension] ?? null
          const scoreB = benchmarkMap.get(b.canonical)?.[selectedDimension] ?? null
          if (scoreA === null && scoreB === null) return a.canonical.localeCompare(b.canonical)
          if (scoreA === null) return 1
          if (scoreB === null) return -1
          return (scoreA - scoreB) * dir
        }
        return a.canonical.localeCompare(b.canonical) * dir
      })
  }, [models, preferences, sortBy, sortDir, benchmarkMap, selectedDimension])

  // Filter groups
  const filtered = useMemo(() => {
    return groups.filter((g) => {
      if (search) {
        const q = search.toLowerCase()
        const matchesCanonical = g.canonical.toLowerCase().includes(q)
        const matchesDisplay = displayName(g.canonical).toLowerCase().includes(q)
        if (!matchesCanonical && !matchesDisplay) return false
      }
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

  function handleSort(col: 'name' | 'deployments' | 'score') {
    if (sortBy === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(col)
      setSortDir(col === 'score' ? 'desc' : 'asc')
    }
  }

  function sortIndicator(col: 'name' | 'deployments' | 'score') {
    if (sortBy !== col) return null
    return <span className="sort-indicator">{sortDir === 'asc' ? '▲' : '▼'}</span>
  }

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

  async function handleTogglePreference(canonical: string, pref: 'favorite' | 'blacklist') {
    const current = preferences.get(canonical)
    const newPref = current === pref ? null : pref
    setPreferences((prev) => {
      const next = new Map(prev)
      if (newPref === null) next.delete(canonical)
      else next.set(canonical, newPref)
      return next
    })
    await setModelPreferences([canonical], newPref)
  }

  async function handleBatchPreference(pref: 'favorite' | 'blacklist' | null) {
    const canonicals = [...selected]
    setPreferences((prev) => {
      const next = new Map(prev)
      for (const c of canonicals) {
        if (pref === null) next.delete(c)
        else next.set(c, pref)
      }
      return next
    })
    setSelected(new Set())
    await setModelPreferences(canonicals, pref)
  }

  function toggleSelect(canonical: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(canonical)) next.delete(canonical)
      else next.add(canonical)
      return next
    })
  }

  // Clear selection when filters change
  useEffect(() => {
    setSelected(new Set())
  }, [search, providerFilter, statusFilter])

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
          className="filter-select"
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
        >
          <option value="">All Providers</option>
          {providerOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <select
          className="filter-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as '' | 'active' | 'stale')}
        >
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="stale">Stale</option>
        </select>
        {hasBenchmarks && (
          <select
            className="filter-select"
            value={selectedDimension}
            onChange={(e) => setSelectedDimension(e.target.value)}
          >
            {benchmarks!.dimensions.map(dim => (
              <option key={dim} value={dim}>{DIMENSION_LABELS[dim] || dim}</option>
            ))}
          </select>
        )}
      </div>

      {/* Batch action bar */}
      {selected.size > 0 && (
        <div className="batch-bar">
          <span className="batch-count">{selected.size} selected</span>
          <button className="btn" onClick={() => handleBatchPreference('favorite')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--accent-yellow)" stroke="var(--accent-yellow)" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
            Favorite
          </button>
          <button className="btn" onClick={() => handleBatchPreference('blacklist')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-red)" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></svg>
            Blacklist
          </button>
          <button className="btn" onClick={() => handleBatchPreference(null)}>Clear</button>
        </div>
      )}

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
                <th style={{ width: 32, textAlign: 'center' }}>
                  <input type="checkbox" className="custom-checkbox"
                    checked={filtered.length > 0 && filtered.every((g) => selected.has(g.canonical))}
                    onChange={(e) => {
                      if (e.target.checked) setSelected(new Set(filtered.map((g) => g.canonical)))
                      else setSelected(new Set())
                    }}
                  />
                </th>
                <th style={{ width: 64 }}></th>
                <th className="sortable-th" onClick={() => handleSort('name')}>Model{sortIndicator('name')}</th>
                <th className="sortable-th" onClick={() => handleSort('deployments')}>Deployments{sortIndicator('deployments')}</th>
                {hasBenchmarks && <th className="sortable-th" onClick={() => handleSort('score')}>Score{sortIndicator('score')}</th>}
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
                    preference={preferences.get(group.canonical)}
                    onTogglePreference={handleTogglePreference}
                    isSelected={selected.has(group.canonical)}
                    onToggleSelect={() => toggleSelect(group.canonical)}
                    score={benchmarkMap.get(group.canonical)?.[selectedDimension] ?? null}
                    showScore={hasBenchmarks}
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
  preference?: 'favorite' | 'blacklist'
  onTogglePreference: (canonical: string, pref: 'favorite' | 'blacklist') => void
  isSelected: boolean
  onToggleSelect: () => void
  score: number | null
  showScore: boolean
}

function ModelGroup({
  canonical, deployments, isExpanded, status,
  inputPriceRange, outputPriceRange, onToggle,
  getEditValue, setEditField, isDirty, handleSave,
  saving, saveErrors, providerIdLabel,
  preference, onTogglePreference, isSelected, onToggleSelect,
  score, showScore,
}: ModelGroupProps) {
  const isFavorite = preference === 'favorite'
  const isBlacklisted = preference === 'blacklist'

  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor: 'pointer',
          background: isExpanded ? 'var(--bg-hover)' : undefined,
          borderLeft: isFavorite ? '3px solid var(--accent-yellow, #e6a700)' : isBlacklisted ? '3px solid var(--accent-red, #e53e3e)' : '3px solid transparent',
          opacity: isBlacklisted ? 0.5 : 1,
        }}
      >
        <td style={{ width: 32, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" className="custom-checkbox" checked={isSelected} onChange={onToggleSelect} />
        </td>
        <td style={{ width: 64, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
          <button
            className={`pref-btn pref-btn-fav${isFavorite ? ' active' : ''}`}
            onClick={() => onTogglePreference(canonical, 'favorite')}
            title={isFavorite ? 'Remove favorite' : 'Favorite'}
          >
            <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
          </button>
          <button
            className={`pref-btn pref-btn-ban${isBlacklisted ? ' active' : ''}`}
            onClick={() => onTogglePreference(canonical, 'blacklist')}
            title={isBlacklisted ? 'Remove blacklist' : 'Blacklist'}
          >
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></svg>
          </button>
        </td>
        <td>
          <span style={{ color: 'var(--accent-blue)', marginRight: 6, fontSize: 11 }}>
            {isExpanded ? '▼' : '▶'}
          </span>
          <strong style={{ textDecoration: isBlacklisted ? 'line-through' : undefined }}>{displayName(canonical)}</strong>
          {getAliases(canonical).length > 0 && (
            <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 8 }}>
              aka {canonical}
            </span>
          )}
        </td>
        <td>
          <span className="badge" style={{ fontSize: 11 }}>
            {deployments.length} deployment{deployments.length !== 1 ? 's' : ''}
          </span>
        </td>
        {showScore && (
          <td className="mono" style={{ color: score !== null ? 'var(--text-primary)' : 'var(--text-muted)' }}>
            {score !== null ? score.toFixed(1) : '—'}
          </td>
        )}
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
          showScore={showScore}
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
  showScore: boolean
}

function ProviderLogo({ providerId }: { providerId: string }) {
  return (
    <img
      src={`https://models.dev/logos/${providerId}.svg`}
      alt=""
      width={16}
      height={16}
      style={{ verticalAlign: 'middle', marginRight: 6, flexShrink: 0 }}
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
    />
  )
}

function DeploymentRow({
  deployment, editValue, onEditField, dirty, onSave, isSaving, error, providerLabel, showScore,
}: DeploymentRowProps) {
  const source = derivedPriceSource(deployment)
  const badgeClass = SOURCE_BADGE_CLASS[source] || ''

  return (
    <>
      <tr style={{ background: 'var(--bg-primary)' }}>
        <td></td>
        <td></td>
        <td style={{ paddingLeft: 40 }}>
          <ProviderLogo providerId={deployment.providerId} />
          <span className="badge" style={{ fontSize: 11, marginRight: 8 }}>{providerLabel}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{deployment.upstream}</span>
        </td>
        <td>
          <span className={`badge ${badgeClass}`} style={{ fontSize: 10 }}>{source}</span>
        </td>
        {showScore && <td></td>}
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
          <td colSpan={showScore ? 7 : 6} style={{ paddingLeft: 40, color: 'var(--accent-red)', fontSize: 12 }}>
            {error}
          </td>
        </tr>
      )}
    </>
  )
}
