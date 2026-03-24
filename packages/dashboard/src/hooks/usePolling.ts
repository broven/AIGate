import { useState, useEffect, useCallback, useRef } from 'react'

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs = 2000,
): { data: T | null; error: Error | null; loading: boolean; refetch: () => void; mutate: (updater: (prev: T | null) => T | null) => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const versionRef = useRef(0)

  const fetchData = useCallback(async () => {
    const fetchVersion = versionRef.current
    try {
      const result = await fetcher()
      // Only apply if no optimistic mutation happened during this fetch
      if (versionRef.current === fetchVersion) {
        setData(result)
        setError(null)
      }
    } catch (err) {
      if (versionRef.current === fetchVersion) {
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      setLoading(false)
    }
  }, [fetcher])

  useEffect(() => {
    fetchData()
    const timer = setInterval(fetchData, intervalMs)
    return () => clearInterval(timer)
  }, [fetchData, intervalMs])

  const mutate = useCallback((updater: (prev: T | null) => T | null) => {
    versionRef.current++
    setData(updater)
  }, [])

  return { data, error, loading, refetch: fetchData, mutate }
}
