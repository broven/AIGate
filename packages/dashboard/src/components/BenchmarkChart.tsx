import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import type { BenchmarkData } from '../lib/api'

const STORAGE_KEY_PROVIDERS = 'aigate_chart_providers'
const STORAGE_KEY_MODELS = 'aigate_chart_models'

function loadSet(key: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set<string>(arr) : null
  } catch { return null }
}

function saveSet(key: string, set: Set<string>): void {
  localStorage.setItem(key, JSON.stringify([...set]))
}

interface BenchmarkChartProps {
  data: BenchmarkData | null
  loading?: boolean
  blacklist?: Set<string>
  onBlacklist?: (deploymentId: string) => void
}

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

const PROVIDER_COLORS = [
  '#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7',
  '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
]

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const data = payload[0].payload
  return (
    <div className="chart-tooltip">
      <div style={{ fontWeight: 600 }}>{data.canonical}</div>
      <div style={{ color: 'var(--text-secondary)' }}>{data.providerId}</div>
      {data.groupName && <div style={{ color: 'var(--text-secondary)' }}>Group: {data.groupName}</div>}
      <div>Score: {data.y?.toFixed(2)}</div>
      <div>Price: ${data.x?.toFixed(2)}/1M tokens</div>
    </div>
  )
}

interface PopoverPoint {
  x: number
  y: number
  canonical: string
  providerId: string
  groupName?: string | null
  deploymentId: string
  screenX: number
  screenY: number
}

