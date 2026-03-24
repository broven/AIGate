import { useState, useEffect, useCallback, useMemo } from 'react'
import { getProviders, createProvider, updateProvider, deleteProvider, syncProvider, getModels, setDeploymentBlacklist, type Provider, type ModelDeployment } from '../lib/api'

interface ProviderForm {
  id: string
  type: 'newapi' | 'openai-compatible'
  apiFormat: 'openai' | 'claude' | 'gemini'
  endpoint: string
  apiKey: string
  costMultiplier: string
  newapiUserId: string
  accessToken: string
  blackGroupMatch: string
  syncEnabled: boolean
  syncIntervalMinutes: number
}

const emptyForm: ProviderForm = {
  id: '',
  type: 'newapi',
  apiFormat: 'openai',
  endpoint: '',
  apiKey: '',
  costMultiplier: '',
  newapiUserId: '',
  accessToken: '',
  blackGroupMatch: '',
  syncEnabled: true,
  syncIntervalMinutes: 60,
}

function formatPrice(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return `$${v.toFixed(2)}`
}

export default function Providers() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [allDeployments, setAllDeployments] = useState<ModelDeployment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ProviderForm>(emptyForm)
  const [submitting, setSubmitting] = useState(false)
  const [syncing, setSyncing] = useState<Record<string, boolean>>({})
  const [syncResult, setSyncResult] = useState<{ id: string; message: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [togglingBlacklist, setTogglingBlacklist] = useState<Set<string>>(new Set())

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const [providerList, modelList] = await Promise.all([getProviders(), getModels()])
      setProviders(providerList)
      setAllDeployments(modelList)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load providers')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Group deployments by provider
  const deploymentsByProvider = useMemo(() => {
    const map: Record<string, ModelDeployment[]> = {}
    for (const d of allDeployments) {
      if (!map[d.providerId]) map[d.providerId] = []
      map[d.providerId].push(d)
    }
    return map
  }, [allDeployments])

  function toggleProvider(id: string) {
    setExpandedProviders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function handleToggleDeploymentBlacklist(deploymentId: string, currentBlacklisted: boolean) {
    const newVal = !currentBlacklisted
    setTogglingBlacklist((prev) => new Set(prev).add(deploymentId))
    // Optimistic update
    setAllDeployments((prev) =>
      prev.map((d) => d.deploymentId === deploymentId ? { ...d, blacklisted: newVal } : d),
    )
    try {
      await setDeploymentBlacklist(deploymentId, newVal)
    } catch {
      // Revert on failure
      setAllDeployments((prev) =>
        prev.map((d) => d.deploymentId === deploymentId ? { ...d, blacklisted: currentBlacklisted } : d),
      )
    } finally {
      setTogglingBlacklist((prev) => {
        const next = new Set(prev)
        next.delete(deploymentId)
        return next
      })
    }
  }

  async function handleToggleGroupBlacklist(provider: Provider, groupName: string) {
    const currentBlackGroups = provider.blackGroupMatch ?? []
    const isBlacklisted = currentBlackGroups.some(
      (p) => groupName.toLowerCase().includes(p.toLowerCase()),
    )

    let newBlackGroups: string[]
    if (isBlacklisted) {
      // Remove matching patterns
      newBlackGroups = currentBlackGroups.filter(
        (p) => !groupName.toLowerCase().includes(p.toLowerCase()),
      )
    } else {
      // Add exact group name
      newBlackGroups = [...currentBlackGroups, groupName]
    }

    const newBlacklisted = !isBlacklisted

    // Optimistic update: provider blackGroupMatch
    setProviders((prev) =>
      prev.map((p) => p.id === provider.id ? { ...p, blackGroupMatch: newBlackGroups } : p),
    )
    // Optimistic update: all deployments in this group
    setAllDeployments((prev) =>
      prev.map((d) =>
        d.providerId === provider.id && d.groupName === groupName
          ? { ...d, blacklisted: newBlacklisted }
          : d,
      ),
    )

    try {
      await updateProvider(provider.id, {
        type: provider.type,
        apiFormat: provider.apiFormat,
        endpoint: provider.endpoint,
        costMultiplier: provider.costMultiplier,
        syncEnabled: provider.syncEnabled,
        syncIntervalMinutes: provider.syncIntervalMinutes,
        blackGroupMatch: newBlackGroups,
      })
      // Batch blacklist all deployments in this group
      const groupDeployments = allDeployments.filter(
        (d) => d.providerId === provider.id && d.groupName === groupName,
      )
      await Promise.all(
        groupDeployments.map((d) => setDeploymentBlacklist(d.deploymentId, newBlacklisted)),
      )
    } catch {
      // Revert on failure
      setProviders((prev) =>
        prev.map((p) => p.id === provider.id ? { ...p, blackGroupMatch: currentBlackGroups } : p),
      )
      setAllDeployments((prev) =>
        prev.map((d) =>
          d.providerId === provider.id && d.groupName === groupName
            ? { ...d, blacklisted: isBlacklisted }
            : d,
        ),
      )
    }
  }

  function openAdd() {
    setForm(emptyForm)
    setEditingId(null)
    setModalOpen(true)
  }

  function openEdit(provider: Provider) {
    setForm({
      id: provider.id,
      type: provider.type,
      apiFormat: provider.apiFormat ?? 'openai',
      endpoint: provider.endpoint,
      apiKey: '',
      costMultiplier: String(provider.costMultiplier ?? 1),
      newapiUserId: String(provider.newApiUserId ?? ''),
      accessToken: provider.accessToken ?? '',
      blackGroupMatch: (provider.blackGroupMatch ?? []).join(', '),
      syncEnabled: provider.syncEnabled ?? true,
      syncIntervalMinutes: provider.syncIntervalMinutes ?? 60,
    })
    setEditingId(provider.id)
    setModalOpen(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const normalizedEndpoint = form.endpoint.replace(/\/+$/, '')
    if (normalizedEndpoint.endsWith('/v1')) {
      const ok = window.confirm(
        '你配置的 Endpoint 以 /v1 结尾，系统同步时会自动追加 /v1（最终请求路径为 .../v1/v1/models）。\n确认继续吗？'
      )
      if (!ok) return
    }
    setSubmitting(true)
    try {
      const payload: Record<string, unknown> = {
        type: form.type,
        apiFormat: form.apiFormat,
        endpoint: form.endpoint,
        costMultiplier: Number.isNaN(parseFloat(form.costMultiplier)) ? 1 : parseFloat(form.costMultiplier),
        syncEnabled: form.syncEnabled,
        syncIntervalMinutes: form.syncIntervalMinutes,
      }
      if (form.apiKey) payload.apiKey = form.apiKey
      if (form.type === 'newapi' && form.newapiUserId) payload.newApiUserId = Number(form.newapiUserId)
      if (form.accessToken) payload.accessToken = form.accessToken
      if (form.blackGroupMatch.trim()) {
        payload.blackGroupMatch = form.blackGroupMatch.split(',').map((s) => s.trim()).filter(Boolean)
      }

      if (editingId) {
        await updateProvider(editingId, payload)
      } else {
        payload.id = form.id
        await createProvider(payload)
      }

      setModalOpen(false)
      await fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save provider')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSync(id: string) {
    setSyncing((prev) => ({ ...prev, [id]: true }))
    setSyncResult(null)
    try {
      const result = await syncProvider(id)
      setSyncResult({ id, message: `Synced: +${result.modelsAdded} added, ${result.modelsUpdated} updated, ${result.modelsRemoved} removed` })
      await fetchData()
    } catch (err) {
      setSyncResult({ id, message: err instanceof Error ? err.message : 'Sync failed' })
    } finally {
      setSyncing((prev) => ({ ...prev, [id]: false }))
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteProvider(id)
      setDeleteConfirm(null)
      await fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete provider')
      setDeleteConfirm(null)
    }
  }

  function formatDate(dateStr?: string | null) {
    if (!dateStr) return 'Never'
    return new Date(dateStr).toLocaleString()
  }

  function updateField<K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  if (loading) {
    return (
      <div className="empty-state">
        <p>Loading providers...</p>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h2>Providers</h2>
        <button className="btn btn-primary" onClick={openAdd}>Add Provider</button>
      </div>

      {error && (
        <div style={{ padding: '0.75rem 1rem', background: 'var(--danger-bg, #2d1b1b)', border: '1px solid var(--danger, #e74c3c)', borderRadius: '8px', marginBottom: '1rem', color: 'var(--danger, #e74c3c)' }}>
          {error}
          <button onClick={() => setError(null)} style={{ float: 'right', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>x</button>
        </div>
      )}

      {providers.length === 0 ? (
        <div className="empty-state">
          <p>No providers configured yet.</p>
          <button className="btn btn-primary" onClick={openAdd}>Add Your First Provider</button>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Name / ID</th>
                <th>Type</th>
                <th>Endpoint</th>
                <th>Models</th>
                <th>Last Sync</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => {
                const isExpanded = expandedProviders.has(p.id)
                const providerDeployments = deploymentsByProvider[p.id] || []
                const modelCount = providerDeployments.length

                return (
                  <ProviderRow
                    key={p.id}
                    provider={p}
                    isExpanded={isExpanded}
                    modelCount={modelCount}
                    deployments={providerDeployments}
                    expandedGroups={expandedGroups}
                    togglingBlacklist={togglingBlacklist}
                    syncing={syncing[p.id] || false}
                    syncResultMessage={syncResult?.id === p.id ? syncResult.message : null}
                    onToggleExpand={() => toggleProvider(p.id)}
                    onToggleGroup={toggleGroup}
                    onToggleDeploymentBlacklist={handleToggleDeploymentBlacklist}
                    onToggleGroupBlacklist={(groupName) => handleToggleGroupBlacklist(p, groupName)}
                    onSync={() => handleSync(p.id)}
                    onEdit={() => openEdit(p)}
                    onDelete={() => setDeleteConfirm(p.id)}
                    formatDate={formatDate}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div className="modal-backdrop" onClick={() => setDeleteConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Provider</h3>
            <p>Are you sure you want to delete provider <strong>{deleteConfirm}</strong>? This will also remove all associated models.</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => handleDelete(deleteConfirm)}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit modal */}
      {modalOpen && (
        <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingId ? 'Edit Provider' : 'Add Provider'}</h3>
            <form onSubmit={handleSubmit}>
              {!editingId && (
                <div className="form-group">
                  <label>ID</label>
                  <input
                    type="text"
                    value={form.id}
                    onChange={(e) => updateField('id', e.target.value)}
                    placeholder="e.g. my-openai-proxy"
                    required
                  />
                </div>
              )}

              <div className="form-group">
                <label>Type</label>
                <select value={form.type} onChange={(e) => updateField('type', e.target.value as ProviderForm['type'])}>
                  <option value="newapi">NewAPI</option>
                  <option value="openai-compatible">OpenAI Compatible</option>
                </select>
              </div>

              <div className="form-group">
                <label>API Format</label>
                <select value={form.apiFormat} onChange={(e) => updateField('apiFormat', e.target.value as ProviderForm['apiFormat'])}>
                  <option value="openai">OpenAI</option>
                  <option value="claude">Claude (Anthropic)</option>
                  <option value="gemini">Gemini (Google)</option>
                </select>
              </div>

              <div className="form-group">
                <label>Endpoint</label>
                <input
                  type="url"
                  value={form.endpoint}
                  onChange={(e) => updateField('endpoint', e.target.value)}
                  placeholder="https://api.example.com"
                  required
                />
              </div>

              {form.type === 'openai-compatible' && (
                <div className="form-group">
                  <label>API Key{editingId ? ' (leave blank to keep current)' : ''}</label>
                  <input
                    type="password"
                    value={form.apiKey}
                    onChange={(e) => updateField('apiKey', e.target.value)}
                    placeholder={editingId ? '********' : 'sk-...'}
                    required={!editingId}
                    autoComplete="off"
                  />
                </div>
              )}

              <div className="form-group">
                <label>Cost Multiplier <span className="tip-icon" data-tip="平台充值1美元话费了多少美元，例如冲50美元顶100 就是0.5">ⓘ</span></label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={form.costMultiplier}
                  onChange={(e) => updateField('costMultiplier', e.target.value)}
                  placeholder="1.00"
                />
              </div>

              {form.type === 'newapi' && (
                <>
                  <div className="form-group">
                    <label>NewAPI User ID <span className="tip-icon" data-tip="在个人设置中头像旁边的 ID">ⓘ</span></label>
                    <input
                      type="text"
                      value={form.newapiUserId}
                      onChange={(e) => updateField('newapiUserId', e.target.value)}
                      placeholder="User ID for NewAPI billing"
                    />
                  </div>
                  <div className="form-group">
                    <label>Access Token <span className="tip-icon" data-tip="个人设置 → 安全设置中的系统访问令牌">ⓘ</span></label>
                    <input
                      type="password"
                      value={form.accessToken}
                      onChange={(e) => updateField('accessToken', e.target.value)}
                      placeholder={editingId ? '(unchanged)' : 'Access token for authentication'}
                      autoComplete="off"
                    />
                  </div>
                </>
              )}

              {form.type === 'newapi' && (
                <div className="form-group">
                  <label>Black Group Match <span className="tip-icon" data-tip="想要添加的分组名称，多个用逗号分隔">ⓘ</span></label>
                  <input
                    type="text"
                    value={form.blackGroupMatch}
                    onChange={(e) => updateField('blackGroupMatch', e.target.value)}
                    placeholder="group1, group2"
                  />
                </div>
              )}

              <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  id="syncEnabled"
                  checked={form.syncEnabled}
                  onChange={(e) => updateField('syncEnabled', e.target.checked)}
                />
                <label htmlFor="syncEnabled" style={{ margin: 0 }}>Sync Enabled</label>
              </div>

              <div className="form-group">
                <label>Sync Interval (minutes)</label>
                <input
                  type="number"
                  min="1"
                  value={form.syncIntervalMinutes}
                  onChange={(e) => updateField('syncIntervalMinutes', parseInt(e.target.value) || 60)}
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setModalOpen(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Saving...' : editingId ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

// --- Sub-components ---

interface ProviderRowProps {
  provider: Provider
  isExpanded: boolean
  modelCount: number
  deployments: ModelDeployment[]
  expandedGroups: Set<string>
  togglingBlacklist: Set<string>
  syncing: boolean
  syncResultMessage: string | null
  onToggleExpand: () => void
  onToggleGroup: (key: string) => void
  onToggleDeploymentBlacklist: (deploymentId: string, currentBlacklisted: boolean) => void
  onToggleGroupBlacklist: (groupName: string) => void
  onSync: () => void
  onEdit: () => void
  onDelete: () => void
  formatDate: (dateStr?: string | null) => string
}

function ProviderRow({
  provider: p, isExpanded, modelCount, deployments, expandedGroups, togglingBlacklist,
  syncing, syncResultMessage,
  onToggleExpand, onToggleGroup, onToggleDeploymentBlacklist, onToggleGroupBlacklist,
  onSync, onEdit, onDelete, formatDate,
}: ProviderRowProps) {
  return (
    <>
      <tr
        onClick={onToggleExpand}
        style={{ cursor: 'pointer', background: isExpanded ? 'var(--bg-hover)' : undefined }}
      >
        <td>
          <span style={{ color: 'var(--accent-blue)', marginRight: 6, fontSize: 11 }}>
            {isExpanded ? '▼' : '▶'}
          </span>
          <strong>{p.id}</strong>
          {p.syncEnabled && <span className="status-dot" style={{ background: '#2ecc71', marginLeft: '0.5rem' }} title="Sync enabled" />}
        </td>
        <td>
          <span className="badge">{p.type}</span>
        </td>
        <td style={{ maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.endpoint}>
          {p.endpoint}
        </td>
        <td>{modelCount}</td>
        <td>{formatDate(p.lastSyncAt)}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn" onClick={onSync} disabled={syncing}>
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
            <button className="btn" onClick={onEdit}>Edit</button>
            <button className="btn btn-danger" onClick={onDelete}>Delete</button>
          </div>
          {syncResultMessage && (
            <div style={{ marginTop: '0.25rem', fontSize: '0.8rem', opacity: 0.8 }}>{syncResultMessage}</div>
          )}
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={6} style={{ padding: 0 }}>
            <div className="provider-panel">
              {deployments.length === 0 ? (
                <div style={{ padding: '1rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                  No models synced yet. Click "Sync Now" to discover models.
                </div>
              ) : p.type === 'newapi' ? (
                <NewAPIPanel
                  provider={p}
                  deployments={deployments}
                  expandedGroups={expandedGroups}
                  togglingBlacklist={togglingBlacklist}
                  onToggleGroup={onToggleGroup}
                  onToggleDeploymentBlacklist={onToggleDeploymentBlacklist}
                  onToggleGroupBlacklist={onToggleGroupBlacklist}
                />
              ) : (
                <DeploymentTable
                  deployments={deployments}
                  togglingBlacklist={togglingBlacklist}
                  onToggleBlacklist={onToggleDeploymentBlacklist}
                />
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

interface DeploymentTableProps {
  deployments: ModelDeployment[]
  togglingBlacklist: Set<string>
  onToggleBlacklist: (deploymentId: string, currentBlacklisted: boolean) => void
}

function DeploymentTable({ deployments, togglingBlacklist, onToggleBlacklist }: DeploymentTableProps) {
  const sorted = [...deployments].sort((a, b) => a.canonical.localeCompare(b.canonical))

  return (
    <table className="deployment-table">
      <thead>
        <tr>
          <th>Model</th>
          <th>Upstream</th>
          <th>Price In</th>
          <th>Price Out</th>
          <th>Source</th>
          <th>Status</th>
          <th style={{ width: 80, textAlign: 'center' }}>Block</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((d) => (
          <tr
            key={d.deploymentId}
            className={d.blacklisted ? 'blacklisted-row' : ''}
          >
            <td><strong>{d.canonical}</strong></td>
            <td style={{ color: 'var(--text-secondary)' }}>{d.upstream}</td>
            <td className="mono">{formatPrice(d.manualPriceInput ?? d.priceInput)}</td>
            <td className="mono">{formatPrice(d.manualPriceOutput ?? d.priceOutput)}</td>
            <td><span className="badge" style={{ fontSize: 10 }}>{d.priceSource}</span></td>
            <td>
              <span className={`badge ${d.status === 'active' ? 'green' : 'yellow'}`} style={{ fontSize: 11 }}>
                {d.status}
              </span>
            </td>
            <td style={{ textAlign: 'center' }}>
              <label className="blacklist-toggle" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={d.blacklisted}
                  disabled={togglingBlacklist.has(d.deploymentId)}
                  onChange={() => onToggleBlacklist(d.deploymentId, d.blacklisted)}
                />
                <span className="blacklist-toggle-slider" />
              </label>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface NewAPIPanelProps {
  provider: Provider
  deployments: ModelDeployment[]
  expandedGroups: Set<string>
  togglingBlacklist: Set<string>
  onToggleGroup: (key: string) => void
  onToggleDeploymentBlacklist: (deploymentId: string, currentBlacklisted: boolean) => void
  onToggleGroupBlacklist: (groupName: string) => void
}

function NewAPIPanel({
  provider, deployments, expandedGroups, togglingBlacklist,
  onToggleGroup, onToggleDeploymentBlacklist, onToggleGroupBlacklist,
}: NewAPIPanelProps) {
  // Group by groupName
  const groups = useMemo(() => {
    const map = new Map<string, ModelDeployment[]>()
    for (const d of deployments) {
      const gn = d.groupName || '(ungrouped)'
      if (!map.has(gn)) map.set(gn, [])
      map.get(gn)!.push(d)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [deployments])

  const blackGroupMatch = provider.blackGroupMatch ?? []

  return (
    <div>
      {groups.map(([groupName, groupDeployments]) => {
        const groupKey = `${provider.id}:${groupName}`
        const isGroupExpanded = expandedGroups.has(groupKey)
        const isGroupBlacklisted = blackGroupMatch.some(
          (pattern) => groupName.toLowerCase().includes(pattern.toLowerCase()),
        )

        return (
          <div key={groupName} className={`group-section ${isGroupBlacklisted ? 'group-blacklisted' : ''}`}>
            <div
              className="group-row"
              onClick={() => onToggleGroup(groupKey)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                <span style={{ color: 'var(--accent-blue)', fontSize: 11 }}>
                  {isGroupExpanded ? '▼' : '▶'}
                </span>
                <strong style={{ textDecoration: isGroupBlacklisted ? 'line-through' : undefined }}>
                  {groupName}
                </strong>
                <span className="badge" style={{ fontSize: 11 }}>
                  {groupDeployments.length} model{groupDeployments.length !== 1 ? 's' : ''}
                </span>
              </div>
              <label
                className="blacklist-toggle"
                onClick={(e) => e.stopPropagation()}
                title={isGroupBlacklisted ? 'Unblock group' : 'Block group'}
              >
                <input
                  type="checkbox"
                  checked={isGroupBlacklisted}
                  onChange={() => onToggleGroupBlacklist(groupName)}
                />
                <span className="blacklist-toggle-slider" />
              </label>
            </div>
            {isGroupExpanded && (
              <div style={{ paddingLeft: 16 }}>
                <DeploymentTable
                  deployments={groupDeployments}
                  togglingBlacklist={togglingBlacklist}
                  onToggleBlacklist={onToggleDeploymentBlacklist}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
