'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { NoteField } from './fields'
import type { BankOutcome } from './outcome'
import { useBankAction, useBankErrorText } from './use-bank-action'

// "ยกเลิกคำขอ" of the proposer (S9-09, FR-PAY-102 AC7): a draft, or a request waiting for approval (its task closes). It
// cannot be undone, so it is confirmed in an Alert Dialog that opens only when the button is pressed (NG-13), with the
// reason every reader of the request will see (kept as a comment, never with an account number). Outlined in danger, so
// it never looks like the main action; a refusal stays in the dialog, next to the reason (§9.9).

const MIN_TEXT = 3

export function CancelChange({ changeId, version, cancel }: { changeId: string; version: number; cancel: (input: unknown, idempotencyKey: string) => Promise<BankOutcome> }) {
  const t = useTranslations('bankAccount.cancel')
  const errorText = useBankErrorText()
  const hydrated = useHydrated()
  const action = useBankAction()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [missing, setMissing] = useState(false)

  async function onConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (reason.trim().length < MIN_TEXT) return setMissing(true)
    setMissing(false)
    const outcome = await action.run((key) => cancel({ changeId, version, reason }, key))
    if (outcome.ok) {
      setOpen(false)
      setReason('')
      toast.success(t('done'))
    }
  }

  const failure = action.outcome && !action.outcome.ok ? errorText(action.outcome) : null
  return (
    <>
      <Button variant="danger" className="self-start" disabled={!hydrated} onClick={() => setOpen(true)}>
        {t('open')}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) {
            setMissing(false)
            action.clear()
          }
        }}
      >
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <form method="post" noValidate className="flex flex-col gap-4" onSubmit={(e) => void onConfirm(e)}>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-lg font-semibold text-ink">{t('title')}</AlertDialogTitle>
              <AlertDialogDescription className="text-base text-ink-muted">{t('hint')}</AlertDialogDescription>
            </AlertDialogHeader>
            <NoteField
              id={`${id}-reason`}
              label={t('reason')}
              hint={t('reasonHint')}
              maxLength={REASON_MAX_LENGTH}
              value={reason}
              onChange={(e) => {
                setReason(e.currentTarget.value)
                setMissing(false)
              }}
              error={missing ? t('reasonShort') : undefined}
            />
            {failure ? <Notice tone="danger">{failure}</Notice> : null}
            <AlertDialogFooter className="gap-3">
              <AlertDialogCancel className="h-11 px-4 text-base" disabled={action.pending}>
                {t('back')}
              </AlertDialogCancel>
              <Button type="submit" variant="danger" disabled={action.pending || !hydrated} aria-busy={action.pending || undefined}>
                {action.pending ? t('working') : t('confirm')}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
