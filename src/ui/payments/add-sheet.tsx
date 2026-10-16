'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { Checkbox } from '../shadcn/checkbox'
import { Label } from '../shadcn/label'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '../shadcn/sheet'
import { dayText, money } from './present'
import { supplierName, type AddableSupplierView, type PayAction, type RunDocumentView } from './types'
import { usePayAction, usePayErrorText } from './use-pay-action'

// Adding documents to a draft run (S9-09, FR-PAY-101 AC1 AC2, demo step 2 and 3): a Sheet from the right, opened by the
// preparer's button only (NG-13), with the invoices ready for payment and the released retentions grouped by supplier,
// each a Checkbox, and one to choose every document of a supplier. A document due after the pay date says it is paid
// early; a supplier without an approved account says so (sending would refuse it). What is chosen is counted and added
// up as satang (never a float); the service holds each document for the run and makes one item per supplier.

const docKey = (d: RunDocumentView) => `${d.kind}:${d.id}`

export function AddDocumentsSheet({ paymentRunId, version, payDate, suppliers, add }: { paymentRunId: string; version: number; payDate: string; suppliers: readonly AddableSupplierView[]; add: PayAction }) {
  const t = useTranslations('payRun')
  const locale = useLocale()
  const errorText = usePayErrorText()
  const action = usePayAction()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())

  const all = suppliers.flatMap((s) => s.documents)
  const picked = all.filter((d) => chosen.has(docKey(d)))
  const total = picked.reduce((a, d) => a + BigInt(d.payableSatang), 0n).toString()
  const toggle = (keys: readonly string[], on: boolean) =>
    setChosen((now) => {
      const next = new Set(now)
      for (const k of keys) {
        if (on) next.add(k)
        else next.delete(k)
      }
      return next
    })

  async function onAdd() {
    const outcome = await action.run((key) =>
      add({ paymentRunId, version, invoiceIds: picked.filter((d) => d.kind === 'INVOICE').map((d) => d.id), retentionIds: picked.filter((d) => d.kind === 'RETENTION').map((d) => d.id) }, key),
    )
    if (outcome.ok) {
      setOpen(false)
      setChosen(new Set())
      toast.success(t('sheet.added'))
    }
  }

  const docLabel = (d: RunDocumentView) =>
    d.kind === 'RETENTION' ? t('items.retention', { number: d.number ?? d.supplierInvoiceNo ?? '-' }) : d.number ? t('items.invoice', { number: d.number }) : t('items.invoiceDraft', { no: d.supplierInvoiceNo ?? '-' })

  return (
    <>
      <Button
        variant="secondary"
        className="self-start"
        onClick={() => {
          action.clear()
          setOpen(true)
        }}
      >
        {t('items.add')}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full sm:max-w-xl">
          <SheetHeader className="pr-12">
            <SheetTitle className="text-lg font-semibold text-ink">{t('sheet.title')}</SheetTitle>
            <SheetDescription className="text-base text-ink-muted">{t('sheet.hint')}</SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
            {suppliers.length === 0 ? (
              <div className="flex flex-col gap-1">
                <p className="font-medium text-ink">{t('sheet.empty')}</p>
                <p className="text-ink-muted">{t('sheet.emptyHint')}</p>
              </div>
            ) : (
              suppliers.map((s) => {
                const keys = s.documents.map(docKey)
                const every = keys.length > 0 && keys.every((k) => chosen.has(k))
                const name = `${s.supplier.code} · ${supplierName(locale, s.supplier)}`
                return (
                  <fieldset key={s.supplier.id} className="flex flex-col gap-1 border-t border-line pt-3">
                    <legend className="sr-only">{name}</legend>
                    <div className="flex min-h-11 items-center gap-3">
                      <Checkbox id={`${id}-${s.supplier.id}`} checked={every} onCheckedChange={(v) => toggle(keys, v === true)} className="size-5" aria-label={t('sheet.all', { name })} />
                      <Label htmlFor={`${id}-${s.supplier.id}`} className="text-base font-semibold break-words text-ink">
                        {name}
                      </Label>
                    </div>
                    {s.supplier.hasAccount ? null : <p className="text-base text-warn-ink md:text-sm">{t('sheet.noAccount')}</p>}
                    <ul className="flex flex-col">
                      {s.documents.map((d) => {
                        const k = docKey(d)
                        const early = d.dueDate !== null && d.dueDate > payDate
                        return (
                          <li key={k} className="flex min-h-11 items-start gap-3 py-1.5 pl-8">
                            <Checkbox id={`${id}-${k}`} checked={chosen.has(k)} onCheckedChange={(v) => toggle([k], v === true)} className="mt-1 size-5" />
                            <Label htmlFor={`${id}-${k}`} className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-base font-normal text-ink">
                              <span className="flex w-full flex-wrap items-baseline justify-between gap-x-3">
                                <span className="break-words">{docLabel(d)}</span>
                                <span className="money font-medium">{money(d.payableSatang)}</span>
                              </span>
                              <span className="text-ink-muted">
                                {[d.supplierInvoiceNo && d.number ? t('items.supplierNo', { no: d.supplierInvoiceNo }) : null, d.dueDate ? t('items.due', { date: dayText(locale, d.dueDate) }) : null, early ? t('items.early') : null].filter(Boolean).join(' · ')}
                              </span>
                            </Label>
                          </li>
                        )
                      })}
                    </ul>
                  </fieldset>
                )
              })
            )}
          </div>
          <SheetFooter className="border-t border-line">
            <p role="status" className="tabular text-ink">
              {t('sheet.chosen', { count: picked.length, amount: money(total) })}
            </p>
            {action.outcome && !action.outcome.ok ? <Notice tone="danger">{errorText(action.outcome)}</Notice> : null}
            <div className="flex flex-wrap gap-3">
              <Button disabled={picked.length === 0 || action.pending} aria-busy={action.pending || undefined} onClick={() => void onAdd()}>
                {action.pending ? t('sheet.submitting') : t('sheet.submit', { count: picked.length })}
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={action.pending}>
                {t('sheet.close')}
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
