'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { formatDateTime } from '../format'
import { ConfirmBox, TextArea } from '../request-view/text-area'
import { StateLine } from '../request-view/status'
import { useAction } from '../request-view/use-action'
import { useBarSpace } from './bar-space'
import { CLOSED_TASK_KEYS, PIN_FIELD_KEYS, taskErrorKey, type ActionFailure, type ActionOutcome } from './outcome'
import { PinField, pinIsComplete } from './pin-field'

export { PIN_FIELD_KEYS }

// Deciding a request, purchase-order or variance task (FR-DOA-004 AC1, §9.9 principles 5 and 7): approve is the one
// primary button — on phones it sticks to the bottom of the screen — and asks for a second press that names the document
// and the amount, because a decision cannot be changed. Return and reject live apart from it, under their own heading,
// with a reason the other side will read and a tick; reject is outlined in danger so it never looks like approve. A
// request can also be asked about, in a third, separate form (FR-INT-009 AC3); a PO is approved, returned to procurement
// or rejected; a variance is approved or rejected, never returned (BR-GR-03). A field's error goes as soon as the field
// changes. The service checks the assignee, the state and separation of duties again.
// A task whose amount is at or above the DOA version's stepUpThreshold (stepUp) is decided with the PIN (FR-AUTH-005
// AC2): the approval's second press and the return or reject form each ask for it; asking the requester does not. The
// PIN is checked for six digits here and again on the server, sent with the decision only, and cleared after every try;
// a form sends one try at a time, so a double tap never counts two wrong PINs. The second press is a form of its own, so
// Enter, or Go on the phone's number keypad, confirms like the button. On phones the page keeps room at its end as tall
// as the bar is, whatever the bar says (useBarSpace).
// Nothing is sent before the page's script runs (src/ui/form/hydrated.ts; a slow phone network shows the server's HTML
// for seconds): every form here is sent by the script only, so each says method="post" and its submit button waits for
// the script, and so does the PIN field (pin-field.tsx) — a PIN never goes with a native submission into the page's
// address, the browser's history or a request log (NFR-SEC-09). The approve button waits too: a press before it would
// be lost.

const REASON_MIN = 3

export type Decision = 'APPROVE' | 'RETURN' | 'REJECT'

/** What a decision sends: the PIN only when the task needs a step-up */
export interface TaskDecisionInput {
  readonly taskId: string
  readonly decision: Decision
  readonly reason?: string
  readonly pin?: string
  /** What a phase-1 subject's adapter asks with the decision (ADR-068): a payment run's flags shown, { flagsKey } (BR-PAY-07) */
  readonly subjectInput?: { readonly flagsKey: string }
}

/**
 * What the task decides; each has its own choices and words. REVIEW: a reviewer's task of a request (S6 · BR-WF-09);
 * BUDGET_TRANSFER: a budget transfer or adjustment (S6-15 · FR-BUD-103), approved, returned or rejected, never asked about;
 * BUDGET_OVERRUN: an over-budget approval (S6-16 · FR-BUD-101), the same three choices, its amount the shortfall (no VAT)
 */
export type DecisionKind = 'REQUEST' | 'PURCHASE_ORDER' | 'VARIANCE' | 'REVIEW' | 'BUDGET_TRANSFER' | 'BUDGET_OVERRUN'
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
  /** Deciding needs the PIN: the amount is at or above the DOA version's stepUpThreshold (FR-AUTH-005 AC2) */
  readonly stepUp?: boolean
  readonly actions: {
    readonly decide: (input: TaskDecisionInput, idempotencyKey: string) => Promise<ActionOutcome>
    /** Asking the requester: request tasks only */
    readonly ask?: (input: { taskId: string; question: string }, idempotencyKey: string) => Promise<ActionOutcome>
  }
}

/** The message of a failed decision; a task decided already says who and when (FR-DOA-004 AC2) */
export function useTaskFailureText(locale: string) {
  const t = useTranslations('tasks.errors')
  return (failure: ActionFailure) =>
    t(taskErrorKey(failure), {
      name: failure.name ?? '-',
      time: failure.time ? formatDateTime(locale, failure.time) : '-',
      rule: failure.rule ?? '-',
      requestId: failure.requestId ?? '-',
      attemptsLeft: failure.attemptsLeft ?? 0,
    })
}

