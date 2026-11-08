'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useSubmissionKey } from '../form/submission-key'
import type { RiskAdminOutcome } from './model'
import { useSay } from './say'

// The two hooks every risk admin panel uses (S11-04): one command with the panel's submission key (a new key after each
// answer · spec §4.3; the page refreshes on success), and a refusal in words — its reason when the screen knows it, else
// its code (§9.9 rule 7).

export function useRun() {
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  async function run(call: (key: string) => Promise<RiskAdminOutcome>): Promise<RiskAdminOutcome> {
    setPending(true)
    let outcome: RiskAdminOutcome
    try {
      outcome = await call(submission.key)
      submission.next()
    } catch {
      outcome = { ok: false, code: 'NO_ANSWER' }
    }
    setPending(false)
    if (outcome.ok) router.refresh()
    return outcome
  }
  return { pending, run }
}

export function useFailureText() {
  const t = useSay('risk.admin.errors')
  return (o: RiskAdminOutcome) => {
    if (o.ok) return ''
    const key = o.reason && t.has(`reason.${o.reason}`) ? `reason.${o.reason}` : t.has(`code.${o.code}`) ? `code.${o.code}` : 'code.FAILED'
    return t(key)
  }
}