export function BenchmarkChart({ data, loading, blacklist, onBlacklist }: BenchmarkChartProps) {
  const [selectedDimension, setSelectedDimension] = useState('artificial_analysis_intelligence_index')
  const [selectedProviders, setSelectedProviders] = useState<Set<string>>(new Set())
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false)
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [popover, setPopover] = useState<PopoverPoint | null>(null)
  const providerDropdownRef = useRef<HTMLDivElement>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const userHasInteractedProviders = useRef(false)
  const userHasInteractedModels = useRef(false)

  const allProviderIds = useMemo(() => {
    if (!data) return []
    return [...new Set(data.points.map(p => p.providerId))]
  }, [data])

  const allModelIds = useMemo(() => {
    if (!data) return []
    return [...new Set(data.points.filter(p => !blacklist?.has(p.canonical)).map(p => p.canonical))].sort()
  }, [data, blacklist])

  const filteredModelIds = useMemo(() => {
    if (!modelSearch) return allModelIds
    const q = modelSearch.toLowerCase()
    return allModelIds.filter(id => id.toLowerCase().includes(q))
  }, [allModelIds, modelSearch])

  // Initialize selections from localStorage or default to all
  useEffect(() => {
    if (!data) return
    const allProviders = new Set(data.points.map(p => p.providerId))
    const allModels = new Set(data.points.filter(p => !blacklist?.has(p.canonical)).map(p => p.canonical))

    if (!userHasInteractedProviders.current) {
      const saved = loadSet(STORAGE_KEY_PROVIDERS)
      if (saved) {
        // Intersect with current available providers
        const restored = new Set([...saved].filter(id => allProviders.has(id)))
        setSelectedProviders(restored.size > 0 ? restored : allProviders)
      } else {
        setSelectedProviders(allProviders)
      }
    }

    if (!userHasInteractedModels.current) {
      const saved = loadSet(STORAGE_KEY_MODELS)
      if (saved) {
        const restored = new Set([...saved].filter(id => allModels.has(id)))
        setSelectedModels(restored.size > 0 ? restored : allModels)
      } else {
        setSelectedModels(allModels)
      }
    }
  }, [data, blacklist])

  // Close dropdowns/popover on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (providerDropdownRef.current && !providerDropdownRef.current.contains(e.target as Node)) {
        setProviderDropdownOpen(false)
      }
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false)
      }
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopover(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const toggleAllProviders = useCallback(() => {
    userHasInteractedProviders.current = true
    setSelectedProviders(prev => {
      const next = prev.size === allProviderIds.length ? new Set<string>() : new Set(allProviderIds)
      saveSet(STORAGE_KEY_PROVIDERS, next)
      return next
    })
  }, [allProviderIds])

  const toggleProvider = useCallback((id: string) => {
    userHasInteractedProviders.current = true
    setSelectedProviders(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveSet(STORAGE_KEY_PROVIDERS, next)
      return next
    })
  }, [])

  const toggleAllModels = useCallback(() => {
    userHasInteractedModels.current = true
    const targets = filteredModelIds
    setSelectedModels(prev => {
      const allSelected = targets.every(id => prev.has(id))
      const next = new Set(prev)
      if (allSelected) {
        for (const id of targets) next.delete(id)
      } else {
        for (const id of targets) next.add(id)
      }
      saveSet(STORAGE_KEY_MODELS, next)
      return next
    })
  }, [filteredModelIds])

  const invertModels = useCallback(() => {
    userHasInteractedModels.current = true
    const targets = filteredModelIds
    setSelectedModels(prev => {
      const next = new Set(prev)
      for (const id of targets) {
        if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      saveSet(STORAGE_KEY_MODELS, next)
      return next
    })
  }, [filteredModelIds])

  const toggleModel = useCallback((id: string) => {
    userHasInteractedModels.current = true
    setSelectedModels(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveSet(STORAGE_KEY_MODELS, next)
      return next
    })
  }, [])

  const filteredGroups = useMemo(() => {
    if (!data) return []
    const grouped = new Map<string, Array<{ x: number; y: number; canonical: string; providerId: string; groupName?: string | null; deploymentId: string }>>()
    for (const point of data.points) {
      const score = point.benchmarks[selectedDimension]
      if (score == null) continue
      if (!selectedProviders.has(point.providerId)) continue
      if (blacklist?.has(point.canonical)) continue
      if (!selectedModels.has(point.canonical)) continue
      if (!grouped.has(point.providerId)) {
        grouped.set(point.providerId, [])
      }
      grouped.get(point.providerId)!.push({
        x: point.blendedPrice,
        y: score,
        canonical: point.canonical,
        providerId: point.providerId,
        groupName: point.groupName,
        deploymentId: point.deploymentId,
      })
    }
    return [...grouped.entries()]
  }, [data, selectedDimension, selectedProviders, selectedModels, blacklist])

  const handleScatterClick = useCallback((pointData: any, _: any, e: React.MouseEvent) => {
    if (!onBlacklist) return
    const rect = chartContainerRef.current?.getBoundingClientRect()
    if (!rect) return
    setPopover({
      ...pointData,
      screenX: e.clientX - rect.left,
      screenY: e.clientY - rect.top,
    })
  }, [onBlacklist])

  const handleBlacklist = useCallback(() => {
    if (popover && onBlacklist) {
      onBlacklist(popover.deploymentId)
      setPopover(null)
    }
  }, [popover, onBlacklist])

  return (
    <div className="section">
      <div className="section-header">
        <h2 className="section-title">Benchmark vs Price</h2>
        {data?.configured !== false && <div className="chart-controls">
          <select
            value={selectedDimension}
            onChange={e => setSelectedDimension(e.target.value)}
            className="chart-select"
          >
            {data?.dimensions.map(dim => (
              <option key={dim} value={dim}>{DIMENSION_LABELS[dim] || dim}</option>
            ))}
          </select>

          <div className="multi-select" ref={providerDropdownRef} style={{ position: 'relative' }}>
            <button className="btn" onClick={() => setProviderDropdownOpen(!providerDropdownOpen)}>
              Providers ({selectedProviders.size})
            </button>
            {providerDropdownOpen && (
              <div className="multi-select-popover">
                <label className="multi-select-item">
                  <input
                    type="checkbox"
                    checked={selectedProviders.size === allProviderIds.length}
                    onChange={toggleAllProviders}
                  />
                  <span>Select All</span>
                </label>
                {allProviderIds.map(id => (
                  <label key={id} className="multi-select-item">
                    <input
                      type="checkbox"
                      checked={selectedProviders.has(id)}
                      onChange={() => toggleProvider(id)}
                    />
                    <span>{id}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="multi-select" ref={modelDropdownRef} style={{ position: 'relative' }}>
            <button className="btn" onClick={() => { setModelDropdownOpen(!modelDropdownOpen); if (!modelDropdownOpen) setModelSearch('') }}>
              Models ({selectedModels.size}/{allModelIds.length})
            </button>
            {modelDropdownOpen && (
              <div className="multi-select-popover multi-select-popover--models">
                <div className="multi-select-sticky">
                  <input
                    type="text"
                    className="multi-select-search"
                    placeholder="Search models..."
                    value={modelSearch}
                    onChange={e => setModelSearch(e.target.value)}
                    autoFocus
                  />
                  <div className="multi-select-actions">
                    <label className="multi-select-item">
                      <input
                        type="checkbox"
                        checked={filteredModelIds.length > 0 && filteredModelIds.every(id => selectedModels.has(id))}
                        onChange={toggleAllModels}
                      />
                      <span>Select All{modelSearch ? ` (${filteredModelIds.length})` : ''}</span>
                    </label>
                    <button className="multi-select-invert-btn" onClick={invertModels}>
                      Invert
                    </button>
                  </div>
                </div>
                <div className="multi-select-list">
                  {filteredModelIds.map(id => (
                    <label key={id} className="multi-select-item">
                      <input
                        type="checkbox"
                        checked={selectedModels.has(id)}
                        onChange={() => toggleModel(id)}
                      />
                      <span>{id}</span>
                    </label>
                  ))}
                  {filteredModelIds.length === 0 && (
                    <div style={{ padding: '8px', color: 'var(--text-muted)', fontSize: 13 }}>No models match</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>}
      </div>

      {loading || !data ? (
        <div className="chart-container" style={{ height: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: 'var(--text-secondary)' }}>Loading benchmark data...</span>
        </div>
      ) : !data.configured ? (
        <div className="chart-container benchmark-unconfigured" style={{ height: 400 }}>
          <div className="benchmark-unconfigured-icon">&#x1f4ca;</div>
          <div className="benchmark-unconfigured-title">Benchmark Data Not Configured</div>
          <div className="benchmark-unconfigured-text">
            Set the <code>ARTIFICIAL_ANALYSIS_API_TOKEN</code> environment variable to enable benchmark vs price comparisons.
            See the <a href="https://github.com/broven/AIGate#benchmark-charts" target="_blank" rel="noopener noreferrer">setup guide</a> for details.
          </div>
          <a href="https://artificialanalysis.ai" target="_blank" rel="noopener noreferrer" className="benchmark-unconfigured-link">
            Get an API key from Artificial Analysis &rarr;
          </a>
        </div>
      ) : filteredGroups.length === 0 ? (
        <div className="chart-container" style={{ height: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: 'var(--text-secondary)' }}>No benchmark data available</span>
        </div>
      ) : (
        <div className="chart-container" ref={chartContainerRef} style={{ position: 'relative' }}>
          <ResponsiveContainer width="100%" height={400}>
            <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                type="number"
                dataKey="x"
                name="Price"
                tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                label={{ value: 'USD / 1M tokens', position: 'bottom', fill: 'var(--text-secondary)', fontSize: 12 }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name="Score"
                tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                label={{ value: DIMENSION_LABELS[selectedDimension] || selectedDimension, angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)', fontSize: 12 }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend verticalAlign="top" align="right" />
              {filteredGroups.map(([providerId, points], i) => (
                <Scatter
                  key={providerId}
                  name={providerId}
                  data={points}
                  fill={PROVIDER_COLORS[i % PROVIDER_COLORS.length]}
                  onClick={onBlacklist ? handleScatterClick : undefined}
                  cursor={onBlacklist ? 'pointer' : undefined}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
          {popover && (
            <div
              ref={popoverRef}
              className="chart-popover"
              style={{
                position: 'absolute',
                left: popover.screenX,
                top: popover.screenY,
                transform: 'translate(-50%, -100%) translateY(-12px)',
              }}
            >
              <div style={{ fontWeight: 600 }}>{popover.canonical}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{popover.providerId}</div>
              {popover.groupName && <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Group: {popover.groupName}</div>}
              <div style={{ fontSize: 12 }}>Score: {popover.y?.toFixed(2)} | ${popover.x?.toFixed(2)}/1M</div>
              <button
                className="btn btn-danger"
                style={{ marginTop: 6, width: '100%', fontSize: 12, padding: '4px 8px' }}
                onClick={handleBlacklist}
              >
                Blacklist
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
