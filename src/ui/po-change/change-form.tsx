'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { satangOf } from '@/core/forms/money-text'
import { parseQuantity } from '@/core/money/math'
import { PO_NOTE_MAX_LENGTH, REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { DateField } from '../form/date-field'
import { Notice } from '../form/notice'
import { useOutcomeAction } from '../procurement/use-outcome-action'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { RadioGroup, RadioGroupItem } from '../shadcn/radio-group'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { Textarea } from '../shadcn/textarea'
import { Refusal } from './failure'
import { PO_S8_NO_ANSWER, type ChangePreviewOutcome, type ChangeTotalsView, type PoS8Failure, type PoS8Outcome } from './outcome'

// The change of a sent PO (S8-13, FR-AP-107, BR-POC-01 to BR-POC-03) in two steps, so no step asks more than a few
// things at once (§9.9: no single long form): first the lines — a new quantity (never below what was received or
// invoiced, never above what the request has left: said before typing, §9.9 principle 3; shut for a line ordered for
// several requests) and a new unit price (shut once the line has an invoice) — then "ดูยอดใหม่" asks the server for the
// PO's new totals (changeTotals, never added up here) and any refusal; the second step shows those totals beside the
// old ones and takes the delivery date, the notes to the supplier, what happens to a quantity taken off (RadioGroup,
// back to the pool by default), and the reason. "บันทึกร่างใบแก้ไข" drafts it (po_change.create); the page then shows the
// draft to send. Money stays text; quantities and prices are compared as bigint, never as numbers.

const QUANTITY = /^\d{1,14}(\.\d{1,4})?$/
const plain = (text: string): string => text.replace(/[\s,]/g, '')

export interface ChangeFormLine {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  readonly uom: string
  readonly quantity: string
  /** Baht as the page shows it: "1,000.00" */
  readonly unitPrice: string
  readonly received: string
  readonly invoiced: string
  readonly maxQuantity: string | null
  readonly minQuantity: string
  readonly priceLocked: boolean
}

type LineInput = { readonly poLineId: string; readonly newQuantity?: string; readonly newUnitPrice?: string }
type Disposition = 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES'

export interface ChangeFormProps {
  readonly poId: string
  readonly lines: readonly ChangeFormLine[]
  readonly deliveryDate: string | null
  readonly notesToSupplier: string | null
  readonly actions: {
    readonly preview: (input: { poId: string; lines: LineInput[] }) => Promise<ChangePreviewOutcome>
    readonly create: (input: { poId: string; reason: string; lines: LineInput[]; deliveryDate: string; notesToSupplier: string; quantityDisposition?: Disposition }, idempotencyKey: string) => Promise<PoS8Outcome>
  }
}

type Typed = Record<string, { quantity: string; price: string }>

/** What the lines send: only what differs from the PO; or the lines whose text is no quantity or price */
function changedLines(lines: readonly ChangeFormLine[], typed: Typed): { ok: true; lines: LineInput[]; lowered: boolean } | { ok: false; bad: Record<string, 'quantity' | 'price'> } {
  const out: LineInput[] = []
  const bad: Record<string, 'quantity' | 'price'> = {}
  let lowered = false
  for (const l of lines) {
    const q = typed[l.id]!.quantity.trim()
    const p = plain(typed[l.id]!.price)
    if (!QUANTITY.test(q) || parseQuantity(q) <= 0n) {
      bad[l.id] = 'quantity'
      continue
    }
    const satang = satangOf(p)
    if (satang === null) {
      bad[l.id] = 'price'
      continue
    }
    const newQty = parseQuantity(q) !== parseQuantity(l.quantity)
    const newPrice = satang !== satangOf(plain(l.unitPrice))
    if (newQty && parseQuantity(q) < parseQuantity(l.quantity)) lowered = true
    if (newQty || newPrice) out.push({ poLineId: l.id, ...(newQty ? { newQuantity: q } : {}), ...(newPrice ? { newUnitPrice: p } : {}) })
  }
  return Object.keys(bad).length ? { ok: false, bad } : { ok: true, lines: out, lowered }
}

export function PoChangeForm({ poId, lines, deliveryDate, notesToSupplier, actions }: ChangeFormProps) {
  const t = useTranslations('poChange.form')
  const id = useId()
  const [step, setStep] = useState<1 | 2>(1)
  const [typed, setTyped] = useState<Typed>(() => Object.fromEntries(lines.map((l) => [l.id, { quantity: l.quantity, price: l.unitPrice }])))
  const [bad, setBad] = useState<Record<string, 'quantity' | 'price'>>({})
  const [checking, setChecking] = useState(false)
  const [previewFailure, setPreviewFailure] = useState<PoS8Failure | null>(null)
  const [totals, setTotals] = useState<ChangeTotalsView | null>(null)
  const [sending, setSending] = useState<{ lines: LineInput[]; lowered: boolean } | null>(null)
  const [notes, setNotes] = useState(notesToSupplier ?? '')
  const [reason, setReason] = useState('')
  const [reasonMissing, setReasonMissing] = useState(false)
  const [disposition, setDisposition] = useState<Disposition>('RETURN_TO_POOL')
  const action = useOutcomeAction<PoS8Outcome>(PO_S8_NO_ANSWER)

  async function onLines(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const changed = changedLines(lines, typed)
    if (!changed.ok) return setBad(changed.bad)
    setBad({})
    setChecking(true)
    setPreviewFailure(null)
    let outcome: ChangePreviewOutcome
    try {
      outcome = await actions.preview({ poId, lines: changed.lines })
    } catch {
      outcome = PO_S8_NO_ANSWER
    }
    setChecking(false)
    if (!outcome.ok) return setPreviewFailure(outcome)
    setTotals(outcome.totals)
    setSending({ lines: changed.lines, lowered: changed.lowered })
    setStep(2)
  }

  async function onDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!sending) return
    if (!reason.trim()) return setReasonMissing(true)
    setReasonMissing(false)
    const day = new FormData(event.currentTarget).get('deliveryDate')
    await action.run((key) =>
      actions.create(
        {
          poId,
          reason: reason.trim(),
          lines: sending.lines,
          deliveryDate: typeof day === 'string' ? day : '',
          notesToSupplier: notes,
          ...(sending.lowered ? { quantityDisposition: disposition } : {}),
        },
        key,
      ),
    )
  }

  if (step === 1) {
    return (
      <form onSubmit={onLines} aria-labelledby={`${id}-step1`} className="flex flex-col gap-5" noValidate>
        <h2 id={`${id}-step1`} className="text-lg font-semibold text-ink">
          {t('step1')}
        </h2>
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {lines.map((l) => {
            const value = typed[l.id]!
            const set = (part: 'quantity' | 'price', v: string) => setTyped({ ...typed, [l.id]: { ...value, [part]: v } })
            return (
              <li key={l.id} className="flex flex-col gap-3 py-4">
                <div className="flex flex-col gap-0.5">
                  <h3 className="font-semibold text-ink">{t('lineTitle', { no: l.lineNo, description: l.description })}</h3>
                  <p className="tabular text-ink-muted">{t('now', { quantity: l.quantity, uom: l.uom, price: l.unitPrice, received: l.received, invoiced: l.invoiced })}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-${l.id}-q`} className="text-base md:text-sm">
                      {t('quantity', { uom: l.uom })}
                    </Label>
                    <Input
                      id={`${id}-${l.id}-q`}
                      inputMode="decimal"
                      className="h-11 text-base"
                      value={value.quantity}
                      disabled={l.maxQuantity === null}
                      aria-invalid={bad[l.id] === 'quantity' ? true : undefined}
                      aria-describedby={`${id}-${l.id}-qh`}
                      onChange={(e) => set('quantity', e.target.value)}
                    />
                    <p id={`${id}-${l.id}-qh`} className="text-base text-ink-muted md:text-sm">
                      {bad[l.id] === 'quantity' ? t('badQuantity') : l.maxQuantity === null ? t('quantityMerged') : t('quantityHint', { min: l.minQuantity, max: l.maxQuantity })}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-${l.id}-p`} className="text-base md:text-sm">
                      {t('price')}
                    </Label>
                    <Input
                      id={`${id}-${l.id}-p`}
                      inputMode="decimal"
                      className="tabular h-11 text-base"
                      value={value.price}
                      disabled={l.priceLocked}
                      aria-invalid={bad[l.id] === 'price' ? true : undefined}
                      aria-describedby={l.priceLocked || bad[l.id] === 'price' ? `${id}-${l.id}-ph` : undefined}
                      onChange={(e) => set('price', e.target.value)}
                    />
                    {l.priceLocked || bad[l.id] === 'price' ? (
                      <p id={`${id}-${l.id}-ph`} className="text-base text-ink-muted md:text-sm">
                        {bad[l.id] === 'price' ? t('badPrice') : t('priceLocked')}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
        {previewFailure ? <Refusal failure={previewFailure} /> : null}
        <Button type="submit" className="self-start" disabled={checking}>
          {checking ? t('checking') : t('next')}
        </Button>
      </form>
    )
  }

  return (
    <form onSubmit={onDetails} aria-labelledby={`${id}-step2`} className="flex flex-col gap-5" noValidate>
      <h2 id={`${id}-step2`} className="text-lg font-semibold text-ink">
        {t('step2')}
      </h2>
      {totals ? (
        <section aria-labelledby={`${id}-totals`} className="flex flex-col gap-2">
          <h3 id={`${id}-totals`} className="font-semibold text-ink">
            {t('totalsTitle')}
          </h3>
          <Table aria-label={t('totalsTable')} className="max-w-xl">
            <TableHeader>
              <TableRow>
                <TableHead>{t('amount')}</TableHead>
                <TableHead className="text-right">{t('before')}</TableHead>
                <TableHead className="text-right">{t('after')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(
                [
                  ['net', totals.oldNet, totals.newNet],
                  ['vat', totals.oldVat, totals.newVat],
                  ['gross', totals.oldGross, totals.newGross],
                ] as const
              ).map(([key, before, after]) => (
                <TableRow key={key}>
                  <TableCell className={key === 'gross' ? 'font-semibold' : undefined}>{t(key)}</TableCell>
                  <TableCell className="tabular text-right">{before}</TableCell>
                  <TableCell className={key === 'gross' ? 'tabular text-right font-semibold' : 'tabular text-right'}>{after}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}
      <DateField id={`${id}-date`} name="deliveryDate" label={t('deliveryDate')} hint={t('deliveryHint')} {...(deliveryDate ? { defaultValue: deliveryDate } : {})} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-notes`} className="text-base md:text-sm">
          {t('notes')}
        </Label>
        <Textarea id={`${id}-notes`} className="text-base" rows={3} maxLength={PO_NOTE_MAX_LENGTH} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {sending?.lowered ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-2 font-medium text-ink">{t('disposition')}</legend>
          <RadioGroup value={disposition} onValueChange={(v) => setDisposition(v as Disposition)}>
            {(['RETURN_TO_POOL', 'CANCEL_REQUEST_LINES'] as const).map((d) => (
              <div key={d} className="flex min-h-11 items-center gap-3">
                <RadioGroupItem id={`${id}-${d}`} value={d} />
                <Label htmlFor={`${id}-${d}`} className="text-base font-normal md:text-sm">
                  {t(`dispositionOption.${d}`)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </fieldset>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-reason`} className="text-base md:text-sm">
          {t('reason')}
        </Label>
        <Textarea
          id={`${id}-reason`}
          className="text-base"
          rows={3}
          maxLength={REASON_MAX_LENGTH}
          value={reason}
          required
          aria-invalid={reasonMissing ? true : undefined}
          aria-describedby={reasonMissing ? `${id}-reason-error` : undefined}
          onChange={(e) => setReason(e.target.value)}
        />
        {reasonMissing ? (
          <p id={`${id}-reason-error`} className="text-base text-danger md:text-sm">
            {t('reasonMissing')}
          </p>
        ) : null}
      </div>
      {action.outcome && !action.outcome.ok ? <Refusal failure={action.outcome} /> : null}
      {action.outcome?.ok ? <Notice tone="success">{t('saved')}</Notice> : null}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Button type="submit" disabled={action.pending}>
          {action.pending ? t('working') : t('save')}
        </Button>
        <Button variant="link" className="min-h-11" disabled={action.pending} onClick={() => setStep(1)}>
          {t('backToLines')}
        </Button>
      </div>
    </form>
  )
}
