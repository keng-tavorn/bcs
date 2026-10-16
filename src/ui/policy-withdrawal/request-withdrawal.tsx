'use client'

import { Undo2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { failureKey, type ActionFailure } from '../admin-org/outcome'
import { errorValues, useAction } from '../admin-org/use-action'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { TextArea } from '../request-view/text-area'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'

// Asking to withdraw a DOA or workflow version approved but not yet in effect (FR-DOA-104 AC1 · FR-WF-103, S6-07): the
// button opens an Alert Dialog — only when pressed (NG-13) — that says what happens next and asks for the reason, which
// the approver reads before deciding. The reason is required (3 characters at least, checked here and by the service);
// a refusal is said in the dialog in words with what to do (§9.9 rule 7): a withdrawal waiting already, a version not
// approved or in effect already, no approver. Sent, the page reads the version again and says the withdrawal waits.

export type RequestWithdrawalResult = { readonly ok: true } | ActionFailure
export type RequestWithdrawalAction = (input: { versionId: string; reason: string }, idempotencyKey: string) => Promise<RequestWithdrawalResult>

const REASONS = ['WITHDRAWAL_PENDING', 'NOT_PUBLISHED', 'ALREADY_EFFECTIVE', 'NO_DEPARTMENT', 'SOD_VIOLATION'] as const
const REASON_MIN = 3

export function RequestWithdrawal({ versionId, versionName, request }: { versionId: string; versionName: string; request: RequestWithdrawalAction }) {
  const t = useTranslations('policyWithdrawal')
  const id = useId()
  const action = useAction()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | undefined>()
  const [failure, setFailure] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    const trimmed = reason.trim()
    const problem = trimmed.length < REASON_MIN ? t('reasonRequired') : trimmed.length > REASON_MAX_LENGTH ? t('reasonTooLong', { max: REASON_MAX_LENGTH }) : undefined
    setReasonError(problem)
    if (problem) return
    const outcome = await action.run((key) => request({ versionId, reason: trimmed }, key))
    if (outcome.ok) {
      setOpen(false)
      setSent(true)
      // The page reads the version again: the withdrawal waits, with who asked and why
      action.done()
      return
    }
    if (outcome.code === 'VALIDATION_FAILED' && outcome.field === 'reason') return setReasonError(t('reasonRequired'))
    setFailure(t(`errors.${failureKey(outcome, REASONS)}`, errorValues(outcome)))
  }

  if (sent) return <Notice tone="success">{t('sent')}</Notice>

  return (
    <>
      <Button variant="secondary" className="self-start" onClick={() => setOpen(true)}>
        <Undo2 className="size-4 shrink-0" aria-hidden="true" />
        {t('open')}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => (next ? null : setOpen(false))}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <form method="post" noValidate className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-lg font-semibold text-ink">{t('dialogTitle', { name: versionName })}</AlertDialogTitle>
              <AlertDialogDescription className="text-base text-ink-muted">{t('dialogText')}</AlertDialogDescription>
            </AlertDialogHeader>
            {failure ? <Notice tone="danger">{failure}</Notice> : null}
            <TextArea
              id={`${id}-reason`}
              name="reason"
              label={t('reason')}
              hint={t('reasonHint')}
              value={reason}
              onChange={(event) => {
                setReason(event.currentTarget.value)
                setReasonError(undefined)
              }}
              error={reasonError}
              maxLength={REASON_MAX_LENGTH}
              required
            />
            <AlertDialogFooter className="gap-3">
              <AlertDialogCancel className="h-11 px-4 text-base" disabled={action.pending}>
                {t('cancel')}
              </AlertDialogCancel>
              <Button type="submit" disabled={action.pending} aria-busy={action.pending || undefined}>
                {action.pending ? t('sending') : t('submit')}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
