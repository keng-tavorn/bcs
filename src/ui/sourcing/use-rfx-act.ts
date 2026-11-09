'use client'

import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useState } from 'react'
import { useSubmissionKey } from '../form/submission-key'
import { formatDateTime } from '../format'
import { setupErrorKey, type RfxOutcome } from './setup-model'

// One command of the sourcing setup screens at a time (S10-12): the submission's idempotency key (§4.3), the button's
// pending state, and what came back in words — the done sentence, or the refusal's own words (never a toast alone ·
// §9.9). After a command that worked the page is read again, or the caller goes on (a new RFx opens its form).

export interface RfxActMessage {
  readonly tone: 'success' | 'danger'
  readonly text: string
}

export function useRfxAct() {
  const t = useTranslations('sourcing.setup')
  const locale = useLocale()
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<RfxActMessage | null>(null)

  function failureText(o: Extract<RfxOutcome, { ok: false }>): string {
    const key = setupErrorKey(o)
    return key === 'CLOSE_TOO_SOON' && o.earliest ? t('errors.CLOSE_TOO_SOON_AT', { earliest: formatDateTime(locale, o.earliest) }) : t(`errors.${key}`)
  }

  async function act(call: (key: string) => Promise<RfxOutcome>, done: string | null, onOk?: (o: Extract<RfxOutcome, { ok: true }>) => void): Promise<boolean> {
    setMessage(null)
    setPending(true)
    let outcome: RfxOutcome
    try {
      outcome = await call(submission.key)
      submission.next()
    } catch {
      outcome = { ok: false, code: 'OTHER' }
    }
    setPending(false)
    if (!outcome.ok) {
      setMessage({ tone: 'danger', text: failureText(outcome) })
      return false
    }
    if (done) setMessage({ tone: 'success', text: done })
    if (onOk) onOk(outcome)
    else router.refresh()
    return true
  }

  return { act, pending, message, setMessage, router }
}
