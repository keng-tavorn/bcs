'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useSubmissionKey } from '../form/submission-key'
import type { ActionFailure } from './outcome'

/** What a form shows when no answer came back: the network failed, or the server stopped before answering */
export const NO_ANSWER: ActionFailure = { ok: false, code: 'NO_ANSWER' }

/**
 * Runs one server action with this form's submission key (spec §4.3: a resend of the same submission runs once). A new
 * key follows every answer; when no answer came back the key stays, so trying again is the same submission and runs at
 * most once (src/ui/form/submission-key.ts), and the form says what happened instead of nothing (§9.9 rule 7).
 * `done` refreshes the page so lists show what changed.
 */
export function useAction() {
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  async function run<T extends { readonly ok: true } | ActionFailure>(call: (idempotencyKey: string) => Promise<T>): Promise<T | ActionFailure> {
    setPending(true)
    try {
      const answer = await call(submission.key)
      submission.next()
      return answer
    } catch {
      return NO_ANSWER
    } finally {
      setPending(false)
    }
  }
  return { pending, run, done: () => router.refresh() }
}

/** Values every error message of the admin namespaces may use */
export function errorValues(failure: ActionFailure): { requestId: string; rules: string; rule: string; code: string; version: string } {
  return {
    requestId: failure.requestId ?? '-',
    rules: (failure.rules ?? []).join(', '),
    rule: failure.rule ?? '',
    code: failure.doaCode ?? '',
    version: String(failure.versionNo ?? ''),
  }
}
