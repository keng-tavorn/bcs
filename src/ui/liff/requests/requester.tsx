'use client'

import { lazy, Suspense, useState, type ReactNode } from 'react'
import { LiffContent } from '../content'
import type { LiffRequesterProps } from './requester-box'

// The requester's own request page in LINE (§9.4 /liff/requests/[id]): the page as the server renders it — its heading
// and the request (`header`, `children`) — in the LIFF content column, plus, once there is something for the requester
// to do (a question to answer, a returned request, a draft), what to do and the main button at the bottom of the screen
// (./requester-box.tsx, FR-INT-009). That part is fetched only then, so the page of a request that simply waits for its
// approver carries none of it (§9.4: the first JavaScript of a LIFF page). Once shown it stays while the page is open, so
// its confirmation in the button's own words remains after the page renders again with the new state (§9.9 rule 7); with
// nothing to do and no confirmation held (the request was cancelled meanwhile, say) it shows nothing. The page renders
// this for every request of the requester, whatever its state, so a render after an action never swaps the tree and the
// confirmations of the parts below (the cancel disclosure) stay too.

const RequesterScreen = lazy(() => import('./requester-box').then((m) => ({ default: m.LiffRequesterScreen })))

export function LiffRequestScreen({
  active,
  header,
  children,
  ...props
}: LiffRequesterProps & {
  /** There is something for the requester to do now */
  readonly active: boolean
  readonly header: ReactNode
  readonly children: ReactNode
}) {
  // Shown since the first time there was something to do (state from an earlier render, React's documented pattern)
  const [shown, setShown] = useState(active)
  if (active && !shown) setShown(true)
  const plain = (
    <LiffContent>
      {header}
      {children}
    </LiffContent>
  )
  if (!shown) return plain
  return (
    <Suspense fallback={plain}>
      <RequesterScreen header={header} {...props}>
        {children}
      </RequesterScreen>
    </Suspense>
  )
}
