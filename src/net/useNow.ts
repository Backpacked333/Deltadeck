// The local time, re-read on an interval, for the shot clocks that count
// down to a server deadline (TurnClock and the six-seat plates). One copy,
// so both clocks tick the same way.
import { useEffect, useState } from 'react'

/** Date.now(), refreshed every `ms` while the caller is mounted. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(timer)
  }, [ms])
  return now
}
