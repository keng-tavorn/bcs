'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { ConfirmBox, TextArea } from '../request-view/text-area'
import { StateLine } from '../request-view/status'
import { useAction } from '../request-view/use-action'
import { useBarSpace } from '../tasks/bar-space'
import { pinRefused, taskClosed, TaskFailure, useClosedTask, useFocusPinAfterRefusal, useOneTry, useTaskFailureText, type TaskDecisionInput } from '../tasks/decision-panel'
import { PIN_FIELD_KEYS, taskErrorKey, type ActionOutcome } from '../tasks/outcome'
import { pinIsComplete } from '../tasks/pin-field'
import { PinOtp } from './pin-otp'

// The decision bar of the document page (FR-INT-012 AC4, §9.9 principle 5, §9.10 "แถบตัดสิน"): for the reader who holds an
// open task on the document, at the top of the right column — on phones and below 1280 px fixed to the bottom of the
// screen — with what the decision rests on: the amount on the DOA's basis, the state of the budget and the DOA version and
// rule. "อนุมัติ" is the one primary button and asks for a second press that names the document and the amount; "ขอข้อมูล
// เพิ่ม" and "ตีกลับให้แก้" follow, and "ไม่อนุมัติ" is outlined in danger at the far end, away from approve. Returning
// and rejecting are confirmed in an Alert Dialog with the reason the other side reads and a tick, since neither can be
// undone. An amount at or above the DOA version's stepUpThreshold is decided with the PIN (BR-TOK-05, ADR-047). Every
// decision goes to the same server actions and services as the task page (/tasks/[id]): they check the assignee, the
// task's state, separation of duties and the PIN again, so this bar is never the guard. The outcome of a decision is a
// toast (§9.10 ข้อความแจ้งผล) and the step turning into a stamp; a failure stays in the bar or the dialog, never in a
// toast alone (§9.9).

const REASON_MIN = 3

export interface DecisionBarFacts {
  /** "45,000.00 บาท (รวม VAT)" */
  readonly amount: string
  readonly budget?: ReactNode
  readonly doaRef?: string
}

export interface DecisionBarProps {
  readonly taskId: string
  readonly kind: 'REQUEST' | 'PURCHASE_ORDER'
  /** The document number (or title) and the amount, named in the approval's confirmation */
  readonly label: string
  readonly amount: string
  readonly locale: string
  readonly stepUp: boolean
  readonly facts: DecisionBarFacts
  readonly actions: {
    readonly decide: (input: TaskDecisionInput, idempotencyKey: string) => Promise<ActionOutcome>
    readonly ask?: (input: { taskId: string; question: string }, idempotencyKey: string) => Promise<ActionOutcome>
  }
}

type Dialog = 'RETURN' | 'REJECT' | 'ASK' | null

