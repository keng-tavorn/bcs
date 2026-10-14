'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useHydrated } from '../form/hydrated'
import { useSubmissionKey } from '../form/submission-key'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { moneyText } from './format'
import type { TransferFormActions } from './transfer-form'
import { transferErrorKey, type TransferFailure } from './transfer-outcome'

const NO_ANSWER: TransferFailure = { ok: false, code: 'NO_ANSWER' }

// What the sender of a budget transfer does on its page (S6-15 · FR-BUD-103): send it again while it is a draft or
// returned — the source reserves the amount again, or the refusal says why (BUDGET_INSUFFICIENT with the shortfall,
// DOA_NOT_CONFIGURED) — and cancel it until it is decided, which cannot be undone, so it asks first in an Alert Dialog
// opened only by the press (NG-13). Each command carries its own idempotency key (spec §4.3); the services check the
// sender and the state again.
export function TransferActions({
  transferId,
  label,
  send,
  cancel,
  actions,
}: {
  transferId: string
  /** The transfer's number, or "ร่าง…" while it has none: named in the confirmation */
  label: string
  send: boolean
  cancel: boolean
  actions: Pick<TransferFormActions, 'submit' | 'cancel'>
}) {
  const t = useTranslations('budgetTransfer')
  const router = useRouter()
  const hydrated = useHydrated()
  const sendKey = useSubmissionKey()
  const cancelKey = useSubmissionKey()
  const [pending, setPending] = useState<'send' | 'cancel' | null>(null)
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [cancelFailure, setCancelFailure] = useState<string | null>(null)

  const failureText = (f: TransferFailure) =>
    t(`errors.${f.code === 'NO_ANSWER' ? 'FAILED' : transferErrorKey(f)}`, { shortfall: f.shortfall ? moneyText({ amount: f.shortfall }) : '', requestId: f.requestId ?? '-' })

  async function onSend() {
    if (pending) return
    setPending('send')
    setResult(null)
    try {
      const outcome = await actions.submit(transferId, sendKey.key).catch(() => NO_ANSWER)
      // No answer: the same key goes with a retry, so it is sent at most once
      if (outcome.ok || outcome.code !== 'NO_ANSWER') sendKey.next()
      if (!outcome.ok) return setResult({ tone: 'danger', text: failureText(outcome) })
      setResult({ tone: 'success', text: t('actions.sent', { number: outcome.number }) })
      router.refresh()
    } finally {
      setPending(null)
    }
  }

  async function onCancel() {
    if (pending) return
    setPending('cancel')
    setCancelFailure(null)
    try {
      const outcome = await actions.cancel(transferId, cancelKey.key).catch(() => NO_ANSWER)
      if (outcome.ok || outcome.code !== 'NO_ANSWER') cancelKey.next()
      if (!outcome.ok) return setCancelFailure(failureText(outcome))
      setOpen(false)
      setResult({ tone: 'success', text: t('actions.cancelled') })
      router.refresh()
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
      {send || cancel ? (
        <div role="group" aria-label={t('actions.label')} className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {send ? (
            <Button onClick={() => void onSend()} disabled={!hydrated || pending !== null} aria-busy={pending === 'send' || undefined}>
              {pending === 'send' ? t('actions.sending') : t('actions.send')}
            </Button>
          ) : null}
          {cancel ? (
            <Button variant="danger" onClick={() => setOpen(true)} disabled={!hydrated || pending !== null}>
              {t('actions.cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && pending !== 'cancel') {
            setOpen(false)
            setCancelFailure(null)
          }
        }}
      >
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold text-ink">{t('actions.cancelTitle', { label })}</AlertDialogTitle>
            <AlertDialogDescription className="text-base text-ink-muted">{t('actions.cancelText')}</AlertDialogDescription>
          </AlertDialogHeader>
          {cancelFailure ? <Notice tone="danger">{cancelFailure}</Notice> : null}
          <AlertDialogFooter className="gap-3">
            <AlertDialogCancel className="h-11 px-4 text-base" disabled={pending === 'cancel'}>
              {t('actions.cancelKeep')}
            </AlertDialogCancel>
            <Button variant="danger" onClick={() => void onCancel()} disabled={pending === 'cancel'} aria-busy={pending === 'cancel' || undefined}>
              {pending === 'cancel' ? t('actions.cancelling') : t('actions.cancelConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
