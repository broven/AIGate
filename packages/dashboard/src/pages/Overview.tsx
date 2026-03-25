import { useCallback, useMemo, useState } from 'react'
import { getStats, getBenchmarks, getModelPreferences, setDeploymentBlacklist, getCooldowns, resetCooldown, type BenchmarkData, type CooldownEntry } from '../lib/api'
import { usePolling } from '../hooks/usePolling'
import { BenchmarkChart } from '../components/BenchmarkChart'

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0s'
  const totalSec = Math.ceil(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export default function Overview() {
  const fetchStats = useCallback(() => getStats(), [])
  const fetchBenchmarks = useCallback(() => getBenchmarks(), [])
  const fetchPreferences = useCallback(() => getModelPreferences(), [])
  const fetchCooldowns = useCallback(() => getCooldowns(), [])

  const { data: stats, loading: statsLoading } = usePolling(fetchStats, 5000)
  const { data: benchmarks, loading: benchmarksLoading, mutate: mutateBenchmarks } = usePolling(fetchBenchmarks, 60000)
  const { data: preferences } = usePolling(fetchPreferences, 60000)
  const { data: cooldowns, mutate: mutateCooldowns } = usePolling(fetchCooldowns, 1000)

  const [resetting, setResetting] = useState<Set<string>>(new Set())

  const blacklist = useMemo(() => {
    if (!preferences) return new Set<string>()
    return new Set(preferences.filter(p => p.preference === 'blacklist').map(p => p.canonical))
  }, [preferences])

  const handleBlacklist = useCallback(async (deploymentId: string) => {
    mutateBenchmarks((prev: BenchmarkData | null) => {
      if (!prev) return prev
      return { ...prev, points: prev.points.filter(p => p.deploymentId !== deploymentId) }
    })
    try {
      await setDeploymentBlacklist(deploymentId, true)
      const fresh = await getBenchmarks()
      mutateBenchmarks(() => fresh)
    } catch (err) {
      console.error('[blacklist] Failed to blacklist deployment:', err)
      try {
        const fresh = await getBenchmarks()
        mutateBenchmarks(() => fresh)
      } catch {
        // leave stale
      }
    }
  }, [mutateBenchmarks])

  const handleReset = useCallback(async (deploymentId: string) => {
    setResetting(prev => new Set(prev).add(deploymentId))
    mutateCooldowns((prev: CooldownEntry[] | null) =>
      prev ? prev.filter(e => e.deploymentId !== deploymentId) : prev
    )
    try {
      await resetCooldown(deploymentId)
      const fresh = await getCooldowns()
      mutateCooldowns(() => fresh)
    } catch (err) {
      console.error('[reset cooldown] Failed:', err)
      const fresh = await getCooldowns()
      mutateCooldowns(() => fresh)
    } finally {
      setResetting(prev => { const s = new Set(prev); s.delete(deploymentId); return s })
    }
  }, [mutateCooldowns])

  return (
    <div>
      <div className="stat-grid">
        <div className="stat-card">
          <div className="label">Today's Requests</div>
          <div className="value">{statsLoading ? '—' : stats?.today.requests.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="label">Today's Cost</div>
          <div className="value">{statsLoading ? '—' : formatCost(stats?.today.cost ?? 0)}</div>
        </div>
        <div className="stat-card">
          <div className="label">Today's Savings</div>
          <div className="value delta">{statsLoading ? '—' : formatCost(stats?.today.saved ?? 0)}</div>
        </div>
        <div className="stat-card">
          <div className="label">Success Rate</div>
          <div className="value">{statsLoading ? '—' : `${(stats?.today.successRate ?? 0).toFixed(1)}%`}</div>
        </div>
        <div className="stat-card">
          <div className="label">Active Providers</div>
          <div className="value">{statsLoading ? '—' : stats?.activeProviders}</div>
        </div>
      </div>

      <BenchmarkChart data={benchmarks} loading={benchmarksLoading} blacklist={blacklist} onBlacklist={handleBlacklist} />

      <div className="section">
        <div className="section-header">
          <h2 className="section-title">Active Cooldowns</h2>
        </div>
        {!cooldowns || cooldowns.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-muted, #888)', fontSize: '0.875rem' }}>
            No active cooldowns
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Deployment</th>
                  <th>Failures</th>
                  <th>Remaining</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {cooldowns.map((entry) => (
                  <tr key={entry.deploymentId}>
                    <td className="mono">{entry.deploymentId}</td>
                    <td className="mono">{entry.consecutiveFailures}</td>
                    <td className="mono" style={{ color: 'var(--warning, #f59e0b)' }}>
                      {formatRemaining(entry.remainingMs)}
                    </td>
                    <td>
                      <button
                        onClick={() => handleReset(entry.deploymentId)}
                        disabled={resetting.has(entry.deploymentId)}
                        style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem', cursor: 'pointer' }}
                      >
                        {resetting.has(entry.deploymentId) ? 'Resetting…' : 'Reset'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
