'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { formatDateTime } from '../format'
import { ConfirmBox, TextArea } from '../request-view/text-area'
import { useAction } from '../request-view/use-action'
import { taskErrorKey, type ActionFailure, type ActionOutcome } from './outcome'

// Deciding a request, purchase-order or variance task (FR-DOA-004 AC1, §9.9 principles 5 and 7): approve is the one
// primary button — on phones it sticks to the bottom of the screen — and asks for a second press that names the document
// and the amount, because a decision cannot be changed. Return and reject live apart from it, under their own heading,
// with a reason the other side will read and a tick; reject is outlined in danger so it never looks like approve. A
// request can also be asked about, in a third, separate form (FR-INT-009 AC3); a PO is approved, returned to procurement
// or rejected; a variance is approved or rejected, never returned (BR-GR-03). A field's error goes as soon as the field
// changes. The service checks the assignee, the state and separation of duties again.

const REASON_MIN = 3

export type Decision = 'APPROVE' | 'RETURN' | 'REJECT'

/** What the task decides; each has its own choices and words */
export type DecisionKind = 'REQUEST' | 'PURCHASE_ORDER' | 'VARIANCE'
type Disposition = 'CLOSE_SHORT' | 'ACCEPT_EXCESS' | 'ACCEPT_DAMAGED'
const HINTED: readonly string[] = ['CLOSE_SHORT', 'ACCEPT_EXCESS', 'ACCEPT_DAMAGED']

export interface DecisionPanelProps {
  readonly taskId: string
  /** The task waits for a decision; otherwise only the result of this visit is shown */
  readonly open: boolean
  /** The document number (or title) and the amount, named in the confirmation */
  readonly label: string
  readonly amount: string
  readonly locale: string
  /** REQUEST by default */
  readonly kind?: DecisionKind
  /** VARIANCE: what approving does (CLOSE_SHORT, ACCEPT_EXCESS, ACCEPT_DAMAGED), for the hint of rejecting */
  readonly disposition?: string
  readonly actions: {
    readonly decide: (input: { taskId: string; decision: Decision; reason?: string }, idempotencyKey: string) => Promise<ActionOutcome>
    /** Asking the requester: request tasks only */
    readonly ask?: (input: { taskId: string; question: string }, idempotencyKey: string) => Promise<ActionOutcome>
  }
}

/** The message of a failed decision; a task decided already says who and when (FR-DOA-004 AC2) */
export function useTaskFailureText(locale: string) {
  const t = useTranslations('tasks.errors')
  return (failure: ActionFailure) =>
    t(taskErrorKey(failure), { name: failure.name ?? '-', time: failure.time ? formatDateTime(locale, failure.time) : '-', rule: failure.rule ?? '-', requestId: failure.requestId ?? '-' })
}

/** The task was decided, moved or closed while this page was open */
export const taskClosed = (outcome: ActionOutcome | null): outcome is ActionFailure => Boolean(outcome && !outcome.ok && ['DECIDED', 'STATE', 'NOT_FOUND'].includes(taskErrorKey(outcome)))

/**
 * When the task turns out to be closed already, the panel says so — who decided it and when — and the page reloads to
 * show the task as it is now, so its buttons go away.
 */
export function useClosedTask(locale: string) {
  const router = useRouter()
  const failureText = useTaskFailureText(locale)
  const [closed, setClosed] = useState<string | null>(null)
  const check = (outcome: ActionOutcome) => {
    if (!taskClosed(outcome)) return
    setClosed(failureText(outcome))
    router.refresh()
    // The heading shows who decided it once the page has reloaded; on a phone the buttons were at the bottom
    window.scrollTo({ top: 0 })
  }
  return { closed, check }
}

