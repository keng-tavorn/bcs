'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { Button } from '../shadcn/button'
import { AWARD_ERROR_KEYS, keyOf, type AwardOutcome } from './award-model'

// The button of an approved award whose winner bid with VAT and confirmed its prices before VAT (S10-11 · OQ-212):
// procurement makes the purchase orders at those prices (award.releasePo). The service checks SOURCING, sourcing.award,
// the state and that every winner confirmed; the page shows the button to procurement only.

export function AwardRelease({ ready, release }: { readonly ready: boolean; readonly release: (key: string) => Promise<AwardOutcome> }) {
  const t = useTranslations('sourcing.award')
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  async function act() {
    setMessage(null)
    setPending(true)
    let outcome: AwardOutcome
    try {
      outcome = await release(submission.key)
      submission.next()
    } catch {
      outcome = { ok: false, code: 'FAILED' }
    }
    setPending(false)
    if (outcome.ok) {
      setMessage({ tone: 'success', text: t('after.released') })
      router.refresh()
    } else setMessage({ tone: 'danger', text: t(`errors.${keyOf(AWARD_ERROR_KEYS, outcome.reason === 'AGREEMENT_OVERLAP' ? 'AGREEMENT_OVERLAP' : outcome.code, 'OTHER')}`) })
  }

  return (
    <div className="flex flex-col gap-2">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Button type="button" className="min-h-11 self-start lg:min-h-10" disabled={!ready || pending} onClick={() => void act()}>
        {t('after.release')}
      </Button>
    </div>
  )
}
