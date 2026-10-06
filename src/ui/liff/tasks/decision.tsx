'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { useHydrated } from '../../form/hydrated'
import type { TaskDecisionInput } from '../../tasks/decision-panel'
import { LiffActionBar } from '../action-bar'
import { Button } from '../button'
import { LiffContent, LiffSection } from '../content'
import { LiffNotice } from '../notice'
import { PinInput } from '../pin-input'
import { LiffTextArea, LiffTick } from './fields'
import type { LiffTaskFailure, LiffTaskResult } from './result'
import { TaskRefusal, useClosedTask, useLiffSend } from './send'
import { focusField, pinComplete, REASON_MIN, type LiffTaskAction } from './shared'

// The decision of a request, purchase-order or variance task on its LIFF page (§9.4 /liff/tasks/[id], FR-LINE-003,
// FR-DOA-004 AC1, §9.9 principles 5 and 7): the same choices and words as the web decision page
// (src/ui/tasks/decision-panel.tsx), laid out for a phone in the LINE app.
//  - The bar at the bottom of the screen (§9.4) holds approve, the one primary button: it asks for a second press that
//    names the document and the amount, because a decision cannot be changed. Under it, the way to the other decisions.
//  - Return or reject live apart, in their own section at the end of the page, with a reason the other side reads and a
//    tick; reject is outlined in danger so it never looks like approve. A variance is approved or rejected, never
//    returned (BR-GR-03). A request can also be asked about, in a third section (FR-INT-009 AC3).
//  - A task whose amount is at or above the DOA version's stepUpThreshold is decided with the PIN (FR-AUTH-005 AC2,
//    FR-LINE-003 AC2): the second press of approve and the return-or-reject form each ask for it; asking does not. The
//    PIN is checked for its length here and again on the server, sent with the decision only, and cleared after every
//    try; a wrong PIN is said at its field with the tries left, a lock with its time, no PIN yet with where to set one.
//  - ?action=approve or ?action=reject from a LINE card (§9.3) opens with that choice ready — the second press of
//    approve, or reject chosen in its form — and never decides by itself.
//  - Nothing is sent before the page's script runs (src/ui/form/hydrated.ts): every form posts (method="post") and its
//    button and PIN field wait for the script, so a PIN never goes with a native submission into the page's address,
//    the browser's history or a request log (NFR-SEC-09). Each form sends one try at a time (./send.tsx).
// The details of the task are the page's (`children`, rendered on the server); this component places them, its forms
// after them and the bar below.

export type LiffDecisionKind = 'REQUEST' | 'PURCHASE_ORDER' | 'VARIANCE'
type Disposition = 'CLOSE_SHORT' | 'ACCEPT_EXCESS' | 'ACCEPT_DAMAGED'
const HINTED: readonly string[] = ['CLOSE_SHORT', 'ACCEPT_EXCESS', 'ACCEPT_DAMAGED']

export interface LiffTaskDecisionProps {
  readonly taskId: string
  /** The task waits for this member's decision; otherwise only the page's details (and what this visit did) */
  readonly open: boolean
  readonly kind: LiffDecisionKind
  /** The document number (or title) and the amount, named in the confirmation */
  readonly label: string
  readonly amount: string
  /** VARIANCE: what approving does, for the hint of rejecting */
  readonly disposition?: string
  /** Deciding needs the PIN (FR-AUTH-005 AC2) */
  readonly stepUp: boolean
  /** Digits of a PIN (PIN_LENGTH of src/core/pin, from the server) */
  readonly pinLength: number
  readonly initial: LiffTaskAction | null
  readonly pinSettingsHref: string
  readonly helpHref: string
  readonly decide: (input: TaskDecisionInput, idempotencyKey: string) => Promise<LiffTaskResult>
  /** Asking the requester: request tasks only */
  readonly ask?: (input: { taskId: string; question: string }, idempotencyKey: string) => Promise<LiffTaskResult>
  readonly children: ReactNode
}

