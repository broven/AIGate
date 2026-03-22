import { useState, useEffect, useCallback } from 'react'
import { getKeys, createKey, deleteKey } from '../lib/api'

interface GatewayKey {
  id: string
  name: string
  keyPrefix: string
  createdAt: string
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button className="btn" onClick={handleCopy} style={{ marginLeft: 8 }}>
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

export default function Settings() {
  const [keys, setKeys] = useState<GatewayKey[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showCreatedKey, setShowCreatedKey] = useState<string | null>(null)
  const [newKeyName, setNewKeyName] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const fetchKeys = useCallback(async () => {
    try {
      const data = await getKeys()
      setKeys(data)
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
    try {
      const result = await createKey(newKeyName.trim())
      setShowCreatedKey(result.key)
      setShowCreateModal(false)
      setNewKeyName('')
      await fetchKeys()
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    await deleteKey(id)
    setDeleteConfirmId(null)
    await fetchKeys()
  }

  const gatewayUrl = 'http://localhost:3000'
  const version: string = (globalThis as any).__APP_VERSION__ ?? 'dev'

  return (
    <div>
      {/* API Keys Section */}
      <div className="section">
        <div className="section-header">
          <h2 className="section-title">API Keys</h2>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            Create Key
          </button>
        </div>

        {showCreatedKey && (
          <div style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-warning, #f59e0b)',
            borderRadius: 8,
            padding: 16,
            marginBottom: 16,
          }}>
            <p style={{ marginBottom: 8, fontWeight: 600 }}>
              Save this key — it cannot be retrieved again
            </p>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <code className="mono" style={{
                background: 'var(--color-bg)',
                padding: '8px 12px',
                borderRadius: 4,
                flex: 1,
                wordBreak: 'break-all',
              }}>
                {showCreatedKey}
              </code>
              <CopyButton text={showCreatedKey} />
            </div>
            <button
              className="btn"
              style={{ marginTop: 12 }}
              onClick={() => setShowCreatedKey(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key Prefix</th>
                <th>Created At</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center' }}>Loading...</td>
                </tr>
              ) : keys.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center' }}>No API keys yet</td>
                </tr>
              ) : (
                keys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td><code className="mono">{key.keyPrefix}...</code></td>
                    <td className="mono">{formatDate(key.createdAt)}</td>
                    <td>
                      {deleteConfirmId === key.id ? (
                        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span>Are you sure?</span>
                          <button className="btn btn-danger" onClick={() => handleDelete(key.id)}>
                            Confirm
                          </button>
                          <button className="btn" onClick={() => setDeleteConfirmId(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button className="btn btn-danger" onClick={() => setDeleteConfirmId(key.id)}>
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Gateway Info Section */}
      <div className="section">
        <div className="section-header">
          <h2 className="section-title">Gateway Info</h2>
        </div>

        <div style={{ marginBottom: 24 }}>
          <label style={{ fontWeight: 600, display: 'block', marginBottom: 8 }}>Gateway URL</label>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <code className="mono" style={{
              background: 'var(--color-bg)',
              padding: '8px 12px',
              borderRadius: 4,
            }}>
              {gatewayUrl}
            </code>
            <CopyButton text={gatewayUrl} />
          </div>
        </div>

        <div style={{ marginBottom: 24 }}>
          <label style={{ fontWeight: 600, display: 'block', marginBottom: 8 }}>Quick Setup</label>
          <p style={{ marginBottom: 8, opacity: 0.8 }}>
            Point your AI tools at this URL as the OpenAI API base. Any OpenAI-compatible client will work.
          </p>
        </div>

        <div>
          <label style={{ fontWeight: 600, display: 'block', marginBottom: 8 }}>Example Request</label>
          <pre className="mono" style={{
            background: 'var(--color-bg)',
            padding: 16,
            borderRadius: 8,
            overflow: 'auto',
            fontSize: 13,
            lineHeight: 1.6,
          }}>
{`curl ${gatewayUrl}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
          </pre>
          <CopyButton text={`curl ${gatewayUrl}/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "gpt-4o",\n    "messages": [{"role": "user", "content": "Hello!"}]\n  }'`} />
        </div>

        <div style={{ marginTop: 24 }}>
          <label style={{ fontWeight: 600, display: 'block', marginBottom: 8 }}>Version</label>
          <code className="mono" style={{
            background: 'var(--color-bg)',
            padding: '8px 12px',
            borderRadius: 4,
          }}>
            {version}
          </code>
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
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate()
                }}
              />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
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
