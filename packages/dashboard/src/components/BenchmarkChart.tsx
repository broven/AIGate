import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import type { BenchmarkData } from '../lib/api'

interface BenchmarkChartProps {
  data: BenchmarkData | null
  loading?: boolean
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
      <div>Score: {data.x?.toFixed(2)}</div>
      <div>Price: ${data.y?.toFixed(2)}/1M tokens</div>
    </div>
  )
}

export function BenchmarkChart({ data, loading }: BenchmarkChartProps) {
  const [selectedDimension, setSelectedDimension] = useState('artificial_analysis_intelligence_index')
  const [selectedProviders, setSelectedProviders] = useState<Set<string>>(new Set())
  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const allProviderIds = useMemo(() => {
    if (!data) return []
    return [...new Set(data.points.map(p => p.providerId))]
  }, [data])

  // Initialize selectedProviders when data changes
  useEffect(() => {
    if (data) {
      setSelectedProviders(new Set(data.points.map(p => p.providerId)))
    }
  }, [data])

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setProviderDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const toggleAll = useCallback(() => {
    if (selectedProviders.size === allProviderIds.length) {
      setSelectedProviders(new Set())
    } else {
      setSelectedProviders(new Set(allProviderIds))
    }
  }, [selectedProviders.size, allProviderIds])

  const toggleProvider = useCallback((id: string) => {
    setSelectedProviders(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const filteredGroups = useMemo(() => {
    if (!data) return []
    const grouped = new Map<string, Array<{ x: number; y: number; canonical: string; providerId: string }>>()
    for (const point of data.points) {
      const score = point.benchmarks[selectedDimension]
      if (score == null) continue
      if (!selectedProviders.has(point.providerId)) continue
      if (!grouped.has(point.providerId)) {
        grouped.set(point.providerId, [])
      }
      grouped.get(point.providerId)!.push({
        x: score,
        y: point.blendedPrice,
        canonical: point.canonical,
        providerId: point.providerId,
      })
    }
    return [...grouped.entries()]
  }, [data, selectedDimension, selectedProviders])

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

          <div className="multi-select" ref={dropdownRef} style={{ position: 'relative' }}>
            <button className="btn" onClick={() => setProviderDropdownOpen(!providerDropdownOpen)}>
              Providers ({selectedProviders.size})
            </button>
            {providerDropdownOpen && (
              <div className="multi-select-popover">
                <label className="multi-select-item">
                  <input
                    type="checkbox"
                    checked={selectedProviders.size === allProviderIds.length}
                    onChange={toggleAll}
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
        <div className="chart-container">
          <ResponsiveContainer width="100%" height={400}>
            <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                type="number"
                dataKey="x"
                name="Score"
                tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                label={{ value: DIMENSION_LABELS[selectedDimension] || selectedDimension, position: 'bottom', fill: 'var(--text-secondary)', fontSize: 12 }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name="Price"
                tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                label={{ value: 'USD / 1M tokens', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)', fontSize: 12 }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              {filteredGroups.map(([providerId, points], i) => (
                <Scatter
                  key={providerId}
                  name={providerId}
                  data={points}
                  fill={PROVIDER_COLORS[i % PROVIDER_COLORS.length]}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
