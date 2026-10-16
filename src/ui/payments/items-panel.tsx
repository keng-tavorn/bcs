'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { TextArea } from '../request-view/text-area'
import { AddDocumentsSheet } from './add-sheet'
import { FlagBadge, ItemResultBadge } from './badges'
import { ConfirmDialog } from './confirm-dialog'
import { accountValues, dayText, money } from './present'
import { supplierName, type AddableSupplierView, type PayAction, type RunDocumentView, type RunItemView } from './types'
import { usePayAction, usePayErrorText } from './use-pay-action'

// The items of a payment run (S9-09, FR-PAY-101 AC2 AC3 AC5, BR-PAY-05 BR-PAY-06): one per supplier, the items with
// flags first, each flag in words with the preparer's reason — what the approver reads too. Each item names the payee
// account masked (bank and last four digits), what it pays, the tax withheld and what is transferred (right-aligned,
// tabular digits), and its documents, a document due after the pay date marked as paid early. While the preparer edits
// the draft: add documents through the Sheet, take one out (asked first), and write the reason a flag needs. Amounts
// arrive as satang strings and stay BigInt.

const REASON_MIN = 3

function Figure({ label, value, strong, unit }: { label: string; value: string; strong?: boolean; unit: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={`money text-ink ${strong ? 'font-semibold' : ''}`}>
        {value}
        <span className="sr-only"> {unit}</span>
      </dd>
    </div>
  )
}

function FlagReasonForm({ paymentRunId, version, supplierId, initial, save }: { paymentRunId: string; version: number; supplierId: string; initial: string; save: PayAction }) {
  const t = useTranslations('payRun')
  const errorText = usePayErrorText()
  const action = usePayAction()
  const id = useId()
  const [reason, setReason] = useState(initial)
  const [missing, setMissing] = useState(false)

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (reason.trim().length < REASON_MIN) return setMissing(true)
    setMissing(false)
    const outcome = await action.run((key) => save({ paymentRunId, version, supplierId, reason: reason.trim() }, key))
    if (outcome.ok) toast.success(t('items.reasonSaved'))
  }

  return (
    <form method="post" noValidate className="flex flex-col gap-2" onSubmit={(event) => void onSave(event)}>
      <TextArea
        id={`${id}-reason`}
        name="reason"
        label={t('items.reasonLabel')}
        value={reason}
        maxLength={REASON_MAX_LENGTH}
        onChange={(event) => {
          setReason(event.currentTarget.value)
          setMissing(false)
        }}
        error={missing ? t('dialog.reasonRequired') : undefined}
      />
      <Button type="submit" variant="secondary" className="self-start" disabled={action.pending} aria-busy={action.pending || undefined}>
        {action.pending ? t('items.savingReason') : t('items.saveReason')}
      </Button>
      {action.outcome && !action.outcome.ok ? <Notice tone="danger">{errorText(action.outcome)}</Notice> : null}
    </form>
  )
}

