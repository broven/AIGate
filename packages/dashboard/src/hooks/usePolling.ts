import { useState, useEffect, useCallback } from 'react'

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs = 2000,
): { data: T | null; error: Error | null; loading: boolean; refetch: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const result = await fetcher()
      setData(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }, [fetcher])

  useEffect(() => {
    fetchData()
    const timer = setInterval(fetchData, intervalMs)
    return () => clearInterval(timer)
  }, [fetchData, intervalMs])

  return { data, error, loading, refetch: fetchData }
}
