import React, { useState, useRef, useEffect } from 'react'

interface Attempt {
  provider: string
  groupName?: string | null
  status: 'success' | 'failed' | 'skipped_cooldown'
  error?: string
  latencyMs?: number
}

function formatRoute(attempt: Attempt): string {
  return attempt.groupName ? `${attempt.provider}/${attempt.groupName}` : attempt.provider
}

export function FallbackChain({ attempts }: { attempts: Attempt[] }) {
  const [showPopover, setShowPopover] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  if (!attempts || attempts.length === 0) return <span className="mono" style={{ color: 'var(--text-muted)' }}>—</span>

  const final = [...attempts].reverse().find(a => a.status === 'success') || attempts[attempts.length - 1]
  const hasFallbacks = attempts.length > 1

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => hasFallbacks && setShowPopover(true)}
      onMouseLeave={() => setShowPopover(false)}
    >
      <span className={`attempt ${final.status} mono`} style={{ cursor: hasFallbacks ? 'help' : undefined }}>
        {formatRoute(final)}
        {final.status === 'success' && ' ✓'}
        {hasFallbacks && (
          <span style={{ marginLeft: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
            ({attempts.length - 1}↻)
          </span>
        )}
      </span>

      {showPopover && hasFallbacks && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          marginTop: '4px',
          padding: '8px 12px',
          background: 'var(--bg-secondary, #1e1e2e)',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          zIndex: 100,
          whiteSpace: 'nowrap',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          fontSize: '13px',
        }}>
          {attempts.map((attempt, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' }}>
              <span style={{ width: '16px', textAlign: 'right', color: 'var(--text-muted)', fontSize: '11px' }}>{i + 1}</span>
              <span className={`badge ${attempt.status === 'success' ? 'green' : attempt.status === 'failed' ? 'red' : 'yellow'}`}
                style={{ fontSize: '11px', padding: '1px 6px' }}>
                {attempt.status === 'success' ? '✓' : attempt.status === 'failed' ? '✗' : '⏸'}
              </span>
              <span className="mono">{formatRoute(attempt)}</span>
              {attempt.error && (
                <span style={{ color: 'var(--text-muted)', fontSize: '11px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {attempt.error.slice(0, 60)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
