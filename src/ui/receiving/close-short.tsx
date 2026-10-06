'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { ConfirmBox, TextArea } from '../request-view/text-area'
import { ApproverText } from './approver-text'
import { receivingErrorKey, receivingErrorValues, type CloseShortOutcome, type ReceivingFailure } from './outcome'
import type { CloseShortPlanView } from './types'

// PROCUREMENT closes a PO although goods are still to come (po.close_short, FR-P2P-010 AC2, GC-GR-04, BR-GR-04): what
// will be given up line by line, the budget that goes back once approved — at most, since goods that still come before
// the approval are received and not given up (NEW-32) — who approves (GR_VARIANCE), then a reason and a tick, because an
// approved close-short cannot be undone (§9.9). Behind a disclosure, apart from receiving, with a danger-outlined button
// that never looks like the main action. The service checks po.close and the PO again.

const REASON_MIN = 3

export function CloseShort({
  poId,
  plan,
  close,
}: {
  poId: string
  /** null when the PO cannot be closed short now (nothing to come, or a request already waits); the page keeps this
   * component in place anyway, so the confirmation stays after the page refreshes */
  plan: CloseShortPlanView | null
  close: (input: { poId: string; reason: string; confirmed: boolean }, idempotencyKey: string) => Promise<CloseShortOutcome>
}) {
  const t = useTranslations('receiving.closeShort')
  const tErrors = useTranslations('receiving.errors')
  const locale = useLocale()
  const id = useId()
  const submission = useSubmissionKey()
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; confirm?: string }>({})
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<ReceivingFailure | null>(null)
  const [done, setDone] = useState<number | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = tErrors('REASON')
    if (!confirmed) next.confirm = tErrors('CONFIRM')
    setErrors(next)
    if (next.reason || next.confirm) return
    setPending(true)
    setFailure(null)
    let outcome: CloseShortOutcome
    try {
      outcome = await close({ poId, reason: reason.trim(), confirmed }, submission.key)
      submission.next()
    } catch {
      outcome = { ok: false, code: 'FAILED' }
    }
    setPending(false)
    if (outcome.ok) setDone(outcome.lines)
    else setFailure(outcome)
  }

  if (done !== null) return <Notice tone="success">{t('done', { count: done })}</Notice>
  if (!plan) return null
  return (
    <details className="border-t border-line pt-4">
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-danger underline underline-offset-4 hover:no-underline">{t('title')}</summary>
      <form onSubmit={onSubmit} noValidate className="mt-3 flex flex-col gap-4">
        <p className="text-ink-muted">{t('hint')}</p>
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold text-ink">{t('linesTitle')}</h3>
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {plan.lines.map((l, i) => (
              <li key={l.poLineId} className="flex flex-col gap-0.5 py-2">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="break-words text-ink">{t('line', { description: l.description, quantity: l.quantity, uom: l.uom })}</span>
                  <span className="money shrink-0 text-ink">{l.amount}</span>
                </span>
                {plan.approvers[i] ? <ApproverText approver={plan.approvers[i]} locale={locale} /> : null}
              </li>
            ))}
          </ul>
          <p className="flex items-baseline justify-between gap-3 font-semibold text-ink">
            <span>{t('total')}</span>
            <span className="money">{t('baht', { amount: plan.total })}</span>
          </p>
        </div>
        {failure ? <Notice tone="danger">{tErrors(receivingErrorKey(failure), receivingErrorValues(failure))}</Notice> : null}
        <TextArea
          id={`${id}-reason`}
          label={t('reasonLabel')}
          hint={t('reasonHint')}
          value={reason}
          maxLength={REASON_MAX_LENGTH}
          onChange={(event) => {
            setReason(event.currentTarget.value)
            setErrors((e) => ({ ...e, reason: undefined }))
          }}
          error={errors.reason}
          required
        />
        <ConfirmBox
          id={`${id}-confirm`}
          label={t('confirmLabel')}
          checked={confirmed}
          onChange={(checked) => {
            setConfirmed(checked)
            setErrors((e) => ({ ...e, confirm: undefined }))
          }}
          error={errors.confirm}
        />
        <Button type="submit" variant="danger" disabled={pending} className="self-start">
          {pending ? t('working') : t('submit')}
        </Button>
      </form>
    </details>
  )
}
