'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useSubmissionKey } from '../form/submission-key'

/**
 * Runs one server action of the procurement screens with this form's submission key (spec §4.3: a resend of the same
 * submission runs once). A new key follows every answer; when no answer came back (the network failed) the key stays,
 * so a retry is the same submission, and the outcome is `noAnswer` — the screen's own "no answer" (PO_NO_ANSWER of
 * ../purchase-order/outcome.ts, POOL_NO_ANSWER of ./outcome.ts), which the form words as not certain rather than as
 * failed (§9.9 rule 7). A success refreshes the page so it shows the new state.
 */
export function useOutcomeAction<O extends { readonly ok: boolean }>(noAnswer: O) {
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<O | null>(null)

  async function run(call: (idempotencyKey: string) => Promise<O>): Promise<O> {
    setPending(true)
    setOutcome(null)
    let result: O
    try {
      result = await call(submission.key)
      submission.next()
    } catch {
      result = noAnswer
    }
    setPending(false)
    setOutcome(result)
    if (result.ok) router.refresh()
    return result
  }

  return { pending, outcome, run, clear: () => setOutcome(null) }
}
