'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { requestErrorKey, type ActionFailure, type ActionOutcome } from '../tasks/outcome'
import type { RepeatErrorKey } from './repeat-rules'
import { ConfirmBox, TextArea } from './text-area'
import { useAction } from './use-action'

// What the requester can do on their request (FR-INT-009): answer the approver's question, edit a returned request and
// send it again (BR-DOA-09: a new route), and cancel with a reason (the reserved budget goes back at once). A returned
// request is sent again only from the edit page's "ตรวจและส่ง", which shows first what is left on the budget line, the
// route the DOA in effect gives now and the documents the rules ask for (§9.9 principle 3): this box leads there, and
// sends nothing itself. Each part keeps its result line after the page refreshes to the new state, so the words of the
// button come back as the confirmation (§9.9 rule 7); the page drops the box once the request is closed. A field's error
// goes as soon as the field changes. The services check every rule again.

const REASON_MIN = 3

/** The message of a failed requester action, with amounts formatted for reading (a reorder's keys: ./repeat-actions.tsx) */
export function useFailureText(keyOf: (failure: ActionFailure) => RepeatErrorKey = requestErrorKey) {
  const t = useTranslations('requestView.errors')
  return (failure: ActionFailure) => {
    const money = (value: string | undefined) => {
      if (!value) return '-'
      try {
        return formatSatang(amountToSatang(value))
      } catch {
        return value
      }
    }
    return t(keyOf(failure), { available: money(failure.available), shortfall: money(failure.shortfall), rule: failure.rule ?? '-', requestId: failure.requestId ?? '-' })
  }
}

export interface RequesterActionsProps {
  readonly requestId: string
  /** An open question of the approver (the task waits for the answer) */
  readonly question: { readonly infoRequestId: string; readonly text: string; readonly askedLine: string } | null
  /** RETURNED: the approver's reason */
  readonly returned: { readonly reason: string | null } | null
  readonly draft: boolean
  /** /requests/<id>/edit while the request is a draft or returned: where a returned request is changed and sent again */
  readonly editHref: string | null
  readonly actions: {
    readonly answer: (input: { infoRequestId: string; answer: string }, idempotencyKey: string) => Promise<ActionOutcome>
  }
}

