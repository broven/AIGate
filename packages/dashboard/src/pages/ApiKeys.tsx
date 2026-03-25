import { Fragment, useState, useEffect, useCallback } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { getKeys, createKey, deleteKey, getKeyUsage, getKeyStats } from '../lib/api'
import type { GatewayKey, KeyUsage } from '../lib/api'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button className="btn" onClick={handleCopy} style={{ padding: '2px 8px', fontSize: 12 }}>
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function ConfigGuide({ apiKey, gatewayUrl }: { apiKey: string; gatewayUrl: string }) {
  const [activeTab, setActiveTab] = useState<'claude' | 'codex' | 'curl'>('claude')

  const tabs: { key: typeof activeTab; label: string }[] = [
    { key: 'claude', label: 'Claude Code' },
    { key: 'codex', label: 'Codex CLI' },
    { key: 'curl', label: 'cURL' },
  ]

  const snippets: Record<typeof activeTab, string> = {
    claude: [
      `# Add to your ~/.claude/settings.json`,
      `{`,
      `  "ANTHROPIC_API_KEY": "${apiKey}",`,
      `  "ANTHROPIC_BASE_URL": "${gatewayUrl}"`,
      `}`,
      ``,
      `# Or use environment variables`,
      `export ANTHROPIC_API_KEY="${apiKey}"`,
      `export ANTHROPIC_BASE_URL="${gatewayUrl}"`,
    ].join('\n'),
    codex: [
      `# Add to your ~/.codex/config.toml`,
      ``,
      `[provider]`,
      `name = "aigate"`,
      `base_url = "${gatewayUrl}/v1"`,
      `wire_api = "chat"          # AIGate uses Chat Completions API`,
      `env_key = "AIGATE_API_KEY" # or paste your key below`,
      ``,
      `# Then set the environment variable`,
      `export AIGATE_API_KEY="${apiKey}"`,
    ].join('\n'),
    curl: [
      `curl ${gatewayUrl}/v1/chat/completions \\`,
      `  -H "Authorization: Bearer ${apiKey}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{`,
      `    "model": "gpt-4o",`,
      `    "messages": [{"role": "user", "content": "Hello!"}]`,
      `  }'`,
    ].join('\n'),
  }

  const tabBarStyle: React.CSSProperties = {
    display: 'flex',
    gap: 0,
    borderBottom: '1px solid var(--border)',
    marginBottom: 12,
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 16px',
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    color: active ? 'var(--accent-blue)' : 'var(--text-secondary)',
    background: 'none',
    border: 'none',
    borderBottom: active ? '2px solid var(--accent-blue)' : '2px solid transparent',
    cursor: 'pointer',
    transition: 'color 0.15s, border-color 0.15s',
  })

  return (
    <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Quick Setup
      </div>
      <div style={tabBarStyle}>
        {tabs.map((t) => (
          <button key={t.key} style={tabStyle(activeTab === t.key)} onClick={() => setActiveTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ position: 'relative' }}>
        <pre className="mono" style={{
          background: 'var(--color-bg)',
          padding: 14,
          borderRadius: 6,
          overflow: 'auto',
          fontSize: 12,
          lineHeight: 1.6,
          margin: 0,
        }}>
          {snippets[activeTab]}
        </pre>
        <span style={{ position: 'absolute', top: 8, right: 8 }}>
          <CopyButton text={snippets[activeTab]} />
        </span>
      </div>
    </div>
  )
}

function KeyUsagePanel({ keyId, onStats }: { keyId: string; onStats?: (stats: { requests: number; tokens: number; cost: number }) => void }) {
  const [usage, setUsage] = useState<KeyUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getKeyUsage(keyId)
      .then((data) => {
        setUsage(data)
        if (onStats) {
          const requests = data.byModel.reduce((s, m) => s + m.requests, 0)
          const tokens = data.byModel.reduce((s, m) => s + m.inputTokens + m.outputTokens, 0)
          const cost = data.byModel.reduce((s, m) => s + m.cost, 0)
          onStats({ requests, tokens, cost })
        }
      })
      .catch((e) => setError(e.message || 'Failed to load usage'))
      .finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyId])

  if (loading) return <div style={{ padding: 16, color: 'var(--text-secondary)' }}>Loading usage...</div>
  if (error) return <div style={{ padding: 16, color: 'var(--danger)' }}>Error: {error}</div>
  if (!usage || (usage.byModel.length === 0 && usage.byDay.length === 0)) {
    return <div style={{ padding: 16, color: 'var(--text-secondary)' }}>No usage yet</div>
  }

  return (
    <div style={{ display: 'flex', gap: 24, padding: '12px 16px', flexWrap: 'wrap' }}>
      {/* Per-model table */}
      <div style={{ flex: '1 1 300px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          By Model
        </div>
        <table style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Model</th>
              <th>Requests</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {usage.byModel.map((m) => (
              <tr key={m.model}>
                <td>{m.model}</td>
                <td>{m.requests}</td>
                <td>{formatTokens(m.inputTokens)}</td>
                <td>{formatTokens(m.outputTokens)}</td>
                <td>{formatCost(m.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 30-day trend chart */}
      {usage.byDay.length > 0 && (
        <div style={{ flex: '1 1 400px', minHeight: 200 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            30-Day Trend
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={usage.byDay}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                tickFormatter={(d: string) => d.slice(5)}
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                width={40}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                width={50}
                tickFormatter={(v: number) => `$${v.toFixed(2)}`}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontSize: 12,
                }}
              />
              <Line yAxisId="left" type="monotone" dataKey="requests" stroke="var(--accent-blue)" dot={false} name="Requests" />
              <Line yAxisId="right" type="monotone" dataKey="cost" stroke="var(--accent-green)" dot={false} name="Cost" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

export default function ApiKeys() {
  const [keys, setKeys] = useState<GatewayKey[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Aggregate usage stats per key (populated on expand)
  const [keyStats, setKeyStats] = useState<Record<string, { requests: number; tokens: number; cost: number }>>({})

  const handleKeyStats = useCallback((keyId: string) => (stats: { requests: number; tokens: number; cost: number }) => {
    setKeyStats((prev) => ({ ...prev, [keyId]: stats }))
  }, [])

  const fetchKeys = useCallback(async () => {
    setError(null)
    try {
      const [data, stats] = await Promise.all([getKeys(), getKeyStats()])
      setKeys(data)
      setKeyStats(stats)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load keys')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchKeys()
  }, [fetchKeys])

  const handleCreate = async () => {
    if (!newKeyName.trim()) return
    setCreating(true)
    setError(null)
    try {
      await createKey(newKeyName.trim())
      setShowCreateModal(false)
      setNewKeyName('')
      await fetchKeys()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create key')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    setError(null)
    try {
      await deleteKey(id)
      setDeleteConfirmId(null)
      if (expandedId === id) setExpandedId(null)
      await fetchKeys()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete key')
    }
  }

  return (
    <div>
      <div className="section">
        <div className="section-header">
          <h2 className="section-title">API Keys</h2>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            Create Key
          </button>
        </div>

        {error && (
          <div style={{ padding: '8px 12px', marginBottom: 12, background: 'var(--danger-bg, #fee)', color: 'var(--danger, #c00)', borderRadius: 4, fontSize: 13 }}>
            {error}
          </div>
        )}

        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Key</th>
                <th>Requests</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} style={{ textAlign: 'center' }}>Loading...</td></tr>
              ) : keys.length === 0 ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>No API keys yet. Create one to get started.</td></tr>
              ) : (
                keys.map((key) => {
                  const isExpanded = expandedId === key.id
                  const stats = keyStats[key.id]
                  return (
                    <Fragment key={key.id}>
                      <tr
                        style={{ cursor: 'pointer' }}
                        onClick={() => setExpandedId(isExpanded ? null : key.id)}
                      >
                        <td style={{ width: 32, textAlign: 'center', fontSize: 10 }}>
                          {isExpanded ? '\u25BC' : '\u25B6'}
                        </td>
                        <td>{key.name}</td>
                        <td>
                          <code className="mono" style={{ fontSize: 12 }}>{key.keyPlain}</code>
                          <span onClick={(e) => e.stopPropagation()} style={{ marginLeft: 8 }}>
                            <CopyButton text={key.keyPlain} />
                          </span>
                        </td>
                        <td>{stats ? stats.requests : '–'}</td>
                        <td>{stats ? formatTokens(stats.tokens) : '–'}</td>
                        <td>{stats ? formatCost(stats.cost) : '–'}</td>
                        <td className="mono">{formatDate(key.createdAt)}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {deleteConfirmId === key.id ? (
                            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <span style={{ fontSize: 12 }}>Sure?</span>
                              <button className="btn btn-danger" onClick={() => handleDelete(key.id)}>Yes</button>
                              <button className="btn" onClick={() => setDeleteConfirmId(null)}>No</button>
                            </span>
                          ) : (
                            <button className="btn btn-danger" onClick={() => setDeleteConfirmId(key.id)}>Delete</button>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${key.id}-usage`}>
                          <td colSpan={8} style={{ padding: 0, background: 'var(--bg-primary)' }}>
                            <KeyUsagePanel keyId={key.id} onStats={handleKeyStats(key.id)} />
                            <ConfigGuide apiKey={key.keyPlain} gatewayUrl={window.location.origin} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Key Modal */}
      {showCreateModal && (
        <div className="modal-backdrop" onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create API Key</h3>
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g. Development, Production"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
              />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowCreateModal(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={creating || !newKeyName.trim()}
              >
                {creating ? 'Creating...' : 'Create Key'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
