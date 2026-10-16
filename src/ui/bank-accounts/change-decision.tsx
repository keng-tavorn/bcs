'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { PinOtp } from '../document/pin-otp'
import { ConfirmBox, TextArea } from '../request-view/text-area'
import { StateLine } from '../request-view/status'
import { useAction } from '../request-view/use-action'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { useBarSpace } from '../tasks/bar-space'
import { pinRefused, taskClosed, TaskFailure, useClosedTask, useFocusPinAfterRefusal, useOneTry, useTaskFailureText, type TaskDecisionInput } from '../tasks/decision-panel'
import { PIN_FIELD_KEYS, taskErrorKey, type ActionOutcome } from '../tasks/outcome'
import { pinIsComplete } from '../tasks/pin-field'

// The approver's decision on a request to change a bank account (S9-09, FR-PAY-102 AC7, BR-DOA-25, BR-SUP-06): the
// decision bar of the document page (src/ui/document/decision-bar.tsx) with the words of this subject and the PIN every
// time — whatever the amount, since an account has none (ALWAYS_STEP_UP_SUBJECTS) — and no chat button anywhere.
// "อนุมัติ" is the one primary button and asks for a second press that names the request and what approving does (the
// account comes into force at once); "ตีกลับให้แก้" and, at the far end outlined in danger, "ไม่อนุมัติ" open an Alert
// Dialog with the reason the proposer reads, the PIN and a tick, since neither can be undone. Every decision goes to the
// same server action and service as the task page (/tasks/[id]): they check the assignee, the task's state, separation of
// duties (the proposer never approves, BR-SOD-05) and the PIN again, so this bar is never the guard. On phones the bar
// is fixed to the bottom of the screen and the page keeps room for it (useBarSpace).

const REASON_MIN = 3

type Dialog = 'RETURN' | 'REJECT' | null

export function ChangeDecision({
  taskId,
  label,
  kind,
  locale,
  facts,
  decide,
}: {
  taskId: string
  /** The request's number and what it does, named in the approval's confirmation */
  label: string
  kind: 'ADD' | 'REPLACE' | 'CLOSE'
  locale: string
  /** What the decision rests on, already in words: whose account, the old and the new (masked) */
  facts: ReadonlyArray<{ readonly label: string; readonly value: string }>
  decide: (input: TaskDecisionInput, idempotencyKey: string) => Promise<ActionOutcome>
}) {
  const t = useTranslations('bankAccount.decide')
  const tt = useTranslations('tasks.decide')
  const tErrors = useTranslations('tasks.errors')
  const failureText = useTaskFailureText(locale)
  const stale = useClosedTask(locale)
  const id = useId()
  const approving = useAction()
  const deciding = useAction()
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
    setDialog(which)
  }

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const pin = approvePin
    if (!pinIsComplete(pin)) return setApprovePinError(tErrors('PIN'))
    setApprovePinError(undefined)
    await oneTry(async () => {
      const outcome = await approving.run((key) => decide({ taskId, decision: 'APPROVE', pin }, key))
      setApprovePin('')
      if (!outcome.ok && pinRefused(outcome)) return
      setConfirming(false)
      if (outcome.ok) toast.success(t('approved'))
      else stale.check(outcome)
    })
  }

  async function onDecide(event: FormEvent<HTMLFormElement>, decision: 'RETURN' | 'REJECT') {
    event.preventDefault()
    const pin = decidePin
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = t('reasonError')
    if (!pinIsComplete(pin)) next.pin = tErrors('PIN')
    if (!confirmed) next.confirm = tErrors('CONFIRM')
    setErrors(next)
    if (next.reason || next.pin || next.confirm) return
    await oneTry(async () => {
      const outcome = await deciding.run((key) => decide({ taskId, decision, reason: reason.trim(), pin }, key))
      setDecidePin('')
      if (outcome.ok) {
        setDialog(null)
        toast.success(decision === 'RETURN' ? t('returned') : t('rejected'))
      } else if (taskClosed(outcome)) {
        setDialog(null)
        stale.check(outcome)
      }
    })
  }

  if (stale.closed) {
    return (
      <section aria-label={tt('title')} className="flex flex-col gap-3">
        <Notice tone="danger">{stale.closed}</Notice>
      </section>
    )
  }

  return (
    <section
      ref={barRef}
      aria-labelledby={`${id}-title`}
      data-decision-bar=""
      className="fixed inset-x-0 bottom-0 z-30 flex max-h-[80dvh] flex-col gap-3 overflow-y-auto border-t border-line bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:left-(--sidebar-width-icon) lg:group-has-[[data-slot=sidebar][data-state=expanded]]/sidebar-wrapper:left-(--sidebar-width) xl:static xl:z-auto xl:max-h-none xl:overflow-visible xl:rounded-md xl:border xl:p-4"
    >
      <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
        {t('title')}
      </h2>
      <dl className="hidden flex-col gap-1 xl:flex">
        {facts.map((f) => (
          <div key={f.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-ink-muted">{f.label}</dt>
            <dd className="tabular font-medium break-words text-ink">{f.value}</dd>
          </div>
        ))}
      </dl>
      <StateLine kind="key">{t('stepUpHint')}</StateLine>
      {failureOf(approving.outcome)}
      {confirming ? (
        <form method="post" onSubmit={(event) => void approve(event)} noValidate>
          <div role="group" aria-labelledby={`${id}-confirm-text`} className="flex flex-col gap-2">
            <p id={`${id}-confirm-text`} className="font-medium text-ink">
              {t(`confirmText.${kind}`, { label })}
            </p>
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
            <div className="flex gap-3">
              <Button type="submit" disabled={approving.pending || !hydrated} aria-busy={approving.pending || undefined} className="flex-1">
                {approving.pending ? tt('working') : tt('confirm')}
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
                {tt('checkFirst')}
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
        <Button variant="secondary" onClick={() => openDialog('RETURN')} disabled={!hydrated} className="px-3">
          {t('returnOption')}
        </Button>
        {/* Rejecting sits at the far end, outlined in danger, never beside approve (§9.9) */}
        <Button variant="danger" onClick={() => openDialog('REJECT')} disabled={!hydrated} className="ml-auto px-3">
          {t('rejectOption')}
        </Button>
      </div>

      <AlertDialog open={dialog !== null} onOpenChange={(next) => (next ? null : setDialog(null))}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <form method="post" noValidate className="flex flex-col gap-4" onSubmit={(event) => void (dialog ? onDecide(event, dialog) : null)}>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-lg font-semibold text-ink">{dialog === 'RETURN' ? t('returnOption') : t('rejectOption')}</AlertDialogTitle>
              <AlertDialogDescription className="text-base text-ink-muted">{dialog === 'RETURN' ? t('returnHint') : t('rejectHint')}</AlertDialogDescription>
            </AlertDialogHeader>
            {failureOf(deciding.outcome)}
            <TextArea
              id={`${id}-reason`}
              name="reason"
              label={tt('reason')}
              hint={t('reasonHint')}
              value={reason}
              onChange={(event) => {
                setReason(event.currentTarget.value)
                setErrors((e) => ({ ...e, reason: undefined }))
              }}
              error={errors.reason}
              maxLength={REASON_MAX_LENGTH}
              required
            />
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
                {t('back')}
              </AlertDialogCancel>
              <Button type="submit" variant={dialog === 'REJECT' ? 'danger' : 'primary'} disabled={deciding.pending || !hydrated} aria-busy={deciding.pending || undefined}>
                {deciding.pending ? tt('working') : dialog === 'RETURN' ? t('submitReturn') : t('submitReject')}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
