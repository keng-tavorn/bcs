'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { PinOtp } from '../document/pin-otp'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { StateLine } from '../request-view/status'
import { ConfirmBox, TextArea } from '../request-view/text-area'
import { useAction } from '../request-view/use-action'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { Checkbox } from '../shadcn/checkbox'
import { Label } from '../shadcn/label'
import { useBarSpace } from '../tasks/bar-space'
import { pinRefused, taskClosed, TaskFailure, useClosedTask, useFocusPinAfterRefusal, useOneTry, useTaskFailureText, type TaskDecisionInput } from '../tasks/decision-panel'
import { PIN_FIELD_KEYS, taskErrorKey, type ActionFailure, type ActionOutcome } from '../tasks/outcome'
import { pinIsComplete } from '../tasks/pin-field'

// The approver's decision bar of a payment run (S9-09, FR-PAY-101 AC5, BR-PAY-07, demo step 4), for the member who holds
// the run's open approval task: the total transferred and how many items carry a flag, then "อนุมัติรอบจ่าย" — the one
// primary button, fixed to the bottom of the screen on phones — which first needs the tick "ตรวจรายการที่มีธง {n}
// รายการแล้ว" when any item is flagged, then a second press that names the run and the amount, with the PIN in Input OTP
// when the DOA version's stepUpThreshold asks for it (FR-AUTH-005 AC2). The approval sends back the key of the flags this
// page showed ({ flagsKey }, BR-PAY-07): the flags having changed meanwhile (PAYMENT_FLAGS_CHANGED), a flag without the
// preparer's reason (PAYMENT_FLAG_REASON_REQUIRED) or a pay date gone by is said in words, nothing is approved, and the
// page reloads the flags as they are now. Return and reject are asked in an Alert Dialog with the reason the preparer
// reads and a tick. The same server action, commands and services as the task page decide it (_tracking/commands.ts,
// approvals/decide.ts): they check the assignee, separation of duties, the step-up and the flags again; this bar is
// never the guard. Built from the parts of the shared decision panel, with the words of a payment run.

const REASON_MIN = 3
/** The run's own refusals of an approval, said in the words of this bar */
const RUN_REFUSALS: Readonly<Record<string, 'flagsChanged' | 'reasonRequired' | 'dateInvalid'>> = {
  PAYMENT_FLAGS_CHANGED: 'flagsChanged',
  PAYMENT_FLAG_REASON_REQUIRED: 'reasonRequired',
  PAYMENT_DATE_INVALID: 'dateInvalid',
}

export interface RunDecisionProps {
  readonly taskId: string
  /** The run's number, named in the approval's confirmation */
  readonly label: string
  /** The total transferred, formatted */
  readonly amount: string
  readonly flagged: number
  /** BR-PAY-07: the flags this page showed */
  readonly flagsKey: string
  readonly stepUp: boolean
  readonly locale: string
  readonly decide: (input: TaskDecisionInput, idempotencyKey: string) => Promise<ActionOutcome>
}

type Dialog = 'RETURN' | 'REJECT' | null

