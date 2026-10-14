'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { overrunErrorKey, type OverrunFailure, type OverrunOutcome } from './overrun-model'

const NO_ANSWER: OverrunFailure = { ok: false, code: 'NO_ANSWER' }

export type CancelOverrun = (overrunId: string, idempotencyKey: string) => Promise<OverrunOutcome<{ overrunId: string }>>

// The requester cancels their over-budget approval (S6-16 · FR-BUD-101 · §6.4) while it waits — its open task closes —
// or once approved before the request's submit uses it — what it funded leaves the budget line at once (BR-BUD-15). It
// cannot be undone, so it asks first in an Alert Dialog opened only by the press (NG-13); the confirmation names the
// OB number and says what happens to the money. Kept for the requester whatever the state, so the words of what was
// just done stay after the page refreshes (§9.9 rule 7). The service checks who asked and the state again.
export function OverrunCancel({ overrunId, number, cancel, approved, action }: { overrunId: string; number: string; /** Offered now */ cancel: boolean; /** Approved and not used: the funded amount leaves the line */ approved: boolean; action: CancelOverrun }) {
  const t = useTranslations('budgetOverrun')
  const router = useRouter()
  const hydrated = useHydrated()
  const cancelKey = useSubmissionKey()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function onCancel() {
    if (pending) return
    setPending(true)
    setFailure(null)
    try {
      const outcome = await action(overrunId, cancelKey.key).catch(() => NO_ANSWER)
      if (outcome.ok || outcome.code !== 'NO_ANSWER') cancelKey.next()
      if (!outcome.ok) return setFailure(t(`errors.${outcome.code === 'NO_ANSWER' ? 'FAILED' : overrunErrorKey(outcome)}`, { requestId: outcome.requestId ?? '-' }))
      setOpen(false)
      setDone(true)
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  if (!cancel && !done) return null
  return (
    <div className="flex flex-col gap-3">
      {done ? <Notice tone="success">{t('cancel.done', { number })}</Notice> : null}
      {cancel ? (
        <Button variant="danger" onClick={() => setOpen(true)} disabled={!hydrated || pending} className="self-start">
          {t('cancel.button', { number })}
        </Button>
      ) : null}
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !pending) {
            setOpen(false)
            setFailure(null)
          }
        }}
      >
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold text-ink">{t('cancel.title', { number })}</AlertDialogTitle>
            <AlertDialogDescription className="text-base text-ink-muted">{approved ? t('cancel.textApproved') : t('cancel.textPending')}</AlertDialogDescription>
          </AlertDialogHeader>
          {failure ? <Notice tone="danger">{failure}</Notice> : null}
          <AlertDialogFooter className="gap-3">
            <AlertDialogCancel className="h-11 px-4 text-base" disabled={pending}>
              {t('cancel.keep')}
            </AlertDialogCancel>
            <Button variant="danger" onClick={() => void onCancel()} disabled={pending} aria-busy={pending || undefined}>
              {pending ? t('cancel.cancelling') : t('cancel.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
