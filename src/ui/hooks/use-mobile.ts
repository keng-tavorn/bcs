import * as React from "react"

import { SIDEBAR_SHEET_BELOW_PX } from "@/lib/constants"

const MOBILE_BREAKPOINT = SIDEBAR_SHEET_BELOW_PX
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

/** Whether the screen is narrower than 1024 px: read from the browser, false while the server draws the page */
export function useIsMobile(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  )
}