export function RunDecision({ taskId, label, amount, flagged, flagsKey, stepUp, locale, decide }: RunDecisionProps) {
  const t = useTranslations('payRun')
  const tt = useTranslations('tasks.decide')
  const tErrors = useTranslations('tasks.errors')
  const router = useRouter()
  const failureText = useTaskFailureText(locale)
  const stale = useClosedTask(locale)
  const id = useId()
  const approving = useAction()
  const deciding = useAction()
  const oneTry = useOneTry()
  const hydrated = useHydrated()
  const barRef = useBarSpace<HTMLElement>()
  const [acknowledged, setAcknowledged] = useState(false)
  const [ackError, setAckError] = useState(false)
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

  const subjectInput = { flagsKey }
  const runRefusal = (outcome: ActionOutcome | null): string | null => {
    const key = outcome && !outcome.ok ? RUN_REFUSALS[outcome.code] : undefined
    return key ? t(`decide.${key}`) : null
  }
  const atPin = (outcome: ActionOutcome | null) => (outcome && !outcome.ok && PIN_FIELD_KEYS.includes(taskErrorKey(outcome)) ? failureText(outcome) : undefined)
  const failureOf = (outcome: ActionOutcome | null) => {
    const own = runRefusal(outcome)
    if (own) return <Notice tone="danger">{own}</Notice>
    return outcome && !outcome.ok && !taskClosed(outcome) && !atPin(outcome) ? <TaskFailure failure={outcome as ActionFailure} text={failureText(outcome)} /> : null
  }

  function startApproval() {
    if (flagged > 0 && !acknowledged) return setAckError(true)
    approving.clear()
    setConfirming(true)
  }

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (flagged > 0 && !acknowledged) {
      setConfirming(false)
      return setAckError(true)
    }
    const pin = approvePin
    if (stepUp && !pinIsComplete(pin)) return setApprovePinError(tErrors('PIN'))
    setApprovePinError(undefined)
    await oneTry(async () => {
      const outcome = await approving.run((key) => decide({ taskId, decision: 'APPROVE', subjectInput, ...(stepUp ? { pin } : {}) }, key))
      setApprovePin('')
      if (!outcome.ok && pinRefused(outcome)) return
      setConfirming(false)
      if (outcome.ok) toast.success(t('decide.approved'))
      else if (runRefusal(outcome)) {
        // the flags as they are now: the approver checks them again and ticks again
        setAcknowledged(false)
        router.refresh()
      } else stale.check(outcome)
    })
  }

  const openDialog = (which: Exclude<Dialog, null>) => {
    setReason('')
    setDecidePin('')
    setConfirmed(false)
    setErrors({})
    deciding.clear()
    setDialog(which)
  }

  async function onDecide(event: FormEvent<HTMLFormElement>, decision: 'RETURN' | 'REJECT') {
    event.preventDefault()
    const pin = decidePin
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = tErrors('REASON')
    if (stepUp && !pinIsComplete(pin)) next.pin = tErrors('PIN')
    if (!confirmed) next.confirm = tErrors('CONFIRM')
    setErrors(next)
    if (next.reason || next.pin || next.confirm) return
    await oneTry(async () => {
      const outcome = await deciding.run((key) => decide({ taskId, decision, reason: reason.trim(), subjectInput, ...(stepUp ? { pin } : {}) }, key))
      setDecidePin('')
      if (outcome.ok) {
        setDialog(null)
        toast.success(decision === 'RETURN' ? t('task.decide.returned') : t('task.decide.rejected'))
      } else if (taskClosed(outcome)) {
        setDialog(null)
        stale.check(outcome)
      }
    })
  }

  if (stale.closed) {
    return (
      <section aria-label={t('decide.title')} className="flex flex-col gap-3">
        <Notice tone="danger">{stale.closed}</Notice>
      </section>
    )
  }

  return (
    <section
      ref={barRef}
      aria-labelledby={`${id}-title`}
      data-decision-bar=""
      className="fixed inset-x-0 bottom-0 z-30 flex max-h-[70dvh] flex-col gap-3 overflow-y-auto border-t border-line bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:left-(--sidebar-width-icon) lg:group-has-[[data-slot=sidebar][data-state=expanded]]/sidebar-wrapper:left-(--sidebar-width) xl:static xl:z-auto xl:max-h-none xl:overflow-visible xl:rounded-md xl:border xl:p-4"
    >
      <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
        {t('decide.title')}
      </h2>
      <dl className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <dt className="text-ink-muted">{t('decide.amount')}</dt>
          <dd className="money font-semibold text-ink">
            {amount} {t('unit')}
          </dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <dt className="text-ink-muted">{t('decide.flagged')}</dt>
          <dd className="tabular font-medium text-ink">{t('decide.flaggedValue', { count: flagged })}</dd>
        </div>
      </dl>
      {stepUp ? <StateLine kind="key">{tt('stepUpHint')}</StateLine> : null}
      {flagged > 0 ? (
        <div className="flex flex-col gap-1">
          <div className="flex min-h-11 items-center gap-3">
            <Checkbox
              id={`${id}-ack`}
              checked={acknowledged}
              onCheckedChange={(value) => {
                setAcknowledged(value === true)
                setAckError(false)
              }}
              aria-invalid={ackError || undefined}
              aria-describedby={`${id}-ack-hint${ackError ? ` ${id}-ack-error` : ''}`}
              className="size-5"
            />
            <Label htmlFor={`${id}-ack`} className="text-base font-medium text-ink">
              {t('decide.ack', { count: flagged })}
            </Label>
          </div>
          <p id={`${id}-ack-hint`} className="text-base text-ink-muted md:text-sm">
            {t('decide.ackHint')}
          </p>
          {ackError ? (
            <p id={`${id}-ack-error`} className="text-base text-danger md:text-sm">
              {t('decide.ackRequired')}
            </p>
          ) : null}
        </div>
      ) : null}
      {failureOf(approving.outcome)}
      {confirming ? (
        <form method="post" onSubmit={(event) => void approve(event)} noValidate>
          <div role="group" aria-labelledby={`${id}-confirm-text`} className="flex flex-col gap-2">
            <p id={`${id}-confirm-text`} className="font-medium text-ink">
              {t('task.decide.confirmText', { label, amount })}
            </p>
            {stepUp ? (
              <PinOtp
                id={`${id}-approve-pin`}
                label={tt('pin')}
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
                {approving.pending ? tt('working') : t('decide.confirm')}
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
                {t('decide.checkFirst')}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <Button onClick={startApproval} disabled={!hydrated} className="w-full">
          {t('decide.approve')}
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => openDialog('RETURN')} disabled={!hydrated} className="px-3">
          {t('decide.return')}
        </Button>
        {/* Rejecting sits at the far end, outlined in danger, never beside approve (§9.9) */}
        <Button variant="danger" onClick={() => openDialog('REJECT')} disabled={!hydrated} className="ml-auto px-3">
          {t('decide.reject')}
        </Button>
      </div>

      <AlertDialog open={dialog !== null} onOpenChange={(next) => (next ? null : setDialog(null))}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <form method="post" noValidate className="flex flex-col gap-4" onSubmit={(event) => void (dialog ? onDecide(event, dialog) : null)}>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-lg font-semibold text-ink">{dialog === 'RETURN' ? t('task.decide.returnOption') : t('decide.rejectOption')}</AlertDialogTitle>
              <AlertDialogDescription className="text-base text-ink-muted">{dialog === 'RETURN' ? t('task.decide.returnHint') : t('task.decide.rejectHint')}</AlertDialogDescription>
            </AlertDialogHeader>
            {failureOf(deciding.outcome)}
            <TextArea
              id={`${id}-reason`}
              name="reason"
              label={tt('reason')}
              hint={t('task.decide.reasonHint')}
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
              <PinOtp
                id={`${id}-decide-pin`}
                label={tt('pin')}
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
              label={tt('confirmDecision')}
              checked={confirmed}
              onChange={(checked) => {
                setConfirmed(checked)
                setErrors((e) => ({ ...e, confirm: undefined }))
              }}
              error={errors.confirm}
            />
            <AlertDialogFooter className="gap-3">
              <AlertDialogCancel className="h-11 px-4 text-base" disabled={deciding.pending}>
                {t('decide.cancel')}
              </AlertDialogCancel>
              <Button type="submit" variant={dialog === 'REJECT' ? 'danger' : 'primary'} disabled={deciding.pending || !hydrated} aria-busy={deciding.pending || undefined}>
                {deciding.pending ? tt('working') : dialog === 'RETURN' ? t('decide.submitReturn') : t('task.decide.submitReject')}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
