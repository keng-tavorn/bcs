'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { Button } from '../../form/button'
import { Notice } from '../../form/notice'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../shadcn/alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../shadcn/dialog'
import { Label } from '../../shadcn/label'
import { Textarea } from '../../shadcn/textarea'
import type { ApOutcome } from './outcome'
import { useApAction, useApErrorText } from './use-ap-action'

const REASON_MAX = 500

/**
 * A button that opens a box asking for a reason before an action on an invoice (FR-AP-103 AC2): ask for a variance
 * approval, dismiss a possible duplicate, reject, discard a draft. An action that cannot be undone (reject, discard) is
 * an AlertDialog; the others a Dialog. The box opens only when the member presses the button (NG-13). The words of the
 * button and the box say what will happen (§9.9 rule 7); a refusal is said inside the box, next to the reason.
 */
export function ReasonDialog({
  trigger,
  title,
  hint,
  confirm,
  busy,
  done,
  irreversible = false,
  danger = false,
  run,
}: {
  trigger: string
  title: string
  hint: string
  confirm: string
  busy: string
  /** What the page says once it went through */
  done: (outcome: Extract<ApOutcome, { ok: true }>) => string
  irreversible?: boolean
  danger?: boolean
  run: (reason: string, idempotencyKey: string) => Promise<ApOutcome>
}) {
  const t = useTranslations('apInvoice')
  const errorText = useApErrorText()
  const action = useApAction()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [missing, setMissing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function onConfirm() {
    if (!reason.trim()) return setMissing(true)
    setMissing(false)
    const outcome = await action.run((key) => run(reason, key))
    if (outcome.ok) {
      setMessage(done(outcome))
      setReason('')
      setOpen(false)
    }
  }

  const failure = action.outcome && !action.outcome.ok ? errorText(action.outcome) : null
  const errorId = `${id}-error`
  const body = (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-reason`} className="text-base text-ink">
        {t('dialog.reason')}
      </Label>
      <Textarea
        id={`${id}-reason`}
        value={reason}
        maxLength={REASON_MAX}
        onChange={(e) => setReason(e.target.value)}
        aria-invalid={missing || undefined}
        aria-describedby={missing ? errorId : undefined}
        className="min-h-24 text-base"
      />
      {missing ? (
        <p id={errorId} className="text-base text-danger md:text-sm">
          {t('dialog.reasonRequired')}
        </p>
      ) : null}
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
    </div>
  )
  const confirmButton = (
    <Button variant={danger ? 'danger' : 'primary'} disabled={action.pending} aria-busy={action.pending || undefined} onClick={() => void onConfirm()}>
      {action.pending ? busy : confirm}
    </Button>
  )
  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setMessage(null)
      setMissing(false)
      action.clear()
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant={danger ? 'danger' : 'secondary'} className="self-start" onClick={() => onOpenChange(true)}>
        {trigger}
      </Button>
      {message ? (
        <p role="status" className="text-ink">
          {message}
        </p>
      ) : null}
      {irreversible ? (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
          <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-lg font-semibold text-ink">{title}</AlertDialogTitle>
              <AlertDialogDescription className="text-base text-ink-muted">{hint}</AlertDialogDescription>
            </AlertDialogHeader>
            {body}
            <AlertDialogFooter className="gap-3">
              <AlertDialogCancel className="h-11 px-4 text-base" disabled={action.pending}>
                {t('dialog.back')}
              </AlertDialogCancel>
              {confirmButton}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-lg font-semibold text-ink">{title}</DialogTitle>
              <DialogDescription className="text-base text-ink-muted">{hint}</DialogDescription>
            </DialogHeader>
            {body}
            <DialogFooter className="gap-3">
              <Button variant="secondary" disabled={action.pending} onClick={() => setOpen(false)}>
                {t('dialog.back')}
              </Button>
              {confirmButton}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
