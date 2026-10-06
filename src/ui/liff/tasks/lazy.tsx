'use client'

import { lazy } from 'react'
import type { LiffTaskDecisionProps } from './decision'
import type { LiffPolicyDecisionProps } from './policy-decision'

// The decision forms of a LIFF task page, each in a script file of its own, loaded only by the page that shows it (§9.4:
// a LIFF page's first JavaScript is at most 200 KB gzip with the LINE SDK): a request, PO or variance task never carries
// the policy form with its boundary tick, and a DOA version or an authority change never carries the request form.
// No Suspense boundary around them, as next/dynamic does with ssr: the server waits for the form and sends the page's
// HTML whole — the form included, with its PIN fields and buttons off until the page's script runs (NFR-SEC-09,
// src/ui/form/hydrated.ts) — and the browser hydrates the page once the form's file has come.

const TaskDecision = lazy(() => import('./decision').then((m) => ({ default: m.LiffTaskDecision })))
const PolicyDecision = lazy(() => import('./policy-decision').then((m) => ({ default: m.LiffPolicyDecision })))

/** The decision of a request, purchase-order or variance task (./decision.tsx) */
export function LiffTaskDecisionLoader(props: LiffTaskDecisionProps) {
  return <TaskDecision {...props} />
}

/** The decision of a DOA version or an authority change (./policy-decision.tsx) */
export function LiffPolicyDecisionLoader(props: LiffPolicyDecisionProps) {
  return <PolicyDecision {...props} />
}