export function DecisionBar({ taskId, kind, label, amount, locale, stepUp, facts, actions }: DecisionBarProps) {
  const t = useTranslations('tasks.decide')
  const td = useTranslations('document.bar')
  const tErrors = useTranslations('tasks.errors')
  const po = kind === 'PURCHASE_ORDER'
  const ask = po ? undefined : actions.ask
  const failureText = useTaskFailureText(locale)
  const stale = useClosedTask(locale)
  const id = useId()
  const approving = useAction()
  const deciding = useAction()
  const asking = useAction()
  const oneTry = useOneTry()
  const hydrated = useHydrated()
  const barRef = useBarSpace<HTMLElement>()
  const [confirming, setConfirming] = useState(false)
  const [approvePin, setApprovePin] = useState('')
  const [approvePinError, setApprovePinError] = useState<string>()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [reason, setReason] = useState('')
  const [decidePin, setDecidePin] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; pin?: string; confirm?: string }>({})
  useFocusPinAfterRefusal(approving.outcome, `${id}-approve-pin`)
  useFocusPinAfterRefusal(deciding.outcome, `${id}-decide-pin`)

  const atPin = (outcome: ActionOutcome | null) => (outcome && !outcome.ok && PIN_FIELD_KEYS.includes(taskErrorKey(outcome)) ? failureText(outcome) : undefined)
  const failureOf = (outcome: ActionOutcome | null) => (outcome && !outcome.ok && !taskClosed(outcome) && !atPin(outcome) ? <TaskFailure failure={outcome} text={failureText(outcome)} /> : null)

  const openDialog = (which: Exclude<Dialog, null>) => {
    setReason('')
    setDecidePin('')
    setConfirmed(false)
    setErrors({})
    deciding.clear()
    asking.clear()
    setDialog(which)
  }

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const pin = approvePin
    if (stepUp && !pinIsComplete(pin)) return setApprovePinError(tErrors('PIN'))
    setApprovePinError(undefined)
    await oneTry(async () => {
      const outcome = await approving.run((key) => actions.decide({ taskId, decision: 'APPROVE', ...(stepUp ? { pin } : {}) }, key))
      setApprovePin('')
      if (!outcome.ok && pinRefused(outcome)) return
      setConfirming(false)
      if (outcome.ok) toast.success(t('approved'))
      else stale.check(outcome)
    })
  }

  async function decide(event: FormEvent<HTMLFormElement>, decision: 'RETURN' | 'REJECT') {
    event.preventDefault()
    const pin = decidePin
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = po ? t('po.reasonError') : tErrors('REASON')
    if (stepUp && !pinIsComplete(pin)) next.pin = tErrors('PIN')
    if (!confirmed) next.confirm = tErrors('CONFIRM')
    setErrors(next)
    if (next.reason || next.pin || next.confirm) return
    await oneTry(async () => {
      const outcome = await deciding.run((key) => actions.decide({ taskId, decision, reason: reason.trim(), ...(stepUp ? { pin } : {}) }, key))
      setDecidePin('')
      if (outcome.ok) {
        setDialog(null)
        toast.success(decision === 'RETURN' ? (po ? t('po.returned') : t('returned')) : po ? t('po.rejected') : t('rejected'))
      } else if (taskClosed(outcome)) {
        setDialog(null)
        stale.check(outcome)
      }
    })
  }

  async function onAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ask) return
    if (reason.trim().length < REASON_MIN) return setErrors({ reason: tErrors('QUESTION') })
    setErrors({})
    const outcome = await asking.run((key) => ask({ taskId, question: reason.trim() }, key))
    if (outcome.ok) {
      setDialog(null)
      toast.success(t('asked'))
    } else if (taskClosed(outcome)) {
      setDialog(null)
      stale.check(outcome)
    }
  }

  const reasonDialog = dialog === 'RETURN' || dialog === 'REJECT'
  const dialogTitle = dialog === 'ASK' ? t('askTitle') : dialog === 'RETURN' ? (po ? t('po.returnOption') : t('returnOption')) : po ? t('po.rejectOption') : t('rejectOption')
  const dialogHint = dialog === 'ASK' ? t('askHint') : dialog === 'RETURN' ? (po ? t('po.returnHint') : t('returnHint')) : po ? t('po.rejectHint') : t('rejectHint')

  if (stale.closed) {
    return (
      <section aria-label={t('title')} className="flex flex-col gap-3">
        <Notice tone="danger">{stale.closed}</Notice>
      </section>
    )
  }

  return (
    <section
      ref={barRef}
      aria-labelledby={`${id}-title`}
      data-decision-bar=""
      className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-3 border-t border-line bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:left-(--sidebar-width-icon) lg:group-has-[[data-slot=sidebar][data-state=expanded]]/sidebar-wrapper:left-(--sidebar-width) xl:static xl:z-auto xl:rounded-md xl:border xl:p-4"
    >
      <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
        {t('title')}
      </h2>
      <dl className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <dt className="text-ink-muted">{td('amount')}</dt>
          <dd className="tabular font-semibold text-ink">{facts.amount}</dd>
        </div>
        {facts.budget ? (
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <dt className="text-ink-muted">{td('budget')}</dt>
            <dd>{facts.budget}</dd>
          </div>
        ) : null}
        {facts.doaRef ? (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-ink-muted">{td('doa')}</dt>
            <dd className="font-medium text-ink">{facts.doaRef}</dd>
          </div>
        ) : null}
      </dl>
      {stepUp ? <StateLine kind="key">{t('stepUpHint')}</StateLine> : null}
      {failureOf(approving.outcome)}
      {confirming ? (
        <form method="post" onSubmit={(event) => void approve(event)} noValidate>
          <div role="group" aria-labelledby={`${id}-confirm-text`} className="flex flex-col gap-2">
            <p id={`${id}-confirm-text`} className="font-medium text-ink">
              {t('confirmText', { label, amount })}
            </p>
            {stepUp ? (
              <PinOtp
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
                {approving.pending ? t('working') : t('confirm')}
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
          {t('approve')}
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {ask ? (
          <Button variant="secondary" onClick={() => openDialog('ASK')} disabled={!hydrated} className="px-3">
            {td('ask')}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => openDialog('RETURN')} disabled={!hydrated} className="px-3">
          {po ? td('returnPo') : td('return')}
        </Button>
        {/* Rejecting sits at the far end, outlined in danger, never beside approve (§9.9) */}
        <Button variant="danger" onClick={() => openDialog('REJECT')} disabled={!hydrated} className="ml-auto px-3">
          {td('reject')}
        </Button>
      </div>

      <AlertDialog open={dialog !== null} onOpenChange={(next) => (next ? null : setDialog(null))}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <form method="post" noValidate className="flex flex-col gap-4" onSubmit={(event) => void (dialog === 'ASK' ? onAsk(event) : dialog ? decide(event, dialog) : null)}>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-lg font-semibold text-ink">{dialogTitle}</AlertDialogTitle>
              <AlertDialogDescription className="text-base text-ink-muted">{dialogHint}</AlertDialogDescription>
            </AlertDialogHeader>
            {reasonDialog ? failureOf(deciding.outcome) : failureOf(asking.outcome)}
            <TextArea
              id={`${id}-reason`}
              name={dialog === 'ASK' ? 'question' : 'reason'}
              label={dialog === 'ASK' ? t('question') : t('reason')}
              hint={dialog === 'ASK' ? undefined : po ? t('po.reasonHint') : t('reasonHint')}
              value={reason}
              onChange={(event) => {
                setReason(event.currentTarget.value)
                setErrors((e) => ({ ...e, reason: undefined }))
              }}
              error={errors.reason}
              maxLength={REASON_MAX_LENGTH}
              required
            />
            {reasonDialog && stepUp ? (
              <PinOtp
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
            {reasonDialog ? (
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
            ) : null}
            <AlertDialogFooter className="gap-3">
              <AlertDialogCancel className="h-11 px-4 text-base" disabled={deciding.pending || asking.pending}>
                {td('cancel')}
              </AlertDialogCancel>
              <Button
                type="submit"
                variant={dialog === 'REJECT' ? 'danger' : 'primary'}
                disabled={deciding.pending || asking.pending || !hydrated}
                aria-busy={deciding.pending || asking.pending || undefined}
              >
                {deciding.pending || asking.pending
                  ? t('working')
                  : dialog === 'ASK'
                    ? t('askSubmit')
                    : dialog === 'RETURN'
                      ? po
                        ? t('po.submitReturn')
                        : t('submitReturn')
                      : po
                        ? t('po.submitReject')
                        : t('submitReject')}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
