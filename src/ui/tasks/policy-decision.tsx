'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { ConfirmBox, TextArea } from '../request-view/text-area'
import { StateLine } from '../request-view/status'
import { useAction } from '../request-view/use-action'
import { taskClosed, useClosedTask, useTaskFailureText } from './decision-panel'
import type { ActionOutcome } from './outcome'

// Deciding a DOA version or an authority change (BR-DOA-15, FR-DOA-010 AC2, FR-DOA-002 AC2): approve or reject only,
// and both need the 6-digit code of the authenticator app again — the step-up is granted for this one document and
// used once by the decision. Approve sticks to the bottom on phones; reject is a separate form with a reason and a
// tick, outlined in danger.

const CODE = /^\d{6}$/
const REASON_MIN = 3

export interface PolicyDecisionProps {
  readonly taskId: string
  readonly open: boolean
  readonly locale: string
  readonly decide: (input: { taskId: string; decision: 'APPROVE' | 'REJECT'; reason?: string; code: string }, idempotencyKey: string) => Promise<ActionOutcome>
}

export function PolicyDecision({ taskId, open, locale, decide }: PolicyDecisionProps) {
  const t = useTranslations('tasks.policy')
  const tErrors = useTranslations('tasks.errors')
  const failureText = useTaskFailureText(locale)
  const stale = useClosedTask(locale)
  const id = useId()
  const approving = useAction()
  const rejecting = useAction()
  const [done, setDone] = useState<string | null>(null)
  const [approveCode, setApproveCode] = useState('')
  const [approveError, setApproveError] = useState<string>()
  const [reason, setReason] = useState('')
  const [rejectCode, setRejectCode] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; code?: string; confirm?: string }>({})

  const finished = (text: string) => {
    setDone(text)
    window.scrollTo({ top: 0 })
  }

  async function onApprove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = approveCode.trim()
    if (!CODE.test(code)) return setApproveError(tErrors('CODE'))
    setApproveError(undefined)
    const outcome = await approving.run((key) => decide({ taskId, decision: 'APPROVE', code }, key))
    setApproveCode('')
    if (outcome.ok) finished(t('approved'))
    else stale.check(outcome)
  }

  async function onReject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = rejectCode.trim()
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = tErrors('REASON')
    if (!CODE.test(code)) next.code = tErrors('CODE')
    if (!confirmed) next.confirm = tErrors('CONFIRM')
    setErrors(next)
    if (next.reason || next.code || next.confirm) return
    const outcome = await rejecting.run((key) => decide({ taskId, decision: 'REJECT', reason: reason.trim(), code }, key))
    setRejectCode('')
    if (outcome.ok) finished(t('rejected'))
    else stale.check(outcome)
  }

  /** A failure that belongs next to its form; a closed task is told once, above */
  const failureOf = (outcome: ActionOutcome | null) => (outcome && !outcome.ok && !taskClosed(outcome) ? <Notice tone="danger">{failureText(outcome)}</Notice> : null)

  if (!open && !done && !stale.closed) return null
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4">
      <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
        {t('title')}
      </h2>
      {done ? <Notice tone="success">{done}</Notice> : null}
      {stale.closed ? <Notice tone="danger">{stale.closed}</Notice> : null}
      {open && !stale.closed ? (
        <>
          <StateLine kind="key">{t('stepUpHint')}</StateLine>
          <form
            onSubmit={onApprove}
            noValidate
            className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 border-t border-line bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:static lg:z-auto lg:border-0 lg:bg-transparent lg:p-0"
          >
            {failureOf(approving.outcome)}
            <div className="flex items-end gap-2 lg:flex-col lg:items-stretch">
              <div className="min-w-0 flex-1">
                <Field
                  id={`${id}-approve-code`}
                  name="code"
                  label={t('code')}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={approveCode}
                  onChange={(event) => {
                    setApproveCode(event.currentTarget.value)
                    setApproveError(undefined)
                  }}
                  error={approveError}
                />
              </div>
              <Button type="submit" disabled={approving.pending} aria-busy={approving.pending || undefined} className="shrink-0">
                {t('approve')}
              </Button>
            </div>
            <a href="#reject-policy" className="inline-flex min-h-11 items-center justify-center font-medium text-danger underline underline-offset-4 hover:no-underline lg:hidden">
              {t('rejectTitle')}
            </a>
          </form>

          <form id="reject-policy" onSubmit={onReject} noValidate className="flex scroll-mt-4 flex-col gap-4 border-t border-line pt-4" aria-labelledby={`${id}-reject`}>
            <h3 id={`${id}-reject`} className="font-semibold text-ink">
              {t('rejectTitle')}
            </h3>
            <p className="text-base text-ink-muted md:text-sm">{t('rejectHint')}</p>
            {failureOf(rejecting.outcome)}
            <TextArea
              id={`${id}-reason`}
              name="reason"
              label={t('reason')}
              value={reason}
              onChange={(event) => {
                setReason(event.currentTarget.value)
                setErrors((e) => ({ ...e, reason: undefined }))
              }}
              error={errors.reason}
              maxLength={REASON_MAX_LENGTH}
              required
            />
            <Field
              id={`${id}-reject-code`}
              name="code"
              label={t('code')}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={rejectCode}
              onChange={(event) => {
                setRejectCode(event.currentTarget.value)
                setErrors((e) => ({ ...e, code: undefined }))
              }}
              error={errors.code}
            />
            <ConfirmBox
              id={`${id}-reject-confirm`}
              label={t('confirm')}
              checked={confirmed}
              onChange={(checked) => {
                setConfirmed(checked)
                setErrors((e) => ({ ...e, confirm: undefined }))
              }}
              error={errors.confirm}
            />
            <Button type="submit" variant="danger" disabled={rejecting.pending} aria-busy={rejecting.pending || undefined} className="self-start">
              {t('reject')}
            </Button>
          </form>
        </>
      ) : null}
    </section>
  )
}
