import { useState, useEffect, useCallback, useRef } from 'react'
import { getLogs, type LogEntry } from '../lib/api'
import { FallbackChain } from '../components/FallbackChain'

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`
}

function formatLatency(ms: number): string {
  return `${ms}ms`
}

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Filters
  const [model, setModel] = useState('')
  const [key, setKey] = useState('')
  const [status, setStatus] = useState('')

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchLogs = useCallback(async (cursor?: string) => {
    const params: { cursor?: string; limit?: number; model?: string; key?: string; status?: string } = {
      limit: 50,
    }
    if (cursor) params.cursor = cursor
    if (model) params.model = model
    if (key) params.key = key
    if (status) params.status = status

    const res = await getLogs(params)

    if (cursor) {
      setLogs(prev => [...prev, ...res.data])
    } else {
      setLogs(res.data)
    }
    setNextCursor(res.nextCursor)
  }, [model, key, status])

  const handleRefresh = useCallback(async () => {
    setLoading(true)
    try {
      await fetchLogs()
    } finally {
      setLoading(false)
    }
  }, [fetchLogs])

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      await fetchLogs(nextCursor)
    } finally {
      setLoadingMore(false)
    }
  }, [nextCursor, loadingMore, fetchLogs])

  // Initial fetch + filter changes
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchLogs().finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [fetchLogs])

  // Polling every 2s
  useEffect(() => {
    pollingRef.current = setInterval(() => {
      fetchLogs()
    }, 2000)
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [fetchLogs])

  const toggleRow = useCallback((id: string) => {
    setExpandedId(prev => prev === id ? null : id)
  }, [])

  return (
    <div>
      <h2>Request Logs</h2>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', color: 'var(--text-muted)' }}>Model</label>
          <input
            type="text"
            placeholder="Filter by model..."
            value={model}
            onChange={e => setModel(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)' }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', color: 'var(--text-muted)' }}>API Key</label>
          <input
            type="text"
            placeholder="Filter by key..."
            value={key}
            onChange={e => setKey(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)' }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', color: 'var(--text-muted)' }}>Status</label>
          <select
            value={status}
            onChange={e => setStatus(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)' }}
          >
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
          </select>
        </div>
        <button className="btn" onClick={handleRefresh} disabled={loading}>
          Refresh
        </button>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Model</th>
              <th>Key</th>
              <th>Route</th>
              <th>Latency</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>Saved</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && !loading ? (
              <tr>
                <td colSpan={8}>
                  <div className="empty-state">No request logs found</div>
                </td>
              </tr>
            ) : (
              logs.map(log => (
                <LogRow
                  key={log.id}
                  log={log}
                  expanded={expandedId === log.id}
                  onToggle={toggleRow}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <div style={{ textAlign: 'center', marginTop: '16px' }}>
          <button className="btn" onClick={handleLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}
    </div>
  )
}

function LogRow({ log, expanded, onToggle }: { log: LogEntry; expanded: boolean; onToggle: (id: string) => void }) {
  return (
    <>
      <tr onClick={() => onToggle(log.id)} style={{ cursor: 'pointer' }}>
        <td className="mono">{formatTime(log.createdAt)}</td>
        <td className="mono">
          {log.model.startsWith('virtual:') ? log.model.slice(8) : log.model}
          {log.model.startsWith('virtual:') && <span className="badge blue" style={{ marginLeft: '6px', fontSize: '11px' }}>Virtual</span>}
        </td>
        <td className="mono">{log.gatewayKey}</td>
        <td>
          <FallbackChain attempts={log.attempts} />
        </td>
        <td className="mono">{formatLatency(log.totalLatencyMs)}</td>
        <td className="mono">{log.inputTokens ?? '—'} / {log.outputTokens ?? '—'}</td>
        <td className="mono">{formatCost(log.cost ?? 0)}</td>
        <td>
          <span className={`badge ${(log.savedVsDirect ?? 0) > 0 ? 'green' : (log.savedVsDirect ?? 0) < 0 ? 'red' : 'yellow'}`}>
            {formatCost(log.savedVsDirect ?? 0)}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} style={{ padding: 0 }}>
            <div style={{ padding: '12px 24px', background: 'var(--bg-secondary)' }}>
              <strong>Attempts</strong>
              <table style={{ marginTop: '8px', width: '100%' }}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>提供商ID</th>
                    <th>Status</th>
                    <th>Latency</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {log.attempts.map((attempt, i) => (
                    <tr key={i}>
                      <td className="mono">{i + 1}</td>
                      <td className="mono">{attempt.groupName ? `${attempt.provider}-${attempt.groupName}` : attempt.provider}</td>
                      <td>
                        <span className={`badge ${attempt.status === 'success' ? 'green' : attempt.status === 'failed' ? 'red' : 'yellow'}`}>
                          {attempt.status}
                        </span>
                      </td>
                      <td className="mono">{attempt.latencyMs != null ? formatLatency(attempt.latencyMs) : '—'}</td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{attempt.error || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
