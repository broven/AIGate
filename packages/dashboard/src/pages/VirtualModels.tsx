import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  getVirtualModels,
  createVirtualModel,
  updateVirtualModel,
  deleteVirtualModel,
  getModels,
  type VirtualModel,
  type ModelDeployment,
} from '../lib/api'
import { usePolling } from '../hooks/usePolling'
import { displayName } from '../lib/model-utils'

interface EntryDraft {
  canonical: string
  disabledDeployments: Set<string>
}

function cardStyle() {
  return {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
  } as const
}

export default function VirtualModels() {
  const fetchVirtualModels = useCallback(() => getVirtualModels(), [])
  const {
    data: virtualModels,
    error,
    loading,
    refetch,
  } = usePolling(fetchVirtualModels, 30000)

  const [deployments, setDeployments] = useState<ModelDeployment[] | null>(null)
  useEffect(() => {
    getModels().then(setDeployments).catch(() => {})
  }, [])

  const canonicalList = useMemo(() => {
    if (!deployments) return []
    const canonicals = new Set(
      deployments
        .filter((deployment) => deployment.status === 'active')
        .map((deployment) => deployment.canonical),
    )
    return [...canonicals].sort()
  }, [deployments])

  const deploymentsByCanonical = useMemo(() => {
    if (!deployments) return new Map<string, ModelDeployment[]>()
    const map = new Map<string, ModelDeployment[]>()
    for (const deployment of deployments) {
      if (deployment.status !== 'active') continue
      const rows = map.get(deployment.canonical) || []
      rows.push(deployment)
      map.set(deployment.canonical, rows)
    }
    return map
  }, [deployments])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editEntries, setEditEntries] = useState<EntryDraft[]>([])
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  function startCreate() {
    setEditingId('new')
    setEditName('')
    setEditDescription('')
    setEditEntries([])
    setExpandedEntries(new Set())
    setSaveError(null)
  }

  function startEdit(virtualModel: VirtualModel) {
    setEditingId(virtualModel.id)
    setEditName(virtualModel.name)
    setEditDescription(virtualModel.description)
    setEditEntries(
      virtualModel.entries.map((entry) => {
        const validIds = new Set(
          (deploymentsByCanonical.get(entry.canonical) || []).map((deployment) => deployment.deploymentId),
        )
        return {
          canonical: entry.canonical,
          disabledDeployments: new Set(entry.disabledDeployments.filter((id) => validIds.has(id))),
        }
      }),
    )
    setExpandedEntries(new Set())
    setSaveError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setSaveError(null)
  }

  function addModel(canonical: string) {
    if (!canonical) return
    setEditEntries((previous) => [...previous, { canonical, disabledDeployments: new Set() }])
  }

  function removeEntry(index: number) {
    setEditEntries((previous) => previous.filter((_, entryIndex) => entryIndex !== index))
  }

  function moveEntry(index: number, direction: -1 | 1) {
    setEditEntries((previous) => {
      const next = [...previous]
      const target = index + direction
      if (target < 0 || target >= next.length) return previous
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function toggleDeployment(entryIndex: number, deploymentId: string) {
    setEditEntries((previous) => {
      const next = [...previous]
      const current = next[entryIndex]
      if (!current) return previous
      const entry = {
        ...current,
        disabledDeployments: new Set(current.disabledDeployments),
      }
      if (entry.disabledDeployments.has(deploymentId)) {
        entry.disabledDeployments.delete(deploymentId)
      } else {
        entry.disabledDeployments.add(deploymentId)
      }
      next[entryIndex] = entry
      return next
    })
  }

  function toggleExpandEntry(index: number) {
    setExpandedEntries((previous) => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  async function handleSave() {
    if (!editName.trim()) {
      setSaveError('Name is required')
      return
    }
    if (editEntries.length === 0) {
      setSaveError('Add at least one model')
      return
    }

    setSaving(true)
    setSaveError(null)

    const payload = {
      name: editName.trim(),
      description: editDescription.trim(),
      entries: editEntries.map((entry, index) => ({
        canonical: entry.canonical,
        priority: index,
        disabledDeployments: [...entry.disabledDeployments],
      })),
    }

    try {
      if (editingId === 'new') {
        await createVirtualModel(payload)
      } else if (editingId) {
        await updateVirtualModel(editingId, payload)
      }
      setEditingId(null)
      await refetch()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this virtual model?')) return
    setDeleting(id)
    try {
      await deleteVirtualModel(id)
      await refetch()
    } finally {
      setDeleting(null)
    }
  }

  function effectivePrice(deployment: ModelDeployment): { input: number | null; output: number | null } {
    return {
      input: deployment.manualPriceInput ?? deployment.priceInput,
      output: deployment.manualPriceOutput ?? deployment.priceOutput,
    }
  }

  // Add Model searchable dropdown state
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [addModelSearch, setAddModelSearch] = useState('')
  const addModelRef = useRef<HTMLDivElement>(null)

  const filteredCanonicals = useMemo(() => {
    if (!addModelSearch) return canonicalList
    const q = addModelSearch.toLowerCase()
    return canonicalList.filter((c) => c.toLowerCase().includes(q) || displayName(c).toLowerCase().includes(q))
  }, [canonicalList, addModelSearch])

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (addModelRef.current && !addModelRef.current.contains(e.target as Node)) {
        setAddModelOpen(false)
      }
    }
    if (addModelOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [addModelOpen])

  if (loading && !virtualModels) {
    return (
      <div>
        <h1 className="page-title">Virtual Models</h1>
        <div className="empty-state"><p>Loading...</p></div>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <h1 className="page-title">Virtual Models</h1>
        <div className="toast error" style={{ position: 'static', marginBottom: 16 }}>{error.message}</div>
      </div>
    )
  }

  if (editingId !== null) {
    return (
      <div>
        <h1 className="page-title">{editingId === 'new' ? 'Create Virtual Model' : 'Edit Virtual Model'}</h1>

        <div style={{ ...cardStyle(), padding: 20, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, color: 'var(--text-secondary)' }}>Name</label>
              <input
                type="text"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                placeholder="my-smart-model"
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                Clients use: <code>virtual:{editName || 'name'}</code>
              </span>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, color: 'var(--text-secondary)' }}>Description</label>
              <input
                type="text"
                value={editDescription}
                onChange={(event) => setEditDescription(event.target.value)}
                placeholder="Optional description"
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                }}
              />
            </div>
          </div>

          <label style={{ display: 'block', marginBottom: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
            Model Chain (tried in order, top to bottom)
          </label>

          {editEntries.map((entry, index) => {
            const entryDeployments = deploymentsByCanonical.get(entry.canonical) || []
            const isExpanded = expandedEntries.has(index)
            const enabledCount = entryDeployments.filter(
              (deployment) => !entry.disabledDeployments.has(deployment.deploymentId),
            ).length

            return (
              <div key={`${entry.canonical}-${index}`} style={{ marginBottom: 12 }}>
                {index > 0 && (
                  <div style={{ margin: '0 0 8px 16px', color: 'var(--text-muted)', fontSize: 14 }}>↓</div>
                )}
                <div style={cardStyle()}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '12px 14px',
                      cursor: 'pointer',
                    }}
                    onClick={() => toggleExpandEntry(index)}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <button
                        className="btn"
                        style={{ padding: '0 4px', fontSize: 10, lineHeight: 1 }}
                        onClick={(event) => {
                          event.stopPropagation()
                          moveEntry(index, -1)
                        }}
                        disabled={index === 0}
                      >
                        ▲
                      </button>
                      <button
                        className="btn"
                        style={{ padding: '0 4px', fontSize: 10, lineHeight: 1 }}
                        onClick={(event) => {
                          event.stopPropagation()
                          moveEntry(index, 1)
                        }}
                        disabled={index === editEntries.length - 1}
                      >
                        ▼
                      </button>
                    </div>
                    <span style={{ color: 'var(--accent-blue)', fontSize: 11 }}>{isExpanded ? '▼' : '▶'}</span>
                    <strong style={{ flex: 1 }}>{displayName(entry.canonical)}</strong>
                    <span className="badge blue" style={{ fontSize: 11 }}>{enabledCount}/{entryDeployments.length} deployments</span>
                    <button
                      className="btn"
                      style={{ padding: '2px 8px', fontSize: 11, color: 'var(--accent-red)' }}
                      onClick={(event) => {
                        event.stopPropagation()
                        removeEntry(index)
                      }}
                    >
                      Remove
                    </button>
                  </div>

                  {isExpanded && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px 8px 44px' }}>
                      {entryDeployments.length === 0 ? (
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No active deployments</span>
                      ) : entryDeployments.map((deployment) => {
                        const enabled = !entry.disabledDeployments.has(deployment.deploymentId)
                        const price = effectivePrice(deployment)
                        return (
                          <div
                            key={deployment.deploymentId}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '6px 0',
                              opacity: enabled ? 1 : 0.4,
                            }}
                          >
                            <span className="badge" style={{ fontSize: 10 }}>
                              {deployment.providerId}{deployment.groupName ? `-${deployment.groupName}` : ''}
                            </span>
                            <span style={{ color: 'var(--text-secondary)', fontSize: 12, flex: 1 }}>{deployment.upstream}</span>
                            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                              {price.input !== null ? `$${price.input.toFixed(2)}` : '—'}
                              {' / '}
                              {price.output !== null ? `$${price.output.toFixed(2)}` : '—'}
                            </span>
                            <label className="blacklist-toggle toggle-enable" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={enabled}
                                onChange={() => toggleDeployment(index, deployment.deploymentId)}
                              />
                              <span className="blacklist-toggle-slider" />
                            </label>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          <div className="multi-select" ref={addModelRef} style={{ position: 'relative', marginTop: 12, display: 'inline-block' }}>
            <button className="btn" onClick={() => { setAddModelOpen(!addModelOpen); if (!addModelOpen) setAddModelSearch('') }}>
              + Add Model...
            </button>
            {addModelOpen && (
              <div className="multi-select-popover multi-select-popover--models" style={{ left: 0, top: '100%', marginTop: 4 }}>
                <div className="multi-select-sticky">
                  <input
                    type="text"
                    className="multi-select-search"
                    placeholder="Search models..."
                    value={addModelSearch}
                    onChange={(e) => setAddModelSearch(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="multi-select-list">
                  {filteredCanonicals.map((canonical) => (
                    <div
                      key={canonical}
                      className="multi-select-item"
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        addModel(canonical)
                        setAddModelOpen(false)
                        setAddModelSearch('')
                      }}
                    >
                      <span>{displayName(canonical)}</span>
                      {canonical !== displayName(canonical) && (
                        <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 'auto' }}>{canonical}</span>
                      )}
                    </div>
                  ))}
                  {filteredCanonicals.length === 0 && (
                    <div style={{ padding: '8px', color: 'var(--text-muted)', fontSize: 13 }}>No models match</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {saveError && (
            <div className="toast error" style={{ position: 'static', marginTop: 12 }}>{saveError}</div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn" onClick={cancelEdit} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="section-header" style={{ marginBottom: 16 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Virtual Models</h1>
        <button className="btn btn-primary" onClick={startCreate}>Create Virtual Model</button>
      </div>

      {(!virtualModels || virtualModels.length === 0) ? (
        <div className="empty-state">
          <h3>No virtual models yet</h3>
          <p>Create a virtual model to define custom fallback chains across different models.</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>
            Clients use <code>virtual:name</code> as the model identifier.
          </p>
          <button className="btn btn-primary" onClick={startCreate} style={{ marginTop: 12 }}>
            Create Virtual Model
          </button>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Model Chain</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {virtualModels.map((virtualModel) => (
                <tr key={virtualModel.id}>
                  <td>
                    <code style={{ color: 'var(--accent-blue)' }}>virtual:{virtualModel.name}</code>
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>{virtualModel.description || '—'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                      {virtualModel.entries.map((entry, index) => (
                        <span key={`${entry.id}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {index > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>→</span>}
                          <span className="badge blue" style={{ fontSize: 11 }}>{displayName(entry.canonical)}</span>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        className="btn"
                        style={{ padding: '2px 8px', fontSize: 11 }}
                        onClick={() => startEdit(virtualModel)}
                      >
                        Edit
                      </button>
                      <button
                        className="btn"
                        style={{ padding: '2px 8px', fontSize: 11, color: 'var(--accent-red)' }}
                        onClick={() => handleDelete(virtualModel.id)}
                        disabled={deleting === virtualModel.id}
                      >
                        {deleting === virtualModel.id ? '...' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
