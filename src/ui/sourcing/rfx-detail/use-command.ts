'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, useTransition } from 'react'
import { useSubmissionKey } from '../../form/submission-key'
import { errorKey, type RfxActionOutcome } from './model'

/**
 * One command of the RFx page: the submission's idempotency key (a double click is the same command), pending while it
 * runs, the answer in words next to the form (never a toast alone, §9.9), and the page read again after a success
 */
export function useRfxCommand() {
  const t = useTranslations('sourcing.detail')
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  // until the page read again lands, its forms still hold the RFx's old version: they stay busy meanwhile
  const [refreshing, startRefresh] = useTransition()
  const [message, setMessage] = useState<{ readonly tone: 'success' | 'danger'; readonly text: string } | null>(null)

  async function run(call: (key: string) => Promise<RfxActionOutcome>, done: string): Promise<boolean> {
    setMessage(null)
    setPending(true)
    let outcome: RfxActionOutcome
    try {
      outcome = await call(submission.key)
      submission.next()
    } catch {
      // no answer: the key stays, so pressing again is the same command
      outcome = { ok: false, code: 'OTHER' }
    }
    setPending(false)
    setMessage(outcome.ok ? { tone: 'success', text: done } : { tone: 'danger', text: t(`errors.${errorKey(outcome)}`) })
    if (outcome.ok) startRefresh(() => router.refresh())
    return outcome.ok
  }

  return { pending: pending || refreshing, message, run }
}
