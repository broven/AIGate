import React from 'react'

interface Attempt {
  provider: string
  status: 'success' | 'failed' | 'skipped_cooldown'
  error?: string
  latencyMs?: number
}

export function FallbackChain({ attempts }: { attempts: Attempt[] }) {
  if (!attempts || attempts.length === 0) return <span className="mono" style={{ color: 'var(--text-muted)' }}>—</span>

  return (
    <div className="fallback-chain">
      {attempts.map((attempt, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="arrow">→</span>}
          <span
            className={`attempt ${attempt.status}`}
            title={attempt.error || (attempt.latencyMs ? `${attempt.latencyMs}ms` : undefined)}
          >
            {attempt.provider}
            {attempt.status === 'success' && ' ✓'}
          </span>
        </React.Fragment>
      ))}
    </div>
  )
}