/** Where a member without a PIN sets one (FR-AUTH-005 AC1) */
export const PIN_SETTINGS_HREF = '/settings/pin'

/** A failed decision next to its form, with the way to the PIN settings when the member has no PIN yet */
export function TaskFailure({ failure, text }: { failure: ActionFailure; text: string }) {
  const t = useTranslations('tasks.errors')
  return (
    <Notice tone="danger">
      <p>{text}</p>
      {taskErrorKey(failure) === 'PIN_NOT_SET' ? (
        <Link href={PIN_SETTINGS_HREF} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('PIN_NOT_SET_LINK')}
        </Link>
      ) : null}
    </Notice>
  )
}

/** The PIN was refused or missing: the try is over, and the same form takes the next one */
const PIN_KEYS: readonly string[] = ['PIN', 'PIN_INVALID', 'PIN_LOCKED', 'PIN_NOT_SET', 'STEP_UP']
export const pinRefused = (outcome: ActionOutcome | null) => Boolean(outcome && !outcome.ok && PIN_KEYS.includes(taskErrorKey(outcome)))

/**
 * After a PIN refused at its field the field is empty again: the focus goes back to it, so a screen reader reads the
 * message with the field and the next try starts at once
 */
export function useFocusPinAfterRefusal(outcome: ActionOutcome | null, fieldId: string) {
  useEffect(() => {
    if (outcome && !outcome.ok && PIN_FIELD_KEYS.includes(taskErrorKey(outcome))) document.getElementById(fieldId)?.focus()
  }, [outcome, fieldId])
}

/**
 * One try at a time: a second press while a decision is on its way is dropped before it reaches the server, so a double
 * tap never sends the same PIN twice (each wrong one counts toward the lock, FR-AUTH-005 AC3)
 */
export function useOneTry() {
  const busy = useRef(false)
  return async (run: () => Promise<void>) => {
    if (busy.current) return
    busy.current = true
    try {
      await run()
    } finally {
      busy.current = false
    }
  }
}

/** The task was decided, moved or closed while this page was open */
export const taskClosed = (outcome: ActionOutcome | null): outcome is ActionFailure => Boolean(outcome && !outcome.ok && CLOSED_TASK_KEYS.includes(taskErrorKey(outcome)))

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

