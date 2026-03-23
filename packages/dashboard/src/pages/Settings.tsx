import { useState } from 'react'

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
  const gatewayUrl = 'http://localhost:3000'
  const version: string = (globalThis as any).__APP_VERSION__ ?? 'dev'

  return (
    <div>
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
    </div>
  )
}