export function ItemsPanel({
  paymentRunId,
  version,
  payDate,
  items,
  editable,
  addable,
  actions,
}: {
  paymentRunId: string
  version: number
  payDate: string
  items: readonly RunItemView[]
  /** The preparer edits the draft */
  editable: boolean
  addable: readonly AddableSupplierView[]
  actions: { readonly addDocuments: PayAction; readonly removeDocuments: PayAction; readonly setFlagReason: PayAction }
}) {
  const t = useTranslations('payRun')
  const locale = useLocale()
  const unit = t('unit')
  const flagText = (f: string) => (t.has(`task.flag.${f}` as 'task.flag.REGISTRY_CHANGED') ? t(`task.flag.${f}` as 'task.flag.REGISTRY_CHANGED') : f)
  const docLabel = (d: RunDocumentView) =>
    d.kind === 'RETENTION' ? t('items.retention', { number: d.number ?? d.supplierInvoiceNo ?? '-' }) : d.number ? t('items.invoice', { number: d.number }) : t('items.invoiceDraft', { no: d.supplierInvoiceNo ?? '-' })

  return (
    <section aria-labelledby="run-items-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="run-items-title" className="text-base font-semibold text-ink">
          {t('items.title')}
        </h2>
        <p className="text-ink-muted">{t('items.hint')}</p>
      </div>
      {editable ? <AddDocumentsSheet paymentRunId={paymentRunId} version={version} payDate={payDate} suppliers={addable} add={actions.addDocuments} /> : null}
      {items.length === 0 ? (
        <div className="flex flex-col gap-1 py-2">
          <p className="font-medium text-ink">{editable ? t('items.empty') : t('items.emptyRead')}</p>
          {editable ? <p className="text-ink-muted">{t('items.emptyHint')}</p> : null}
        </div>
      ) : (
        <ul aria-label={t('items.list')} className="flex flex-col gap-3">
          {items.map((item) => {
            const flagged = item.flags.length > 0
            return (
              <li key={item.id} className={`flex flex-col gap-3 rounded-md border bg-bg p-3 ${flagged ? 'border-warn' : 'border-line'}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="font-semibold break-words text-ink">{`${item.supplier.code} · ${supplierName(locale, item.supplier)}`}</span>
                    <span className="text-ink-muted">
                      {[item.seq ? t('items.seq', { seq: item.seq }) : null, item.account ? t('items.account', { account: t('account.masked', accountValues(locale, item.account)) }) : null].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  {item.status !== 'INCLUDED' ? <ItemResultBadge status={item.status} label={t(`results.itemStatus.${item.status}`)} /> : null}
                </div>
                {item.account ? null : <Notice tone="warning">{t('items.noAccount')}</Notice>}

                {flagged ? (
                  <div className="flex flex-col gap-2 border-l-2 border-warn pl-3">
                    <p className="sr-only">{t('items.flags')}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {item.flags.map((f) => (
                        <FlagBadge key={f} label={flagText(f)} />
                      ))}
                    </div>
                    <p className="break-words text-ink">{item.flagReason ? t('items.reason', { reason: item.flagReason }) : t('items.noReason')}</p>
                    {item.reasonNeeded ? <p className="font-medium text-warn-ink">{t('items.reasonNeeded')}</p> : null}
                    {editable ? <FlagReasonForm paymentRunId={paymentRunId} version={version} supplierId={item.supplier.id} initial={item.flagReason ?? ''} save={actions.setFlagReason} /> : null}
                  </div>
                ) : null}

                <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-3">
                  <Figure label={t('run.payable')} value={money(item.payableSatang)} unit={unit} />
                  <Figure label={t('run.wht')} value={money(item.whtSatang)} unit={unit} />
                  <Figure label={t('run.transfer')} value={money(item.transferSatang)} unit={unit} strong />
                </dl>

                <div className="flex flex-col gap-1">
                  <p className="font-medium text-ink">{t('items.documents', { count: item.documents.length })}</p>
                  <ul className="flex flex-col divide-y divide-line border-y border-line">
                    {item.documents.map((d) => {
                      const early = d.dueDate !== null && d.dueDate > payDate
                      const notes = [
                        d.supplierInvoiceNo && d.number ? t('items.supplierNo', { no: d.supplierInvoiceNo }) : null,
                        d.dueDate ? t('items.due', { date: dayText(locale, d.dueDate) }) : null,
                        early ? t('items.early') : null,
                        d.status !== 'HELD' ? t(`items.docStatus.${d.status}`) : null,
                      ].filter(Boolean)
                      return (
                        <li key={`${d.kind}:${d.id}`} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                          <div className="flex min-w-0 flex-col">
                            <span className="break-words text-ink">{docLabel(d)}</span>
                            {notes.length ? <span className="text-ink-muted">{notes.join(' · ')}</span> : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                            <span className="money text-ink">
                              {money(d.payableSatang)}
                              <span className="sr-only"> {unit}</span>
                            </span>
                            {editable && d.status === 'HELD' ? (
                              <ConfirmDialog
                                trigger={t('items.remove')}
                                title={t('items.removeTitle')}
                                hint={t('items.removeText', { doc: docLabel(d) })}
                                confirm={t('items.removeConfirm')}
                                busy={t('items.removing')}
                                done={() => t('items.removed')}
                                run={(_, key) =>
                                  actions.removeDocuments({ paymentRunId, version, invoiceIds: d.kind === 'INVOICE' ? [d.id] : [], retentionIds: d.kind === 'RETENTION' ? [d.id] : [] }, key)
                                }
                              />
                            ) : null}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
