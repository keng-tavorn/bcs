'use client'

import { Plus, Split, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { Notice } from '../form/notice'
import { Button } from '../shadcn/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { Input } from '../shadcn/input'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { describedBy, FieldError } from './controls'
import type { SplitLineProps } from './details-items'
import { lineAmount, plainNumber } from './model'
import { showMoney, showSatang } from './money'
import { halves, MAX_SPLIT_PARTS, quantityText, splitPreview } from './split-lines'

// "แบ่งบรรทัด" of a line of the workspace's request form (S6-17 · FR-BUD-102 AC2 · BR-BUD-16 · OQ-106): a button that
// opens a Dialog — only when pressed (NG-13) — with two parts that add up to the line's quantity to start with, each with
// its quantity and its budget line ("ตามคำขอ" or one of the budget lines the request may use). As the requester types,
// each part's amount, the total of the parts and the line's amount show, and — before anything is saved — the
// difference rounding each part on its own makes ("ยอดรวมต่างจากเดิม 0.01 บาท เพราะปัดเศษทีละส่วน"). A part of zero or
// less, or parts that do not add up to the line's quantity, are said beside the part and stop the split. Confirming
// hands the parts to the form (model.ts splitLine), whose autosave saves them. Drawn with the workspace's components:
// only the workspace's form passes it (StepProps.split), never the LIFF form (ADR-052). No <form> inside: the Dialog's
// portal would carry a submit up to the request form's own.

interface Part {
  readonly key: string
  readonly quantity: string
  /** '' : the request's budget line */
  readonly budgetLineId: string
}

const newPart = (quantity: string, budgetLineId: string): Part => ({ key: uuidv4(), quantity, budgetLineId })

function startingParts(line: SplitLineProps['line']): Part[] {
  const [a, b] = halves(line.quantity) ?? [plainNumber(line.quantity), '']
  const own = line.budgetLineId ?? ''
  return [newPart(a, own), newPart(b, own)]
}

export function SplitLineDialog({ lineNo, line, budgetLines, requestBudgetLineId, onSplit }: SplitLineProps) {
  const t = useTranslations('requestForm.split')
  const tl = useTranslations('requestForm.lines')
  const tb = useTranslations('requestForm.budget')
  const id = useId()
  const [open, setOpen] = useState(false)
  const [parts, setParts] = useState<Part[]>([])
  const [checked, setChecked] = useState(false)

  const preview = splitPreview(line, parts.map((p) => p.quantity))
  const amount = lineAmount(line)
  const own = budgetLines.find((l) => l.id === requestBudgetLineId)
  const uom = line.uom.trim()
  const quantity = plainNumber(line.quantity)
  // Said at once for a number that is not one; a blank or parts that do not add up once the requester tried to split
  const partError = (i: number): string | undefined => {
    const q = parts[i]!.quantity
    return preview.invalid.includes(i) && (checked || q.trim() !== '') ? t('quantityInvalid') : undefined
  }
  const sumError =
    checked && preview.left !== null && preview.left !== 0n
      ? preview.left > 0n
        ? t('short', { quantity: quantityText(preview.left), total: quantity, uom })
        : t('over', { quantity: quantityText(-preview.left), total: quantity, uom })
      : undefined

  function onOpenChange(next: boolean) {
    if (next) {
      setParts(startingParts(line))
      setChecked(false)
    }
    setOpen(next)
  }

  function set(key: string, patch: Partial<Omit<Part, 'key'>>) {
    setParts((was) => was.map((p) => (p.key === key ? { ...p, ...patch } : p)))
  }

  function confirm() {
    setChecked(true)
    if (!preview.ready) {
      // The first part to fix takes focus, its words under it
      const first = preview.invalid[0]
      document.getElementById(first !== undefined ? `${id}-q-${first}` : `${id}-q-0`)?.focus()
      return
    }
    onSplit(parts.map((p) => ({ key: p.key, quantity: plainNumber(p.quantity), budgetLineId: p.budgetLineId || null })))
    setOpen(false)
  }

  const differs = preview.difference !== null && preview.difference !== 0n
  const absolute = (s: bigint) => (s < 0n ? -s : s)

  return (
    <>
      <Button type="button" variant="outline" className="h-11 gap-2 text-base md:text-sm" aria-label={t('buttonLabel', { n: lineNo })} onClick={() => onOpenChange(true)}>
        <Split aria-hidden="true" />
        {t('button')}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto p-6 sm:max-w-160">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold">{t('title', { n: lineNo })}</DialogTitle>
            <DialogDescription className="text-base text-ink-muted md:text-sm">
              {t('description', { price: showMoney(plainNumber(line.unitPrice)), quantity, uom })}
            </DialogDescription>
          </DialogHeader>
          <p className="font-medium break-words text-ink">{line.description}</p>
          <ol className="flex flex-col divide-y divide-line border-y border-line">
            {parts.map((p, i) => {
              const error = partError(i)
              const net = preview.nets[i]
              const q = `${id}-q-${i}`
              const b = `${id}-b-${i}`
              return (
                <li key={p.key} className="flex flex-col gap-3 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-semibold text-ink">{t('part', { n: i + 1 })}</h3>
                    {parts.length > 2 ? (
                      <Button type="button" variant="ghost" className="h-11 gap-2 text-base md:text-sm" onClick={() => setParts((was) => was.filter((x) => x.key !== p.key))}>
                        <X aria-hidden="true" />
                        {t('removePart', { n: i + 1 })}
                      </Button>
                    ) : null}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <label htmlFor={q} className="font-medium text-ink">
                        {t('quantity', { uom })}
                      </label>
                      <Input
                        id={q}
                        inputMode="decimal"
                        className="h-11 bg-bg text-right text-base tabular-nums md:text-base"
                        value={p.quantity}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={describedBy(q, false, Boolean(error))}
                        onChange={(e) => set(p.key, { quantity: e.currentTarget.value })}
                      />
                      {error ? <FieldError id={q}>{error}</FieldError> : null}
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <label htmlFor={b} className="font-medium text-ink">
                        {t('budgetLine')}
                      </label>
                      <NativeSelect id={b} className="w-full [&_select]:h-11 [&_select]:bg-bg [&_select]:text-base" value={p.budgetLineId} onChange={(e) => set(p.key, { budgetLineId: e.currentTarget.value })}>
                        <NativeSelectOption value="">{own ? tl('budgetLineSameCode', { code: own.code }) : tl('budgetLineSame')}</NativeSelectOption>
                        {p.budgetLineId && !budgetLines.some((l) => l.id === p.budgetLineId) ? <NativeSelectOption value={p.budgetLineId}>{tl('budgetLineGone')}</NativeSelectOption> : null}
                        {budgetLines.map((l) => (
                          <NativeSelectOption key={l.id} value={l.id}>
                            {l.granted ? tb('optionGranted', { code: l.code, name: l.name, department: l.departmentName }) : tb('option', { code: l.code, name: l.name })}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                  </div>
                  <p className="money self-end">{net !== null && net !== undefined ? t('amount', { amount: showSatang(net) }) : t('amountPending')}</p>
                </li>
              )
            })}
          </ol>
          {parts.length < MAX_SPLIT_PARTS ? (
            <Button type="button" variant="outline" className="h-11 gap-2 self-start text-base md:text-sm" onClick={() => setParts((was) => [...was, newPart('', was.at(-1)?.budgetLineId ?? '')])}>
              <Plus aria-hidden="true" />
              {t('addPart')}
            </Button>
          ) : null}
          {sumError ? <Notice tone="danger">{sumError}</Notice> : null}
          <section aria-label={t('total')} aria-live="polite" className="flex flex-col gap-2">
            <dl className="grid max-w-xl grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1">
              <dt>{t('original')}</dt>
              <dd className="money">{amount !== null ? t('baht', { amount: showSatang(amount) }) : '-'}</dd>
              <dt className="font-semibold">{t('total')}</dt>
              <dd className="money font-semibold">{preview.total !== null ? t('baht', { amount: showSatang(preview.total) }) : '-'}</dd>
            </dl>
            {preview.ready ? (
              differs ? (
                <Notice tone="info">{t('difference', { amount: showSatang(absolute(preview.difference!)) })}</Notice>
              ) : (
                <p className="text-ink">{t('same')}</p>
              )
            ) : null}
          </section>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11 text-base md:text-sm" onClick={() => setOpen(false)}>
              {t('keep')}
            </Button>
            <Button type="button" className="h-11 text-base hover:bg-primary-hover md:text-sm" onClick={confirm}>
              {t('confirm', { count: parts.length })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