export function DecisionPanel({ taskId, open, label, amount, locale, kind = 'REQUEST', disposition, stepUp = false, actions }: DecisionPanelProps) {
  const t = useTranslations('tasks.decide')
  const po = kind === 'PURCHASE_ORDER'
  const variance = kind === 'VARIANCE'
  // A reviewer passes, returns or asks: never rejects, and needs no PIN (BR-WF-09)
  const review = kind === 'REVIEW'
  // Its amount has no VAT, and a return or rejection gives the reservation back to the source line
  const transfer = kind === 'BUDGET_TRANSFER'
  // S6-16: its amount is the shortfall (no VAT); deciding it changes the budget only when approved
  const overrun = kind === 'BUDGET_OVERRUN'
  // The words of the two budget kinds, under tasks.decide.transfer or tasks.decide.overrun
  const budget = transfer ? 'transfer' : overrun ? 'overrun' : null
  const hinted = (disposition && HINTED.includes(disposition) ? disposition : 'other') as Disposition | 'other'
  const ask = kind === 'REQUEST' || review ? actions.ask : undefined
  // The words of each kind; a request keeps the words it always had
  const copy = {
    confirmText: variance
      ? t('variance.confirmText', { label, amount })
      : review
        ? t('review.confirmText', { label, amount })
        : budget
          ? t(`${budget}.confirmText`, { label, amount })
          : t('confirmText', { label, amount }),
    otherLink: po ? t('po.otherLink') : variance ? t('variance.otherLink') : review ? t('review.otherLink') : budget ? t(`${budget}.otherLink`) : t('otherLink'),
    otherTitle: po ? t('po.otherTitle') : variance ? t('variance.otherTitle') : review ? t('review.otherTitle') : t('otherTitle'),
    approve: review ? t('review.approve') : t('approve'),
    confirm: review ? t('review.confirm') : t('confirm'),
    approved: review ? t('review.approved') : t('approved'),
    returnOption: po ? t('po.returnOption') : budget ? t(`${budget}.returnOption`) : t('returnOption'),
    returnHint: po ? t('po.returnHint') : budget ? t(`${budget}.returnHint`) : t('returnHint'),
    rejectOption: po ? t('po.rejectOption') : t('rejectOption'),
    rejectHint: po ? t('po.rejectHint') : variance ? t(`variance.rejectHint.${hinted}`) : budget ? t(`${budget}.rejectHint`) : t('rejectHint'),
    reasonHint: po ? t('po.reasonHint') : variance ? t('variance.reasonHint') : budget ? t(`${budget}.reasonHint`) : t('reasonHint'),
    submitReturn: po ? t('po.submitReturn') : budget ? t(`${budget}.submitReturn`) : t('submitReturn'),
    submitReject: po ? t('po.submitReject') : variance ? t('variance.submitReject') : budget ? t(`${budget}.submitReject`) : t('submitReject'),
    returned: po ? t('po.returned') : budget ? t(`${budget}.returned`) : t('returned'),
    rejected: po ? t('po.rejected') : variance ? t('variance.rejected') : budget ? t(`${budget}.rejected`) : t('rejected'),
    // A variance is never returned (BR-GR-03): its PIN is for approving or rejecting
    stepUpHint: variance ? t('variance.stepUpHint') : t('stepUpHint'),
  }
  const choices: ReadonlyArray<'RETURN' | 'REJECT'> = variance ? ['REJECT'] : review ? ['RETURN'] : ['RETURN', 'REJECT']
  const tErrors = useTranslations('tasks.errors')
  const reasonError = po ? t('po.reasonError') : variance ? t('variance.reasonError') : tErrors('REASON')
  const failureText = useTaskFailureText(locale)
  const stale = useClosedTask(locale)
  const id = useId()
  const approving = useAction()
  const deciding = useAction()
  const asking = useAction()
  const oneTry = useOneTry()
  const hydrated = useHydrated()
  const barRef = useBarSpace<HTMLDivElement>()
  const [confirming, setConfirming] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [choice, setChoice] = useState<'RETURN' | 'REJECT'>(variance ? 'REJECT' : 'RETURN')
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; pin?: string; confirm?: string }>({})
  const [approvePin, setApprovePin] = useState('')
  const [approvePinError, setApprovePinError] = useState<string>()
  const [decidePin, setDecidePin] = useState('')
  const [question, setQuestion] = useState('')
  const [questionError, setQuestionError] = useState<string>()
  useFocusPinAfterRefusal(approving.outcome, `${id}-approve-pin`)
  useFocusPinAfterRefusal(deciding.outcome, `${id}-decide-pin`)

  const finished = (text: string) => {
    setDone(text)
    window.scrollTo({ top: 0 })
  }

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const pin = approvePin
    if (stepUp && !pinIsComplete(pin)) return setApprovePinError(tErrors('PIN'))
    setApprovePinError(undefined)
    await oneTry(async () => {
      const outcome = await approving.run((key) => actions.decide({ taskId, decision: 'APPROVE', ...(stepUp ? { pin } : {}) }, key))
      setApprovePin('')
      // A wrong, locked or missing PIN leaves the second press open for the next try
      if (!outcome.ok && pinRefused(outcome)) return
      setConfirming(false)
      if (outcome.ok) finished(copy.approved)
      else stale.check(outcome)
    })
  }

  async function onDecide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const pin = decidePin
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = reasonError
    if (stepUp && !pinIsComplete(pin)) next.pin = tErrors('PIN')
    if (!confirmed) next.confirm = tErrors('CONFIRM')
    setErrors(next)
    if (next.reason || next.pin || next.confirm) return
    await oneTry(async () => {
      const outcome = await deciding.run((key) => actions.decide({ taskId, decision: choice, reason: reason.trim(), ...(stepUp ? { pin } : {}) }, key))
      setDecidePin('')
      if (outcome.ok) finished(choice === 'RETURN' ? copy.returned : copy.rejected)
      else stale.check(outcome)
    })
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

  /** A wrong or malformed PIN is said at the PIN field */
  const atPin = (outcome: ActionOutcome | null) => (outcome && !outcome.ok && PIN_FIELD_KEYS.includes(taskErrorKey(outcome)) ? failureText(outcome) : undefined)
  /** A failure that belongs next to its form; a closed task is told once, above, and a wrong PIN at its field */
  const failureOf = (outcome: ActionOutcome | null) => (outcome && !outcome.ok && !taskClosed(outcome) && !atPin(outcome) ? <TaskFailure failure={outcome} text={failureText(outcome)} /> : null)

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
          {stepUp ? <StateLine kind="key">{copy.stepUpHint}</StateLine> : null}
          {/* Phones: the approve bar sticks to the bottom of the screen; wide screens: it heads the right column */}
          <div
            ref={barRef}
            data-decision-bar=""
            className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 border-t border-line bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:static lg:z-auto lg:border-0 lg:bg-transparent lg:p-0"
          >
            {failureOf(approving.outcome)}
            {confirming ? (
              <form method="post" onSubmit={(event) => void approve(event)} noValidate>
                <div role="group" aria-labelledby={`${id}-confirm-text`} className="flex flex-col gap-2">
                  <p id={`${id}-confirm-text`} className="font-medium text-ink">
                    {copy.confirmText}
                  </p>
                  {stepUp ? (
                    <PinField
                      id={`${id}-approve-pin`}
                      label={t('pin')}
                      value={approvePin}
                      onChange={(value) => {
                        setApprovePin(value)
                        setApprovePinError(undefined)
                        approving.clear()
                      }}
                      error={approvePinError ?? atPin(approving.outcome)}
                      disabled={approving.pending}
                    />
                  ) : null}
                  <div className="flex gap-3">
                    <Button type="submit" disabled={approving.pending || !hydrated} aria-busy={approving.pending || undefined} className="flex-1">
                      {approving.pending ? t('working') : copy.confirm}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setConfirming(false)
                        setApprovePin('')
                        setApprovePinError(undefined)
                        approving.clear()
                      }}
                      disabled={approving.pending}
                    >
                      {t('checkFirst')}
                    </Button>
                  </div>
                </div>
              </form>
            ) : (
              <Button
                onClick={() => {
                  approving.clear()
                  setConfirming(true)
                }}
                disabled={!hydrated}
                className="w-full"
              >
                {copy.approve}
              </Button>
            )}
            <a href="#other-decisions" className="inline-flex min-h-11 items-center justify-center font-medium text-primary underline underline-offset-4 hover:no-underline lg:hidden">
              {copy.otherLink}
            </a>
          </div>

          <div id="other-decisions" className="flex scroll-mt-4 flex-col gap-6 border-t border-line pt-4">
            <form method="post" onSubmit={onDecide} noValidate className="flex flex-col gap-4" aria-labelledby={`${id}-other`}>
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
              {review ? <p className="text-base text-ink-muted md:text-sm">{t('review.returnHint')}</p> : null}
              {/* A variance has one way out besides approving: no choice to make. The group keeps its name for screen
                  readers; on screen the heading above already says what the choice is (§9.9: no label repeating it) */}
              {choices.length > 1 ? (
                <fieldset className="flex flex-col gap-1">
                  <legend className="sr-only">{t('choice')}</legend>
                  {choices.map((value) => (
                    <label key={value} className="flex min-h-11 items-start gap-3 py-1">
                      <input
                        type="radio"
                        name="decision"
                        value={value}
                        checked={choice === value}
                        onChange={() => setChoice(value)}
                        aria-describedby={`${id}-${value}-hint`}
                        className="mt-1 size-5 shrink-0"
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
              {stepUp ? (
                <PinField
                  id={`${id}-decide-pin`}
                  label={t('pin')}
                  value={decidePin}
                  onChange={(value) => {
                    setDecidePin(value)
                    setErrors((e) => ({ ...e, pin: undefined }))
                    deciding.clear()
                  }}
                  error={errors.pin ?? atPin(deciding.outcome)}
                  disabled={deciding.pending}
                />
              ) : null}
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
              <Button
                type="submit"
                variant={choice === 'REJECT' ? 'danger' : 'secondary'}
                disabled={deciding.pending || !hydrated}
                aria-busy={deciding.pending || undefined}
                className="self-start"
              >
                {deciding.pending ? t('working') : choice === 'REJECT' ? copy.submitReject : copy.submitReturn}
              </Button>
            </form>

            {ask ? (
              <form method="post" onSubmit={onAsk} noValidate className="flex flex-col gap-4 border-t border-line pt-4" aria-labelledby={`${id}-ask`}>
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
                <Button type="submit" variant="secondary" disabled={asking.pending || !hydrated} className="self-start">
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
