'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useOutcomeAction } from '../procurement/use-outcome-action'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { Label } from '../shadcn/label'
import { Textarea } from '../shadcn/textarea'
import { Refusal } from './failure'
import { PO_S8_NO_ANSWER, type PoS8Outcome } from './outcome'

// What procurement does with the PO's open change (FR-AP-107, BR-POC-02): a draft is sent ("ส่งใบแก้ไข" →
// po_change.submit: to DOA PO_CHANGE, or approved at once when only the date or the notes change) or cancelled; a change
// waiting for approval is cancelled. Cancelling gives back what the change reserved and closes its task, so it asks
// first with a reason (§9.9: nothing irreversible without a confirmation, never a dialog on a dialog).

export interface OpenChangeActionsProps {
  readonly change: { readonly id: string; readonly version: number; readonly changeNo: number; readonly status: string; readonly autoApproved: boolean }
  readonly actions: {
    readonly submit: (input: { poChangeId: string; version: number }, idempotencyKey: string) => Promise<PoS8Outcome>
    readonly cancel: (input: { poChangeId: string; version: number; reason: string }, idempotencyKey: string) => Promise<PoS8Outcome>
  }
}

export function OpenChangeActions({ change, actions }: OpenChangeActionsProps) {
  const t = useTranslations('poChange.open')
  const id = useId()
  const submit = useOutcomeAction<PoS8Outcome>(PO_S8_NO_ANSWER)
  const cancel = useOutcomeAction<PoS8Outcome>(PO_S8_NO_ANSWER)
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonMissing, setReasonMissing] = useState(false)
  const busy = submit.pending || cancel.pending
  const submitted = submit.outcome?.ok ? (submit.outcome.status === 'APPROVED' ? t('approved') : t('submitted')) : null

  async function onCancel() {
    if (!reason.trim()) return setReasonMissing(true)
    setReasonMissing(false)
    const outcome = await cancel.run((key) => actions.cancel({ poChangeId: change.id, version: change.version, reason: reason.trim() }, key))
    if (outcome.ok || outcome.code !== 'NO_ANSWER') setAsking(false)
  }

  return (
    <div className="flex flex-col gap-3">
      {submit.outcome && !submit.outcome.ok ? <Refusal failure={submit.outcome} /> : null}
      {cancel.outcome && !cancel.outcome.ok ? <Refusal failure={cancel.outcome} /> : null}
      {submitted ? <Notice tone="success">{submitted}</Notice> : null}
      {cancel.outcome?.ok ? <Notice tone="success">{t('cancelled')}</Notice> : null}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {change.status === 'DRAFT' ? (
          <Button disabled={busy} onClick={() => void submit.run((key) => actions.submit({ poChangeId: change.id, version: change.version }, key))}>
            {submit.pending ? t('working') : t('submit')}
          </Button>
        ) : null}
        <Button variant="danger" disabled={busy} onClick={() => setAsking(true)}>
          {t('cancel')}
        </Button>
      </div>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cancelTitle', { no: change.changeNo })}</AlertDialogTitle>
            <AlertDialogDescription>{t('cancelBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-reason`} className="text-base md:text-sm">
              {t('cancelReason')}
            </Label>
            <Textarea
              id={`${id}-reason`}
              className="text-base"
              rows={3}
              maxLength={REASON_MAX_LENGTH}
              value={reason}
              aria-invalid={reasonMissing ? true : undefined}
              onChange={(e) => setReason(e.target.value)}
            />
            {reasonMissing ? <Notice tone="danger">{t('cancelReasonMissing')}</Notice> : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 text-base">{t('cancelKeep')}</AlertDialogCancel>
            <Button variant="danger" disabled={cancel.pending} onClick={() => void onCancel()}>
              {cancel.pending ? t('working') : t('cancelConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