/** The sections the bar links to (one decision per page, as on the web decision page) */
export const OTHER_DECISIONS_ID = 'other-decisions'
const ASK_ID = 'ask-requester'

export function LiffTaskDecision(props: LiffTaskDecisionProps) {
  const { taskId, open, kind, label, amount, disposition, stepUp, pinLength, initial, pinSettingsHref, helpHref, decide, ask, children } = props
  const t = useTranslations('tasks.decide')
  const tErrors = useTranslations('tasks.errors')
  const po = kind === 'PURCHASE_ORDER'
  const variance = kind === 'VARIANCE'
  const hinted = (disposition && HINTED.includes(disposition) ? disposition : 'other') as Disposition | 'other'
  const askable = kind === 'REQUEST' && ask !== undefined
  // The words of each kind, as the web decision page says them; a request keeps the words it always had
  const copy = {
    confirmText: variance ? t('variance.confirmText', { label, amount }) : t('confirmText', { label, amount }),
    otherLink: po ? t('po.otherLink') : variance ? t('variance.otherLink') : t('otherLink'),
    otherTitle: po ? t('po.otherTitle') : variance ? t('variance.otherTitle') : t('otherTitle'),
    returnOption: po ? t('po.returnOption') : t('returnOption'),
    returnHint: po ? t('po.returnHint') : t('returnHint'),
    rejectOption: po ? t('po.rejectOption') : t('rejectOption'),
    rejectHint: po ? t('po.rejectHint') : variance ? t(`variance.rejectHint.${hinted}`) : t('rejectHint'),
    reasonHint: po ? t('po.reasonHint') : variance ? t('variance.reasonHint') : t('reasonHint'),
    reasonError: po ? t('po.reasonError') : variance ? t('variance.reasonError') : tErrors('REASON'),
    submitReturn: po ? t('po.submitReturn') : t('submitReturn'),
    submitReject: po ? t('po.submitReject') : variance ? t('variance.submitReject') : t('submitReject'),
    returned: po ? t('po.returned') : t('returned'),
    rejected: po ? t('po.rejected') : variance ? t('variance.rejected') : t('rejected'),
    stepUpHint: variance ? t('variance.stepUpHint') : t('stepUpHint'),
  }
  const choices: ReadonlyArray<'RETURN' | 'REJECT'> = variance ? ['REJECT'] : ['RETURN', 'REJECT']

  const id = useId()
  const hydrated = useHydrated()
  const stale = useClosedTask()
  const approving = useLiffSend()
  const rejecting = useLiffSend()
  const asking = useLiffSend()
  const [done, setDone] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(initial === 'approve')
  const [approvePin, setApprovePin] = useState('')
  const [approvePinError, setApprovePinError] = useState<string>()
  const [approveFailure, setApproveFailure] = useState<LiffTaskFailure | null>(null)
  const [choice, setChoice] = useState<'RETURN' | 'REJECT'>(variance || initial === 'reject' ? 'REJECT' : 'RETURN')
  const [reason, setReason] = useState('')
  const [decidePin, setDecidePin] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; pin?: string; confirm?: string }>({})
  const [decideFailure, setDecideFailure] = useState<LiffTaskFailure | null>(null)
  const [question, setQuestion] = useState('')
  const [questionError, setQuestionError] = useState<string>()
  const [askFailure, setAskFailure] = useState<LiffTaskFailure | null>(null)
  const approvePinId = `${id}-approve-pin`
  const decidePinId = `${id}-decide-pin`

  // A LINE card's "ตีกลับ / ไม่อนุมัติ" opens the page at the reason of rejecting (§9.3); nothing is sent
  useEffect(() => {
    if (initial !== 'reject' || !open) return
    document.getElementById(OTHER_DECISIONS_ID)?.scrollIntoView({ block: 'start' })
    document.getElementById(`${id}-reason`)?.focus({ preventScroll: true })
  }, [initial, open, id])

  const finished = (text: string) => {
    setDone(text)
    window.scrollTo({ top: 0 })
  }

  async function onApprove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const pin = approvePin
    if (stepUp && !pinComplete(pin, pinLength)) {
      setApprovePinError(tErrors('PIN'))
      return
    }
    setApprovePinError(undefined)
    setApproveFailure(null)
    const result = await approving.send((key) => decide({ taskId, decision: 'APPROVE', ...(stepUp ? { pin } : {}) }, key))
    if (!result) return
    setApprovePin('')
    if (result.ok) {
      setConfirming(false)
      finished(t('approved'))
      return
    }
    if (stale.check(result)) return
    if (result.at === 'pin') {
      setApprovePinError(result.text)
      focusField(approvePinId)
      return
    }
    // A lock, no PIN yet, or a refusal of the service: said in the bar, and the second press stays for the next try
    setApproveFailure(result)
  }

  async function onDecide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const pin = decidePin
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = copy.reasonError
    if (stepUp && !pinComplete(pin, pinLength)) next.pin = tErrors('PIN')
    if (!confirmed) next.confirm = tErrors('CONFIRM')
    setErrors(next)
    if (next.reason || next.pin || next.confirm) return
    setDecideFailure(null)
    const result = await rejecting.send((key) => decide({ taskId, decision: choice, reason: reason.trim(), ...(stepUp ? { pin } : {}) }, key))
    if (!result) return
    setDecidePin('')
    if (result.ok) {
      finished(choice === 'RETURN' ? copy.returned : copy.rejected)
      return
    }
    if (stale.check(result)) return
    if (result.at === 'pin') {
      setErrors((e) => ({ ...e, pin: result.text }))
      focusField(decidePinId)
      return
    }
    setDecideFailure(result)
  }

  async function onAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ask) return
    if (question.trim().length < REASON_MIN) {
      setQuestionError(tErrors('QUESTION'))
      return
    }
    setQuestionError(undefined)
    setAskFailure(null)
    const result = await asking.send((key) => ask({ taskId, question: question.trim() }, key))
    if (!result) return
    if (result.ok) {
      setQuestion('')
      finished(t('asked'))
      return
    }
    if (!stale.check(result)) setAskFailure(result)
  }

  /** The task still waits for this member, and this visit has not decided it */
  const active = open && !stale.closed && !done
  return (
    <>
      <LiffContent>
        {/* What this visit decided or asked, or that the task was closed meanwhile (by whom, when — FR-DOA-004 AC2), until
            the page rendered again says it itself: who decided it when, the question, where it moved — one notice */}
        {done && open ? <LiffNotice tone="success">{done}</LiffNotice> : null}
        {stale.closed && open ? <LiffNotice tone="danger">{stale.closed}</LiffNotice> : null}
        {active && stepUp ? <LiffNotice tone="info">{copy.stepUpHint}</LiffNotice> : null}
        {children}

        {active ? (
          <LiffSection id={OTHER_DECISIONS_ID} title={copy.otherTitle}>
            <form method="post" onSubmit={onDecide} noValidate className="flex flex-col gap-4">
              {decideFailure ? <TaskRefusal failure={decideFailure} pinSettingsHref={pinSettingsHref} helpHref={helpHref} /> : null}
              {variance ? (
                <div className="flex flex-col gap-1">
                  <p className="text-ink-muted">{copy.rejectHint}</p>
                  <p className="text-ink-muted">{t('variance.noReturn')}</p>
                </div>
              ) : null}
              {/* A variance has one way out besides approving: no choice to make. The group keeps its name for screen
                  readers; on screen the section's heading above already says what the choice is (§9.9: no label
                  repeating it), as on the web decision page */}
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
                        <span id={`${id}-${value}-hint`} className="text-ink-muted">
                          {value === 'RETURN' ? copy.returnHint : copy.rejectHint}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <LiffTextArea
                id={`${id}-reason`}
                name="reason"
                label={t('reason')}
                hint={copy.reasonHint}
                value={reason}
                onChange={(value) => {
                  setReason(value)
                  setErrors((e) => ({ ...e, reason: undefined }))
                }}
                error={errors.reason}
                maxLength={REASON_MAX_LENGTH}
              />
              {stepUp ? (
                <PinInput
                  id={decidePinId}
                  name="pin"
                  label={t('pin')}
                  length={pinLength}
                  value={decidePin}
                  onChange={(value) => {
                    setDecidePin(value)
                    setErrors((e) => ({ ...e, pin: undefined }))
                  }}
                  {...(errors.pin ? { error: errors.pin } : {})}
                  disabled={rejecting.pending || !hydrated}
                />
              ) : null}
              <LiffTick
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
                disabled={rejecting.pending || !hydrated}
                aria-busy={rejecting.pending || undefined}
                className="self-start"
              >
                {rejecting.pending ? t('working') : choice === 'REJECT' ? copy.submitReject : copy.submitReturn}
              </Button>
            </form>
          </LiffSection>
        ) : null}

        {active && askable ? (
          <LiffSection id={ASK_ID} title={t('askTitle')}>
            <form method="post" onSubmit={onAsk} noValidate className="flex flex-col gap-4">
              {askFailure ? <TaskRefusal failure={askFailure} pinSettingsHref={pinSettingsHref} helpHref={helpHref} /> : null}
              <LiffTextArea
                id={`${id}-question`}
                name="question"
                label={t('question')}
                hint={t('askHint')}
                value={question}
                onChange={(value) => {
                  setQuestion(value)
                  setQuestionError(undefined)
                }}
                error={questionError}
                maxLength={REASON_MAX_LENGTH}
              />
              <Button type="submit" variant="secondary" disabled={asking.pending || !hydrated} aria-busy={asking.pending || undefined} className="self-start">
                {asking.pending ? t('working') : t('askSubmit')}
              </Button>
            </form>
          </LiffSection>
        ) : null}
      </LiffContent>

      {active ? (
        <LiffActionBar label={t('title')}>
          {approveFailure ? <TaskRefusal failure={approveFailure} pinSettingsHref={pinSettingsHref} helpHref={helpHref} /> : null}
          {confirming ? (
            <form method="post" onSubmit={onApprove} noValidate>
              <div role="group" aria-labelledby={`${id}-confirm-text`} className="flex flex-col gap-3">
                <p id={`${id}-confirm-text`} className="font-medium text-ink">
                  {copy.confirmText}
                </p>
                {stepUp ? (
                  <PinInput
                    id={approvePinId}
                    name="pin"
                    label={t('pin')}
                    length={pinLength}
                    value={approvePin}
                    onChange={(value) => {
                      setApprovePin(value)
                      setApprovePinError(undefined)
                    }}
                    {...(approvePinError ? { error: approvePinError } : {})}
                    disabled={approving.pending || !hydrated}
                  />
                ) : null}
                <div className="flex gap-3">
                  <Button type="submit" disabled={approving.pending || !hydrated} aria-busy={approving.pending || undefined} className="flex-1">
                    {approving.pending ? t('working') : t('confirm')}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setConfirming(false)
                      setApprovePin('')
                      setApprovePinError(undefined)
                      setApproveFailure(null)
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
                setApproveFailure(null)
                setConfirming(true)
              }}
              disabled={!hydrated}
              className="w-full"
            >
              {t('approve')}
            </Button>
          )}
          <a href={`#${OTHER_DECISIONS_ID}`} className="inline-flex min-h-11 items-center justify-center font-medium text-primary underline underline-offset-4 hover:no-underline">
            {copy.otherLink}
          </a>
        </LiffActionBar>
      ) : null}
    </>
  )
}
