'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { NO_ANSWER, requestErrorKey, type ActionOutcome } from '../../tasks/outcome'
import { Button } from '../button'
import { useLiff } from '../liff-provider'
import { LiffNotice } from '../notice'
import { checkboxClass, describedBy, textareaClass } from './classes'
import { useRequestKey } from './key'
import { LiffFieldError, LiffLabelled } from './labelled'

// The form behind "ยกเลิกคำขอ" on a request's LIFF page (./cancel.tsx): the same reason (at least 3 characters), tick and
// words as the workspace's (src/ui/request-view/requester-actions.tsx CancelRequest), sent with the LIFF page's own
// action once the LIFF session is renewed when due. A refusal says what happened in the words of the request page.

const REASON_MIN = 3

export function LiffCancelForm({
  requestId,
  cancel,
  onDone,
}: {
  readonly requestId: string
  readonly cancel: (input: { requestId: string; reason: string }, idempotencyKey: string) => Promise<ActionOutcome>
  /** Cancelled: the disclosure shows the confirmation, which stays after the page refreshes */
  readonly onDone: () => void
}) {
  const t = useTranslations('requestView.actions')
  const tErrors = useTranslations('requestView.errors')
  const router = useRouter()
  const liff = useLiff()
  const submission = useRequestKey()
  const id = useId()
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; confirm?: string }>({})
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = tErrors('REASON')
    if (!confirmed) next.confirm = tErrors('CONFIRM')
    setErrors(next)
    if (next.reason || next.confirm) return
    setPending(true)
    setOutcome(null)
    let result: ActionOutcome
    try {
      const session = await liff.ensureSession()
      if (!session.ok && session.final) {
        if (session.reason === 'TOKEN_INVALID' && liff.reloadForNewToken()) return
        result = { ok: false, code: 'UNAUTHENTICATED' }
      } else {
        result = await cancel({ requestId, reason: reason.trim() }, submission.key)
        submission.next()
      }
    } catch {
      // No answer: the key stays, so pressing again is the same cancellation, done once (spec §4.3)
      result = NO_ANSWER
    }
    setPending(false)
    setOutcome(result)
    if (result.ok) {
      onDone()
      router.refresh()
    }
  }

  const failed = outcome && !outcome.ok ? tErrors(requestErrorKey(outcome), { available: '-', shortfall: '-', rule: outcome.rule ?? '-', requestId: outcome.requestId ?? '-' }) : null
  return (
    <form onSubmit={onSubmit} noValidate className="mt-3 flex flex-col gap-4">
      <p className="text-ink-muted">{t('cancelHint')}</p>
      {failed ? <LiffNotice tone="danger">{failed}</LiffNotice> : null}
      <LiffLabelled id={`${id}-reason`} label={t('cancelReason')} error={errors.reason}>
        <textarea
          id={`${id}-reason`}
          name="reason"
          className={textareaClass}
          value={reason}
          maxLength={REASON_MAX_LENGTH}
          required
          aria-required
          aria-invalid={errors.reason ? true : undefined}
          aria-describedby={describedBy(`${id}-reason`, false, Boolean(errors.reason))}
          onChange={(e) => {
            setReason(e.currentTarget.value)
            setErrors((x) => ({ ...x, reason: undefined }))
          }}
        />
      </LiffLabelled>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-confirm`} className="flex min-h-11 items-center gap-3">
          <input
            id={`${id}-confirm`}
            type="checkbox"
            className={checkboxClass}
            checked={confirmed}
            aria-invalid={errors.confirm ? true : undefined}
            aria-describedby={describedBy(`${id}-confirm`, false, Boolean(errors.confirm))}
            onChange={(e) => {
              setConfirmed(e.currentTarget.checked)
              setErrors((x) => ({ ...x, confirm: undefined }))
            }}
          />
          <span>{t('cancelConfirm')}</span>
        </label>
        {errors.confirm ? <LiffFieldError id={`${id}-confirm`}>{errors.confirm}</LiffFieldError> : null}
      </div>
      <Button type="submit" variant="danger" disabled={pending} className="self-start">
        {pending ? t('working') : t('cancelSubmit')}
      </Button>
    </form>
  )
}
