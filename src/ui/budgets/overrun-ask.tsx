'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { describedBy, FieldError, Hint } from '../request-form/controls'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { Textarea } from '../shadcn/textarea'
import { overrunErrorKey, overrunReasonError, type OverrunFailure, type OverrunOutcome } from './overrun-model'

const NO_ANSWER: OverrunFailure = { ok: false, code: 'NO_ANSWER' }

export type SubmitOverrun = (input: { requestId: string; reason: string }, idempotencyKey: string) => Promise<OverrunOutcome<{ overrunId: string; number: string }>>

// "ขออนุมัติเกินงบ" on the request page (S6-16 · FR-BUD-101 · BR-BUD-12): the requester whose budget line is short of the
// request asks for the shortfall with a reason. The button opens a Dialog only when pressed (NG-13), which repeats what
// is short and asks for the reason the approver will read; "ส่งขออนุมัติเกินงบ" sends it with its own idempotency key
// (spec §4.3), and the result comes back in the same words (§9.9 rule 7) — kept after the page refreshes, as the page
// keeps this part for the requester whatever the request's state. A refusal is said inside the Dialog (never a toast
// alone): DOA_NOT_CONFIGURED, NOT_OVER_BUDGET, LINE_NOT_OPEN, OVERRUN_EXISTS. The service checks everything again.
export function OverrunAsk({ requestId, canAsk, shortfall, submit }: { requestId: string; canAsk: boolean; /** "60,000.00" */ shortfall: string | null; submit: SubmitOverrun }) {
  const t = useTranslations('budgetOverrun')
  const router = useRouter()
  const hydrated = useHydrated()
  const id = useId()
  const sendKey = useSubmissionKey()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState<string | null>(null)

  const failureText = (f: OverrunFailure) => t(`errors.${f.code === 'NO_ANSWER' ? 'FAILED' : overrunErrorKey(f)}`, { requestId: f.requestId ?? '-' })

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    const invalid = overrunReasonError(reason, REASON_MAX_LENGTH)
    if (invalid) {
      setReasonError(t(`errors.${invalid}`, { max: REASON_MAX_LENGTH }))
      document.getElementById(`${id}-reason`)?.focus()
      return
    }
    setPending(true)
    setFailure(null)
    try {
      const outcome = await submit({ requestId, reason: reason.trim() }, sendKey.key).catch(() => NO_ANSWER)
      // No answer: the same key goes with a retry, so it is asked at most once
      if (outcome.ok || outcome.code !== 'NO_ANSWER') sendKey.next()
      if (!outcome.ok) {
        if (overrunErrorKey(outcome) === 'REASON') return setReasonError(failureText(outcome))
        return setFailure(failureText(outcome))
      }
      setOpen(false)
      setReason('')
      setSent(t('ask.sent', { number: outcome.number }))
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {sent ? <Notice tone="success">{sent}</Notice> : null}
      {canAsk ? (
        <Button onClick={() => setOpen(true)} disabled={!hydrated} className="self-start">
          {t('ask.button')}
        </Button>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return
          setOpen(next)
          if (!next) {
            setFailure(null)
            setReasonError(null)
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto p-6 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold text-ink">{t('ask.title')}</DialogTitle>
            <DialogDescription className="text-base text-ink-muted">{shortfall ? t('ask.description', { shortfall }) : t('ask.descriptionPlain')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void onSubmit(e)} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-reason`} className="font-medium text-ink">
                {t('ask.reason')}
              </label>
              <Textarea
                id={`${id}-reason`}
                value={reason}
                required
                maxLength={REASON_MAX_LENGTH}
                onChange={(e) => {
                  setReason(e.target.value)
                  setReasonError(null)
                }}
                aria-invalid={reasonError ? true : undefined}
                aria-describedby={describedBy(`${id}-reason`, true, Boolean(reasonError))}
                className="min-h-28 bg-bg text-base md:text-base"
              />
              <Hint id={`${id}-reason`}>{t('ask.reasonHint')}</Hint>
              {reasonError ? <FieldError id={`${id}-reason`}>{reasonError}</FieldError> : null}
            </div>
            {failure ? <Notice tone="danger">{failure}</Notice> : null}
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
                {t('ask.keep')}
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
                {pending ? t('ask.sending') : t('ask.submit')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
