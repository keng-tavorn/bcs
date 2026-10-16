'use client'

import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { ConfirmDialog } from './confirm-dialog'
import type { PayAction } from './types'
import { usePayAction, usePayErrorText } from './use-pay-action'

// Sending a draft run for approval and cancelling it (S9-09, FR-PAY-101 AC4 AC9, BR-PAY-08 BR-PAY-09): its preparer's
// own buttons. "ส่งขออนุมัติ" is the one primary button; the service checks the date, the suppliers' accounts and the
// reasons of the flags again, numbers the run and routes it under DOA PAYMENT_RUN, and a refusal is said next to the
// button in words. Cancelling (a draft, or a run still waiting for its approver) asks for a reason first and stands
// apart, outlined in danger (§9.9).

export function DraftActions({
  paymentRunId,
  version,
  mayEdit,
  mayCancel,
  reasonsMissing,
  actions,
}: {
  paymentRunId: string
  version: number
  /** A draft: it can be sent */
  mayEdit: boolean
  mayCancel: boolean
  /** Items whose flags still need the preparer's reason */
  reasonsMissing: number
  actions: { readonly submit: PayAction; readonly cancelDraft: PayAction }
}) {
  const t = useTranslations('payRun.draft')
  const errorText = usePayErrorText()
  const submit = usePayAction()

  async function onSubmit() {
    const outcome = await submit.run((key) => actions.submit({ paymentRunId, version }, key))
    if (outcome.ok) toast.success(t('submitted', { number: outcome.number ?? '-' }))
  }

  return (
    <div className="flex flex-col gap-3">
      {mayEdit ? (
        <>
          <p className="text-ink-muted">{t('hint')}</p>
          {reasonsMissing > 0 ? <Notice tone="warning">{t('reasonsMissing', { count: reasonsMissing })}</Notice> : null}
          <Button className="self-start" disabled={submit.pending} aria-busy={submit.pending || undefined} onClick={() => void onSubmit()}>
            {submit.pending ? t('submitting') : t('submit')}
          </Button>
          {submit.outcome && !submit.outcome.ok ? <Notice tone="danger">{errorText(submit.outcome)}</Notice> : null}
        </>
      ) : null}
      {mayCancel ? (
        <div className={mayEdit ? 'mt-2 border-t border-line pt-4' : undefined}>
          <ConfirmDialog
            trigger={t('cancel')}
            title={t('cancelTitle')}
            hint={t('cancelHint')}
            confirm={t('cancelConfirm')}
            busy={t('cancelBusy')}
            done={() => t('cancelled')}
            reason
            danger
            run={(values, key) => actions.cancelDraft({ paymentRunId, version, reason: values.reason }, key)}
          />
        </div>
      ) : null}
    </div>
  )
}
