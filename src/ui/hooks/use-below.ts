import { useSyncExternalStore } from 'react'

/** Whether the screen is narrower than `px`: read from the browser, false while the server draws the page */
export function useBelow(px: number): boolean {
  const query = `(max-width: ${px - 1}px)`
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}
