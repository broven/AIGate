import { useState, useEffect } from 'react'
import Login from '../pages/Login'

const TOKEN_KEY = 'aigate_admin_token'

export function getAdminToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setAdminToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearAdminToken() {
  localStorage.removeItem(TOKEN_KEY)
}

async function verifyToken(token: string): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.ok
  } catch {
    return false
  }
}

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'authenticated' | 'unauthenticated'>('loading')

  useEffect(() => {
    const token = getAdminToken()
    if (!token) {
      setState('unauthenticated')
      return
    }
    verifyToken(token).then((valid) => {
      if (valid) {
        setState('authenticated')
      } else {
        clearAdminToken()
        setState('unauthenticated')
      }
    })
  }, [])

  const handleLogin = async (token: string): Promise<boolean> => {
    const valid = await verifyToken(token)
    if (valid) {
      setAdminToken(token)
      setState('authenticated')
      return true
    }
    return false
  }

  if (state === 'loading') {
    return (
      <div className="login-container">
        <div className="login-card">
          <p style={{ color: 'var(--text-secondary)' }}>Verifying...</p>
        </div>
      </div>
    )
  }

  if (state === 'unauthenticated') {
    return <Login onLogin={handleLogin} />
  }

  return <>{children}</>
}