export function DecisionPanel({ taskId, open, label, amount, locale, kind = 'REQUEST', disposition, actions }: DecisionPanelProps) {
  const t = useTranslations('tasks.decide')
  const po = kind === 'PURCHASE_ORDER'
  const variance = kind === 'VARIANCE'
  const hinted = (disposition && HINTED.includes(disposition) ? disposition : 'other') as Disposition | 'other'
  const ask = kind === 'REQUEST' ? actions.ask : undefined
  // The words of each kind; a request keeps the words it always had
  const copy = {
    confirmText: variance ? t('variance.confirmText', { label, amount }) : t('confirmText', { label, amount }),
    otherLink: po ? t('po.otherLink') : variance ? t('variance.otherLink') : t('otherLink'),
    otherTitle: po ? t('po.otherTitle') : variance ? t('variance.otherTitle') : t('otherTitle'),
    returnOption: po ? t('po.returnOption') : t('returnOption'),
    returnHint: po ? t('po.returnHint') : t('returnHint'),
    rejectOption: po ? t('po.rejectOption') : t('rejectOption'),
    rejectHint: po ? t('po.rejectHint') : variance ? t(`variance.rejectHint.${hinted}`) : t('rejectHint'),
    reasonHint: po ? t('po.reasonHint') : variance ? t('variance.reasonHint') : t('reasonHint'),
    submitReturn: po ? t('po.submitReturn') : t('submitReturn'),
    submitReject: po ? t('po.submitReject') : variance ? t('variance.submitReject') : t('submitReject'),
    returned: po ? t('po.returned') : t('returned'),
    rejected: po ? t('po.rejected') : variance ? t('variance.rejected') : t('rejected'),
  }
  const choices: ReadonlyArray<'RETURN' | 'REJECT'> = variance ? ['REJECT'] : ['RETURN', 'REJECT']
  const tErrors = useTranslations('tasks.errors')
  const reasonError = po ? t('po.reasonError') : variance ? t('variance.reasonError') : tErrors('REASON')
  const failureText = useTaskFailureText(locale)
  const stale = useClosedTask(locale)
  const id = useId()
  const approving = useAction()
  const deciding = useAction()
  const asking = useAction()
  const [confirming, setConfirming] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [choice, setChoice] = useState<'RETURN' | 'REJECT'>(variance ? 'REJECT' : 'RETURN')
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; confirm?: string }>({})
  const [question, setQuestion] = useState('')
  const [questionError, setQuestionError] = useState<string>()

  const finished = (text: string) => {
    setDone(text)
    window.scrollTo({ top: 0 })
  }

  async function approve() {
    const outcome = await approving.run((key) => actions.decide({ taskId, decision: 'APPROVE' }, key))
    setConfirming(false)
    if (outcome.ok) finished(t('approved'))
    else stale.check(outcome)
  }

  async function onDecide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = reasonError
    if (!confirmed) next.confirm = tErrors('CONFIRM')
    setErrors(next)
    if (next.reason || next.confirm) return
    const outcome = await deciding.run((key) => actions.decide({ taskId, decision: choice, reason: reason.trim() }, key))
    if (outcome.ok) finished(choice === 'RETURN' ? copy.returned : copy.rejected)
    else stale.check(outcome)
  }

  async function onAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ask) return
    if (question.trim().length < REASON_MIN) return setQuestionError(tErrors('QUESTION'))
    setQuestionError(undefined)
    const outcome = await asking.run((key) => ask({ taskId, question: question.trim() }, key))
    if (outcome.ok) {
      setQuestion('')
      finished(t('asked'))
    } else stale.check(outcome)
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
          {/* Phones: the approve bar sticks to the bottom of the screen; wide screens: it heads the right column */}
          <div className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 border-t border-line bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:static lg:z-auto lg:border-0 lg:bg-transparent lg:p-0">
            {failureOf(approving.outcome)}
            {confirming ? (
              <div role="group" aria-labelledby={`${id}-confirm-text`} className="flex flex-col gap-2">
                <p id={`${id}-confirm-text`} className="font-medium text-ink">
                  {copy.confirmText}
                </p>
                <div className="flex gap-3">
                  <Button onClick={() => void approve()} disabled={approving.pending} className="flex-1">
                    {approving.pending ? t('working') : t('confirm')}
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirming(false)} disabled={approving.pending}>
                    {t('checkFirst')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                onClick={() => {
                  approving.clear()
                  setConfirming(true)
                }}
                className="w-full"
              >
                {t('approve')}
              </Button>
            )}
            <a href="#other-decisions" className="inline-flex min-h-11 items-center justify-center font-medium text-primary underline underline-offset-4 hover:no-underline lg:hidden">
              {copy.otherLink}
            </a>
          </div>

          <div id="other-decisions" className="flex scroll-mt-4 flex-col gap-6 border-t border-line pt-4">
            <form onSubmit={onDecide} noValidate className="flex flex-col gap-4" aria-labelledby={`${id}-other`}>
              <h3 id={`${id}-other`} className="font-semibold text-ink">
                {copy.otherTitle}
              </h3>
              {failureOf(deciding.outcome)}
              {variance ? (
                <div className="flex flex-col gap-1">
                  <p className="text-base text-ink-muted md:text-sm">{copy.rejectHint}</p>
                  <p className="text-base text-ink-muted md:text-sm">{t('variance.noReturn')}</p>
                </div>
              ) : null}
              {/* A variance has one way out besides approving: no choice to make */}
              {choices.length > 1 ? (
                <fieldset className="flex flex-col gap-1">
                  <legend className="mb-1 font-medium text-ink">{t('choice')}</legend>
                  {choices.map((value) => (
                    <label key={value} className="flex min-h-11 items-start gap-3 py-1">
                      <input
                        type="radio"
                        name="decision"
                        value={value}
                        checked={choice === value}
                        onChange={() => setChoice(value)}
                        aria-describedby={`${id}-${value}-hint`}
                        className="mt-1 size-5 shrink-0 accent-[var(--primary)]"
                      />
                      <span className="flex flex-col">
                        <span className="font-medium text-ink">{value === 'RETURN' ? copy.returnOption : copy.rejectOption}</span>
                        <span id={`${id}-${value}-hint`} className="text-base text-ink-muted md:text-sm">
                          {value === 'RETURN' ? copy.returnHint : copy.rejectHint}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <TextArea
                id={`${id}-reason`}
                name="reason"
                label={t('reason')}
                hint={copy.reasonHint}
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
                id={`${id}-decision-confirm`}
                label={t('confirmDecision')}
                checked={confirmed}
                onChange={(checked) => {
                  setConfirmed(checked)
                  setErrors((e) => ({ ...e, confirm: undefined }))
                }}
                error={errors.confirm}
              />
              <Button type="submit" variant={choice === 'REJECT' ? 'danger' : 'secondary'} disabled={deciding.pending} className="self-start">
                {deciding.pending ? t('working') : choice === 'REJECT' ? copy.submitReject : copy.submitReturn}
              </Button>
            </form>

            {ask ? (
              <form onSubmit={onAsk} noValidate className="flex flex-col gap-4 border-t border-line pt-4" aria-labelledby={`${id}-ask`}>
                <h3 id={`${id}-ask`} className="font-semibold text-ink">
                  {t('askTitle')}
                </h3>
                {failureOf(asking.outcome)}
                <TextArea
                  id={`${id}-question`}
                  name="question"
                  label={t('question')}
                  hint={t('askHint')}
                  value={question}
                  onChange={(event) => {
                    setQuestion(event.currentTarget.value)
                    setQuestionError(undefined)
                  }}
                  error={questionError}
                  maxLength={REASON_MAX_LENGTH}
                  required
                />
                <Button type="submit" variant="secondary" disabled={asking.pending} className="self-start">
                  {asking.pending ? t('working') : t('askSubmit')}
                </Button>
              </form>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  )
}
