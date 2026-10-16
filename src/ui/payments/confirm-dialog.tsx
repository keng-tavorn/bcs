'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { TextArea } from '../request-view/text-area'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { Checkbox } from '../shadcn/checkbox'
import { Label } from '../shadcn/label'
import type { PayOutcome } from './outcome'
import { usePayAction, usePayErrorText } from './use-pay-action'

// A button that asks before an action on a payment run that cannot be undone (§9.9: no irreversible action without a
// confirmation; §9.10 Alert Dialog): cancel a run, make its file again, mark it sent to the bank or take that back, take
// a document out, send a payment advice again. The box opens only when the member presses the button (NG-13). It asks
// for the reason when the rule needs one, and — when a file of the run was downloaded — for the word that it was not sent
// to the bank (BR-BANK-07, BR-PAY-10, OQ-136). A refusal is said inside the box; the result is a toast and the page
// refreshes (§9.10 ข้อความแจ้งผล).

const REASON_MIN = 3

export interface ConfirmValues {
  readonly reason: string
  readonly confirmNotSentToBank: boolean
}

export function ConfirmDialog({
  trigger,
  title,
  hint,
  body,
  confirm,
  busy,
  done,
  reason = false,
  notSent = false,
  danger = false,
  triggerVariant,
  disabled = false,
  run,
}: {
  trigger: string
  title: string
  hint: string
  /** More of what will happen, under the hint */
  body?: ReactNode
  confirm: string
  busy: string
  /** What the toast says once it went through */
  done: (outcome: Extract<PayOutcome, { ok: true }>) => string
  /** The rule needs a reason */
  reason?: boolean
  /** A file was downloaded: the member says it was not sent to the bank */
  notSent?: boolean
  danger?: boolean
  triggerVariant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  run: (values: ConfirmValues, idempotencyKey: string) => Promise<PayOutcome>
}) {
  const t = useTranslations('payRun.dialog')
  const errorText = usePayErrorText()
  const action = usePayAction()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; notSent?: string }>({})

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setText('')
      setConfirmed(false)
      setErrors({})
      action.clear()
    }
  }

  async function onConfirm() {
    const next: typeof errors = {}
    if (reason && text.trim().length < REASON_MIN) next.reason = t('reasonRequired')
    if (notSent && !confirmed) next.notSent = t('notSentRequired')
    setErrors(next)
    if (next.reason || next.notSent) return
    const outcome = await action.run((key) => run({ reason: text.trim(), confirmNotSentToBank: notSent && confirmed }, key))
    if (outcome.ok) {
      setOpen(false)
      toast.success(done(outcome))
    }
  }

  const failure = action.outcome && !action.outcome.ok ? errorText(action.outcome) : null
  return (
    <>
      <Button variant={triggerVariant ?? (danger ? 'danger' : 'secondary')} className="self-start" disabled={disabled} onClick={() => onOpenChange(true)}>
        {trigger}
      </Button>
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <form
            method="post"
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void onConfirm()
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle className="text-lg font-semibold text-ink">{title}</AlertDialogTitle>
              <AlertDialogDescription className="text-base text-ink-muted">{hint}</AlertDialogDescription>
            </AlertDialogHeader>
            {body}
            {reason ? (
              <TextArea
                id={`${id}-reason`}
                name="reason"
                label={t('reason')}
                value={text}
                maxLength={REASON_MAX_LENGTH}
                onChange={(event) => {
                  setText(event.currentTarget.value)
                  setErrors((e) => ({ ...e, reason: undefined }))
                }}
                error={errors.reason}
                required
              />
            ) : null}
            {notSent ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex min-h-11 items-center gap-3">
                  <Checkbox
                    id={`${id}-not-sent`}
                    checked={confirmed}
                    onCheckedChange={(value) => {
                      setConfirmed(value === true)
                      setErrors((e) => ({ ...e, notSent: undefined }))
                    }}
                    aria-invalid={errors.notSent ? true : undefined}
                    aria-describedby={errors.notSent ? `${id}-not-sent-error` : undefined}
                    className="size-5"
                  />
                  <Label htmlFor={`${id}-not-sent`} className="text-base font-normal text-ink">
                    {t('notSent')}
                  </Label>
                </div>
                {errors.notSent ? (
                  <p id={`${id}-not-sent-error`} className="text-base text-danger md:text-sm">
                    {errors.notSent}
                  </p>
                ) : null}
              </div>
            ) : null}
            {failure ? <Notice tone="danger">{failure}</Notice> : null}
            <AlertDialogFooter className="gap-3">
              <AlertDialogCancel className="h-11 px-4 text-base" disabled={action.pending}>
                {t('back')}
              </AlertDialogCancel>
              <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={action.pending} aria-busy={action.pending || undefined}>
                {action.pending ? busy : confirm}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
