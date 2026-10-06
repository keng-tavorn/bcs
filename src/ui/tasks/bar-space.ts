'use client'

import { useCallback } from 'react'

// On phones the decision bar of /tasks/[id] is fixed to the bottom of the screen (§9.9 principle 5), and it grows with
// what it says: the PIN field and its message, a refusal (a locked PIN with its time, the way to set a PIN), the tick of
// a boundary table. The page keeps that much room at its end, so its last lines — the timeline — can always be scrolled
// above the bar: the bar's own height, measured whenever it changes, in the CSS variable BAR_SPACE_VAR on the document,
// which the page's bottom padding reads (with a fallback for the first paint). On wide screens the bar is in the page
// flow and the variable is not set. It goes when the bar goes.

/** The CSS variable with the height of the fixed decision bar (src/app/(workspace)/tasks/[id]/page.tsx reads it) */
export const BAR_SPACE_VAR = '--task-bar-space'

/** A ref for the decision bar: while the bar is fixed to the bottom, its height is the page's room at its end */
export function useBarSpace<T extends HTMLElement>() {
  return useCallback((bar: T | null) => {
    if (!bar) return
    const root = document.documentElement.style
    const measure = () => {
      if (getComputedStyle(bar).position === 'fixed') root.setProperty(BAR_SPACE_VAR, `${Math.ceil(bar.getBoundingClientRect().height)}px`)
      else root.removeProperty(BAR_SPACE_VAR)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    // Turning a phone, or a window crossing the wide-screen width, moves the bar in or out of the page flow
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      root.removeProperty(BAR_SPACE_VAR)
    }
  }, [])
}
