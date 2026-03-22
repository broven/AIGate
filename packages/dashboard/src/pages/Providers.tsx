import { useState, useEffect, useCallback } from 'react'
import { getProviders, createProvider, updateProvider, deleteProvider, syncProvider, getModels, type Provider, type ModelDeployment } from '../lib/api'

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

export default function Providers() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [modelCounts, setModelCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ProviderForm>(emptyForm)
  const [submitting, setSubmitting] = useState(false)
  const [syncing, setSyncing] = useState<Record<string, boolean>>({})
  const [syncResult, setSyncResult] = useState<{ id: string; message: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const [providerList, modelList] = await Promise.all([getProviders(), getModels()])
      setProviders(providerList)

      const counts: Record<string, number> = {}
      for (const model of modelList) {
        const pid = model.providerId
        if (pid) {
          counts[pid] = (counts[pid] || 0) + 1
        }
      }
      setModelCounts(counts)
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
    setSubmitting(true)
    try {
      const payload: Record<string, unknown> = {
        type: form.type,
        apiFormat: form.apiFormat,
        endpoint: form.endpoint,
        costMultiplier: parseFloat(form.costMultiplier) || 1,
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
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.id}</strong>
                    {p.syncEnabled && <span className="status-dot" style={{ background: '#2ecc71', marginLeft: '0.5rem' }} title="Sync enabled" />}
                  </td>
                  <td>
                    <span className="badge">{p.type}</span>
                  </td>
                  <td style={{ maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.endpoint}>
                    {p.endpoint}
                  </td>
                  <td>{modelCounts[p.id] ?? 0}</td>
                  <td>{formatDate(p.lastSyncAt)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        className="btn"
                        onClick={() => handleSync(p.id)}
                        disabled={syncing[p.id]}
                      >
                        {syncing[p.id] ? 'Syncing...' : 'Sync Now'}
                      </button>
                      <button className="btn" onClick={() => openEdit(p)}>Edit</button>
                      <button className="btn btn-danger" onClick={() => setDeleteConfirm(p.id)}>Delete</button>
                    </div>
                    {syncResult?.id === p.id && (
                      <div style={{ marginTop: '0.25rem', fontSize: '0.8rem', opacity: 0.8 }}>{syncResult.message}</div>
                    )}
                  </td>
                </tr>
              ))}
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

              {form.type === 'openai-compatible' && (
                <div className="form-group">
                  <label>Access Token (optional override) <span className="tip-icon" data-tip="个人设置 → 安全设置中的系统访问令牌">ⓘ</span></label>
                  <input
                    type="password"
                    value={form.accessToken}
                    onChange={(e) => updateField('accessToken', e.target.value)}
                    placeholder={editingId ? '(unchanged)' : 'Optional'}
                    autoComplete="off"
                  />
                </div>
              )}

              <div className="form-group">
                <label>Black Group Match <span className="tip-icon" data-tip="想要添加的分组名称，多个用逗号分隔">ⓘ</span></label>
                <input
                  type="text"
                  value={form.blackGroupMatch}
                  onChange={(e) => updateField('blackGroupMatch', e.target.value)}
                  placeholder="group1, group2"
                />
              </div>

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
