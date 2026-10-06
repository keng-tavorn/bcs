'use client'

import { useEffect, useRef } from 'react'

// The pool reports what was just done in two places — the bar that chooses suppliers and the panel that runs a round.
// A notice belongs to the last thing done: when one of them starts an action it says so, and the other clears its own
// notice, so an old success never stands next to a new result (§9.9 rule 7: the message says what happened).

const EVENT = 'bcs:procurement-pool-action'

/** Tells the other parts of the pool that `source` starts an action */
export function announcePoolAction(source: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: source }))
}

/** Runs `onOther` whenever another part of the pool starts an action */
export function useOtherPoolAction(source: string, onOther: () => void): void {
  const latest = useRef(onOther)
  useEffect(() => {
    latest.current = onOther
  })
  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== source) latest.current()
    }
    window.addEventListener(EVENT, listener)
    return () => window.removeEventListener(EVENT, listener)
  }, [source])
}
