'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { repeatErrorKey, type RepeatOutcome } from '../../request-view/repeat-rules'
import { NO_ANSWER, type ActionFailure } from '../../tasks/outcome'
import { Button } from '../button'
import { useLiff } from '../liff-provider'
import { LiffNotice } from '../notice'
import { useRequestKey } from './key'

// "ขอซ้ำ" on a request's LIFF page (S6-12 · FR-INT-101 AC1, BR-FORM-07): the requester asks again for what they asked
// before, as on the web (src/ui/request-view/repeat-actions.tsx) — a new draft of theirs with the lines and answers the
// current form still asks, made on the LIFF channel with one POST (the LIFF page's server action, this button's
// idempotency key: a double tap makes one draft), once the LIFF session is renewed when due; then the draft's form
// opens. The page shows it to the requester only, once the request was sent; the service checks both again, and a
// refusal is said in words under the button. LIFF's own light parts only (ADR-052).

export function LiffReorder({
  requestId,
  draftBase,
  reorder,
}: {
  readonly requestId: string
  /** The LIFF requests' path (/liff/requests): a draft's form is <draftBase>/<id>/edit */
  readonly draftBase: string
  readonly reorder: (requestId: string, idempotencyKey: string) => Promise<RepeatOutcome>
}) {
  const t = useTranslations('requestView.actions')
  const tErrors = useTranslations('requestView.errors')
  const tl = useTranslations('liffRequests.view')
  const router = useRouter()
  const liff = useLiff()
  const submission = useRequestKey()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<ActionFailure | null>(null)

  async function onReorder() {
    setPending(true)
    setFailure(null)
    let result: RepeatOutcome
    try {
      const session = await liff.ensureSession()
      if (!session.ok && session.final) {
        if (session.reason === 'TOKEN_INVALID' && liff.reloadForNewToken()) return
        result = { ok: false, code: 'UNAUTHENTICATED' }
      } else {
        result = await reorder(requestId, submission.key)
        submission.next()
      }
    } catch {
      // No answer: the key stays, so pressing again is the same request for a draft, made once (spec §4.3)
      result = NO_ANSWER
    }
    // Made: the button stays busy while the draft's form opens
    if (result.ok) return router.push(`${draftBase}/${encodeURIComponent(result.requestId)}/edit`)
    setPending(false)
    setFailure(result)
  }

  // A session that has ended in LIFF's words: LIFF has no sign-in page of its own (not the web's "sign in again")
  const failed = failure
    ? failure.code === 'UNAUTHENTICATED'
      ? tl('sessionEnded')
      : tErrors(repeatErrorKey(failure), { available: '-', shortfall: '-', rule: failure.rule ?? '-', requestId: failure.requestId ?? '-' })
    : null
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-muted">{t('reorderHint')}</p>
      {failed ? <LiffNotice tone="danger">{failed}</LiffNotice> : null}
      <Button type="button" variant="secondary" className="self-start" disabled={pending} onClick={() => void onReorder()}>
        {pending ? t('repeatWorking') : t('reorder')}
      </Button>
    </div>
  )
}
