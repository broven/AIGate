import { useCallback, useMemo } from 'react'
import { getStats, getLogs, getBenchmarks, getModelPreferences, type LogEntry } from '../lib/api'
import { usePolling } from '../hooks/usePolling'
import { FallbackChain } from '../components/FallbackChain'
import { BenchmarkChart } from '../components/BenchmarkChart'

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function Overview() {
  const fetchStats = useCallback(() => getStats(), [])
  const fetchLogs = useCallback(() => getLogs({ limit: 20 }), [])

  const fetchBenchmarks = useCallback(() => getBenchmarks(), [])
  const fetchPreferences = useCallback(() => getModelPreferences(), [])
  const { data: stats, loading: statsLoading } = usePolling(fetchStats, 5000)
  const { data: logs, loading: logsLoading } = usePolling(fetchLogs, 5000)
  const { data: benchmarks, loading: benchmarksLoading } = usePolling(fetchBenchmarks, 60000)
  const { data: preferences } = usePolling(fetchPreferences, 60000)

  const blacklist = useMemo(() => {
    if (!preferences) return new Set<string>()
    return new Set(preferences.filter(p => p.preference === 'blacklist').map(p => p.canonical))
  }, [preferences])

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

      <BenchmarkChart data={benchmarks} loading={benchmarksLoading} blacklist={blacklist} />

      <div className="section">
        <div className="section-header">
          <h2 className="section-title">Recent Requests</h2>
        </div>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Model</th>
                <th>Provider</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Saved</th>
              </tr>
            </thead>
            <tbody>
              {logsLoading && !logs ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center' }}>Loading...</td>
                </tr>
              ) : logs?.data.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center' }}>No requests yet</td>
                </tr>
              ) : (
                logs?.data.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{formatTime(entry.createdAt)}</td>
                    <td className="mono">{entry.model}</td>
                    <td><FallbackChain attempts={entry.attempts} /></td>
                    <td className="mono">{((entry.inputTokens ?? 0) + (entry.outputTokens ?? 0)).toLocaleString()}</td>
                    <td className="mono">{formatCost(entry.cost ?? 0)}</td>
                    <td className="mono delta">{formatCost(entry.savedVsDirect ?? 0)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
