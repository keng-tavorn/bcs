'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../../form/button'
import { Notice } from '../../form/notice'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../shadcn/alert-dialog'
import type { ApInvoiceActions, ApOutcome } from './outcome'
import { ReasonDialog } from './reason-dialog'
import { useApAction, useApErrorText } from './use-ap-action'

/**
 * The ways to settle an invoice the match did not pass (FR-AP-103 AC2, BR-MATCH-10), each shown only to the member
 * whose role may take it (the service checks again): check again (FINANCE or whoever a difference is sent to); ask for a
 * price variance approval when every open difference is a price over (PROCUREMENT, FR-AP-105 AC2); dismiss a possible
 * duplicate with a reason, reopen as a draft, reject with a reason (FINANCE; reject also PROCUREMENT). Reopen and reject
 * are confirmed first, reject in danger and apart from the others (§9.9).
 */
export function ExceptionActions({
  invoiceId,
  version,
  may,
  duplicates,
  actions,
}: {
  invoiceId: string
  version: number
  may: { readonly recheck: boolean; readonly variance: boolean; readonly dismiss: boolean; readonly reopen: boolean; readonly reject: boolean }
  /** The open possible-duplicate differences, each dismissed on its own */
  duplicates: readonly string[]
  actions: Pick<ApInvoiceActions, 'recheck' | 'variance' | 'dismiss' | 'reopen' | 'reject'>
}) {
  const t = useTranslations('apInvoice')
  const errorText = useApErrorText()
  const recheck = useApAction()
  const reopen = useApAction()
  const [reopenOpen, setReopenOpen] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const statusText = (o: Extract<ApOutcome, { ok: true }>) => (o.status === 'READY_FOR_PAYMENT' || o.status === 'EXCEPTION' || o.status === 'PENDING_APPROVAL' ? t(`results.${o.status}`) : t('results.EXCEPTION'))

  async function onRecheck() {
    setResult(null)
    const o = await recheck.run((key) => actions.recheck({ invoiceId, version }, key))
    if (o.ok) setResult(statusText(o))
  }
  async function onReopen() {
    const o = await reopen.run((key) => actions.reopen({ invoiceId, version }, key))
    if (o.ok) {
      setReopenOpen(false)
      setResult(t('results.reopened'))
    }
  }

  if (!may.recheck && !may.variance && !may.dismiss && !may.reopen && !may.reject) return null
  return (
    <section aria-label={t('exceptions.actionsTitle')} className="flex flex-col gap-4">
      <h3 className="font-semibold text-ink">{t('exceptions.actionsTitle')}</h3>
      {may.recheck ? (
        <div className="flex flex-col gap-2">
          <p className="text-ink-muted">{t('exceptions.recheckHint')}</p>
          <Button variant="secondary" className="self-start" disabled={recheck.pending} aria-busy={recheck.pending || undefined} onClick={() => void onRecheck()}>
            {recheck.pending ? t('exceptions.rechecking') : t('exceptions.recheck')}
          </Button>
          {recheck.outcome && !recheck.outcome.ok ? <Notice tone="danger">{errorText(recheck.outcome)}</Notice> : null}
        </div>
      ) : null}
      {may.variance ? (
        <ReasonDialog
          trigger={t('exceptions.variance')}
          title={t('exceptions.varianceTitle')}
          hint={t('exceptions.varianceHint')}
          confirm={t('exceptions.varianceConfirm')}
          busy={t('exceptions.varianceBusy')}
          done={statusText}
          run={(reason, key) => actions.variance({ invoiceId, version, reason }, key)}
        />
      ) : null}
      {may.dismiss
        ? duplicates.map((exceptionId) => (
            <ReasonDialog
              key={exceptionId}
              trigger={t('exceptions.dismiss')}
              title={t('exceptions.dismissTitle')}
              hint={t('exceptions.dismissHint')}
              confirm={t('exceptions.dismissConfirm')}
              busy={t('exceptions.dismissBusy')}
              done={() => t('results.dismissed')}
              run={(reason, key) => actions.dismiss({ exceptionId, reason }, key)}
            />
          ))
        : null}
      {may.reopen ? (
        <div className="flex flex-col gap-2">
          <Button variant="secondary" className="self-start" onClick={() => {
              reopen.clear()
              setReopenOpen(true)
            }}>
            {t('exceptions.reopen')}
          </Button>
          <AlertDialog open={reopenOpen} onOpenChange={setReopenOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="text-lg font-semibold text-ink">{t('exceptions.reopenTitle')}</AlertDialogTitle>
                <AlertDialogDescription className="text-base text-ink-muted">{t('exceptions.reopenHint')}</AlertDialogDescription>
              </AlertDialogHeader>
              {reopen.outcome && !reopen.outcome.ok ? <Notice tone="danger">{errorText(reopen.outcome)}</Notice> : null}
              <AlertDialogFooter className="gap-3">
                <AlertDialogCancel className="h-11 px-4 text-base" disabled={reopen.pending}>
                  {t('dialog.back')}
                </AlertDialogCancel>
                <Button disabled={reopen.pending} aria-busy={reopen.pending || undefined} onClick={() => void onReopen()}>
                  {reopen.pending ? t('exceptions.reopenBusy') : t('exceptions.reopenConfirm')}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : null}
      {may.reject ? (
        <div className="mt-2 border-t border-line pt-4">
          <ReasonDialog
            trigger={t('exceptions.reject')}
            title={t('exceptions.rejectTitle')}
            hint={t('exceptions.rejectHint')}
            confirm={t('exceptions.rejectConfirm')}
            busy={t('exceptions.rejectBusy')}
            done={() => t('results.rejected')}
            irreversible
            danger
            run={(reason, key) => actions.reject({ invoiceId, version, reason }, key)}
          />
        </div>
      ) : null}
      {result ? (
        <p role="status" className="text-ink">
          {result}
        </p>
      ) : null}
    </section>
  )
}

/**
 * Submitting a draft for matching (invoice.submit: it gets its number and the match decides where it goes) and
 * discarding it with a reason (invoice.cancel, confirmed first: it cannot be undone). FINANCE's draft only.
 */
export function DraftActions({ invoiceId, version, may, actions }: { invoiceId: string; version: number; may: { readonly submit: boolean; readonly cancel: boolean }; actions: Pick<ApInvoiceActions, 'submit' | 'cancel'> }) {
  const t = useTranslations('apInvoice')
  const errorText = useApErrorText()
  const submit = useApAction()
  const [result, setResult] = useState<string | null>(null)

  async function onSubmit() {
    setResult(null)
    const o = await submit.run((key) => actions.submit({ invoiceId, version }, key))
    if (o.ok) setResult(o.status === 'READY_FOR_PAYMENT' || o.status === 'EXCEPTION' ? `${t('results.submitted', { number: o.number ?? '-' })} · ${t(`results.${o.status}`)}` : t('results.submitted', { number: o.number ?? '-' }))
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-muted">{t('draft.hint')}</p>
      {may.submit ? (
        <Button className="self-start" disabled={submit.pending} aria-busy={submit.pending || undefined} onClick={() => void onSubmit()}>
          {submit.pending ? t('draft.submitting') : t('draft.submit')}
        </Button>
      ) : null}
      {submit.outcome && !submit.outcome.ok ? <Notice tone="danger">{errorText(submit.outcome)}</Notice> : null}
      {result ? (
        <p role="status" className="text-ink">
          {result}
        </p>
      ) : null}
      {may.cancel ? (
        <div className="mt-2 border-t border-line pt-4">
          <ReasonDialog
            trigger={t('draft.cancel')}
            title={t('draft.cancelTitle')}
            hint={t('draft.cancelHint')}
            confirm={t('draft.cancelConfirm')}
            busy={t('draft.cancelBusy')}
            done={() => t('results.cancelled')}
            irreversible
            danger
            run={(reason, key) => actions.cancel({ invoiceId, version, reason }, key)}
          />
        </div>
      ) : null}
    </div>
  )
}

/** PROCUREMENT's "ขออนุมัติส่วนต่าง" on its list of differences (FR-AP-105 AC2) */
export function VarianceButton({ invoiceId, version, request }: { invoiceId: string; version: number; request: (input: unknown, idempotencyKey: string) => Promise<ApOutcome> }) {
  const t = useTranslations('apInvoice')
  return (
    <ReasonDialog
      trigger={t('exceptions.variance')}
      title={t('exceptions.varianceTitle')}
      hint={t('exceptions.varianceHint')}
      confirm={t('exceptions.varianceConfirm')}
      busy={t('exceptions.varianceBusy')}
      done={(o) => (o.status === 'READY_FOR_PAYMENT' ? t('results.READY_FOR_PAYMENT') : t('results.PENDING_APPROVAL'))}
      run={(reason, key) => request({ invoiceId, version, reason }, key)}
    />
  )
}