export function RequesterActions({ question, returned, draft, editHref, actions }: RequesterActionsProps) {
  const t = useTranslations('requestView.actions')
  const tErrors = useTranslations('requestView.errors')
  const failureText = useFailureText()
  const id = useId()
  const [answer, setAnswer] = useState('')
  const [answerError, setAnswerError] = useState<string>()
  const answering = useAction()
  const [done, setDone] = useState<string | null>(null)

  async function onAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!question) return
    if (!answer.trim()) return setAnswerError(tErrors('ANSWER'))
    setAnswerError(undefined)
    setDone(null)
    const outcome = await answering.run((key) => actions.answer({ infoRequestId: question.infoRequestId, answer: answer.trim() }, key))
    if (outcome.ok) {
      setAnswer('')
      setDone(t('answered'))
    }
  }

  const failure = answering.outcome && !answering.outcome.ok ? answering.outcome : null
  if (!done && !failure && !question && !returned && !draft) return null

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4 rounded-md border border-line bg-surface p-4">
      <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
        {t('title')}
      </h2>
      {done ? <Notice tone="success">{done}</Notice> : null}
      {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}

      {question ? (
        <form onSubmit={onAnswer} noValidate className="flex flex-col gap-3">
          <h3 className="font-semibold text-ink">{t('answerTitle')}</h3>
          <blockquote className="border-l-2 border-info pl-3 text-ink">
            <span className="block break-words whitespace-pre-line">{question.text}</span>
            <span className="block text-base text-ink-muted md:text-sm">{question.askedLine}</span>
          </blockquote>
          <TextArea
            id={`${id}-answer`}
            name="answer"
            label={t('answerLabel')}
            hint={t('answerHint')}
            value={answer}
            onChange={(event) => {
              setAnswer(event.currentTarget.value)
              // The message goes once the field is being fixed (§9.9: errors say what to fix, not what was wrong before)
              setAnswerError(undefined)
            }}
            error={answerError}
            maxLength={REASON_MAX_LENGTH}
            required
          />
          <Button type="submit" disabled={answering.pending} className="self-start">
            {answering.pending ? t('working') : t('answerSubmit')}
          </Button>
        </form>
      ) : null}

      {draft && editHref ? (
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold text-ink">{t('draftTitle')}</h3>
          <p className="text-ink-muted">{t('draftHint')}</p>
          <Link href={editHref} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
            {t('editDraft')}
          </Link>
        </div>
      ) : null}

      {returned ? (
        <div className="flex flex-col gap-3">
          <h3 className="font-semibold text-ink">{t('returnedTitle')}</h3>
          {returned.reason ? <p className="break-words whitespace-pre-line text-ink">{t('returnedReason', { reason: returned.reason })}</p> : null}
          <p className="text-ink-muted">{t('resubmitHint')}</p>
          {/* The one way on, drawn as the main button: the edit page, whose last step sends it again once its budget, its
              new route and its documents were seen (§9.9 principle 3) */}
          {editHref ? (
            <Link
              href={editHref}
              className="inline-flex min-h-11 items-center justify-center self-start rounded-md bg-primary px-4 font-medium text-primary-foreground underline-offset-4 transition-colors duration-150 hover:underline"
            >
              {t('edit')}
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

export interface CancelRequestProps {
  readonly requestId: string
  readonly canCancel: boolean
  readonly cancel: (input: { requestId: string; reason: string }, idempotencyKey: string) => Promise<ActionOutcome>
}

/** Cancelling cannot be undone: a reason and a tick first (§9.9), behind a disclosure at the end of the page */
export function CancelRequest({ requestId, canCancel, cancel }: CancelRequestProps) {
  const t = useTranslations('requestView.actions')
  const tErrors = useTranslations('requestView.errors')
  const failureText = useFailureText()
  const id = useId()
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; confirm?: string }>({})
  const { pending, outcome, run } = useAction()
  const [done, setDone] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = tErrors('REASON')
    if (!confirmed) next.confirm = tErrors('CONFIRM')
    setErrors(next)
    if (next.reason || next.confirm) return
    const result = await run((key) => cancel({ requestId, reason: reason.trim() }, key))
    if (result.ok) setDone(true)
  }

  if (done) return <Notice tone="success">{t('cancelled')}</Notice>
  if (!canCancel) return null
  return (
    <details className="group border-t border-line pt-5">
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-danger underline underline-offset-4 hover:no-underline">{t('cancelTitle')}</summary>
      <form onSubmit={onSubmit} noValidate className="mt-3 flex max-w-xl flex-col gap-4">
        <p className="text-ink-muted">{t('cancelHint')}</p>
        {outcome && !outcome.ok ? <Notice tone="danger">{failureText(outcome)}</Notice> : null}
        <TextArea
          id={`${id}-reason`}
          name="reason"
          label={t('cancelReason')}
          value={reason}
          onChange={(event) => {
            setReason(event.currentTarget.value)
            setErrors((e) => ({ ...e, reason: undefined }))
          }}
          error={errors.reason}
          maxLength={REASON_MAX_LENGTH}
          required
        />
        <ConfirmBox
          id={`${id}-confirm`}
          label={t('cancelConfirm')}
          checked={confirmed}
          onChange={(checked) => {
            setConfirmed(checked)
            setErrors((e) => ({ ...e, confirm: undefined }))
          }}
          error={errors.confirm}
        />
        <Button type="submit" variant="danger" disabled={pending} className="self-start">
          {pending ? t('working') : t('cancelSubmit')}
        </Button>
      </form>
    </details>
  )
}
