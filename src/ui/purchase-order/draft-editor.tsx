'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { parseQuantity } from '@/core/money/math'
import { PAYMENT_TERM_MAX_DAYS, PO_NOTE_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useOutcomeAction } from '../procurement/use-outcome-action'
import { TextArea } from '../request-view/text-area'
import { type PoOutcome } from './outcome'
import { usePoFailureText } from './po-actions'

// Editing a draft PO (spec FR-P2P-003 AC2, BR-CONS-04): the unit price and the quantity of each line — never more than
// what its request line has left, told before typing (§9.9 principle 3) — taking a line back to the pool, and, in a form
// of its own, the payment terms and the note to the supplier. Each form sends only what changed with the version the
// page was opened at, so a draft changed elsewhere is refused (CONFLICT_VERSION) rather than overwritten. The browser
// sends prices and quantities; the totals come back from core on the server (AC3). A field's error goes as soon as the
// field changes.

const PRICE = /^\d{1,13}(\.\d{1,2})?$/
const QUANTITY = /^\d{1,14}(\.\d{1,4})?$/
const DAYS = /^\d{1,4}$/

export interface DraftLineEdit {
  readonly id: string
  readonly no: number
  readonly description: string
  readonly uom: string
  /** Decimal text as stored, e.g. "20" or "1.5" */
  readonly quantity: string
  /** Baht with 2 decimals, no separators, e.g. "1500.00" */
  readonly unitPrice: string
  /** What the request line has left for this line; null when the line orders several request lines */
  readonly maxQuantity: string | null
}

export interface DraftEditorProps {
  readonly poId: string
  readonly version: number
  readonly lines: readonly DraftLineEdit[]
  readonly paymentTermDays: number | null
  readonly notesToSupplier: string | null
  readonly save: (
    input: { poId: string; expectedVersion: number; lines?: Array<{ poLineId: string; quantity?: string; unitPrice?: string }>; removeLineIds?: string[]; paymentTermDays?: number | null; notesToSupplier?: string | null },
    idempotencyKey: string,
  ) => Promise<PoOutcome>
}

type Save = DraftEditorProps['save'] extends (input: infer I, key: string) => Promise<PoOutcome> ? Omit<I, 'poId' | 'expectedVersion'> : never

function LinesForm({ lines, run, pending }: { lines: readonly DraftLineEdit[]; run: (input: Save) => Promise<boolean>; pending: boolean }) {
  const t = useTranslations('purchaseOrder.actions.edit')
  const tActions = useTranslations('purchaseOrder.actions')
  const id = useId()
  const [values, setValues] = useState(() => Object.fromEntries(lines.map((l) => [l.id, { price: l.unitPrice, quantity: l.quantity, remove: false }])))
  const [errors, setErrors] = useState<Record<string, { price?: string; quantity?: string }>>({})
  const [formError, setFormError] = useState<string | null>(null)

  const change = (lineId: string, patch: Partial<{ price: string; quantity: string; remove: boolean }>) => {
    setValues((v) => ({ ...v, [lineId]: { ...v[lineId]!, ...patch } }))
    setErrors((e) => ({ ...e, [lineId]: { ...e[lineId], ...(patch.price !== undefined ? { price: undefined } : {}), ...(patch.quantity !== undefined ? { quantity: undefined } : {}) } }))
    setFormError(null)
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: Record<string, { price?: string; quantity?: string }> = {}
    const edits: Array<{ poLineId: string; quantity?: string; unitPrice?: string }> = []
    const removeLineIds: string[] = []
    for (const line of lines) {
      const v = values[line.id]!
      if (v.remove) {
        removeLineIds.push(line.id)
        continue
      }
      const price = v.price.trim()
      const quantity = v.quantity.trim()
      const e: { price?: string; quantity?: string } = {}
      if (!PRICE.test(price)) e.price = t('badPrice')
      if (line.maxQuantity !== null) {
        if (!QUANTITY.test(quantity) || parseQuantity(quantity) <= 0n) e.quantity = t('badQuantity')
        else if (parseQuantity(quantity) > parseQuantity(line.maxQuantity)) e.quantity = t('overMax', { max: line.maxQuantity })
      }
      if (e.price || e.quantity) next[line.id] = e
      const edit: { poLineId: string; quantity?: string; unitPrice?: string } = { poLineId: line.id }
      if (PRICE.test(price) && price !== line.unitPrice) edit.unitPrice = price
      if (line.maxQuantity !== null && QUANTITY.test(quantity) && parseQuantity(quantity) !== parseQuantity(line.quantity)) edit.quantity = quantity
      if (edit.unitPrice !== undefined || edit.quantity !== undefined) edits.push(edit)
    }
    setErrors(next)
    if (Object.keys(next).length) return
    if (removeLineIds.length === lines.length) return setFormError(t('allRemoved'))
    await run({ lines: edits, removeLineIds })
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby={`${id}-title`} className="flex flex-col gap-4">
      <h3 id={`${id}-title`} className="font-semibold text-ink">
        {t('linesTitle')}
      </h3>
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      {lines.map((line) => {
        const v = values[line.id]!
        return (
          <fieldset key={line.id} className="flex min-w-0 flex-col gap-3 border-t border-line pt-3">
            <legend className="float-left mb-1 w-full font-medium break-words text-ink">{t('lineLegend', { no: line.no, description: line.description })}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id={`${id}-${line.id}-price`}
                label={t('price')}
                inputMode="decimal"
                autoComplete="off"
                value={v.price}
                disabled={v.remove}
                onChange={(event) => change(line.id, { price: event.currentTarget.value })}
                error={errors[line.id]?.price}
                className="text-right tabular"
              />
              <Field
                id={`${id}-${line.id}-quantity`}
                label={t('quantity', { uom: line.uom })}
                inputMode="decimal"
                autoComplete="off"
                value={v.quantity}
                disabled={v.remove || line.maxQuantity === null}
                hint={line.maxQuantity === null ? t('mergedHint') : t('maxHint', { max: line.maxQuantity, uom: line.uom })}
                onChange={(event) => change(line.id, { quantity: event.currentTarget.value })}
                error={errors[line.id]?.quantity}
                className="text-right tabular"
              />
            </div>
            <label htmlFor={`${id}-${line.id}-remove`} className="flex min-h-11 items-start gap-3">
              <input
                id={`${id}-${line.id}-remove`}
                type="checkbox"
                checked={v.remove}
                onChange={(event) => change(line.id, { remove: event.currentTarget.checked })}
                aria-describedby={`${id}-${line.id}-remove-hint`}
                className="mt-1 size-5 shrink-0 accent-[var(--primary)]"
              />
              <span className="flex flex-col">
                <span className="text-ink">{t('remove')}</span>
                <span id={`${id}-${line.id}-remove-hint`} className="text-base text-ink-muted md:text-sm">
                  {t('removeHint')}
                </span>
              </span>
            </label>
          </fieldset>
        )
      })}
      <Button type="submit" variant="secondary" disabled={pending} className="self-start">
        {pending ? tActions('working') : t('saveLines')}
      </Button>
    </form>
  )
}

function TermsForm({ paymentTermDays, notesToSupplier, run, pending }: { paymentTermDays: number | null; notesToSupplier: string | null; run: (input: Save) => Promise<boolean>; pending: boolean }) {
  const t = useTranslations('purchaseOrder.actions.edit')
  const tActions = useTranslations('purchaseOrder.actions')
  const id = useId()
  const [days, setDays] = useState(paymentTermDays === null ? '' : String(paymentTermDays))
  const [note, setNote] = useState(notesToSupplier ?? '')
  const [daysError, setDaysError] = useState<string>()

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const typed = days.trim()
    // The same bounds as the service (whole days, 0 to PAYMENT_TERM_MAX_DAYS), said before anything is sent
    if (typed && (!DAYS.test(typed) || Number(typed) > PAYMENT_TERM_MAX_DAYS)) return setDaysError(t('badDays', { max: PAYMENT_TERM_MAX_DAYS }))
    setDaysError(undefined)
    const nextDays = typed ? Number(typed) : null
    const nextNote = note.trim() ? note.trim() : null
    await run({
      ...(nextDays !== paymentTermDays ? { paymentTermDays: nextDays } : {}),
      ...(nextNote !== (notesToSupplier ?? null) ? { notesToSupplier: nextNote } : {}),
    })
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby={`${id}-title`} className="flex flex-col gap-4 border-t border-line pt-4">
      <h3 id={`${id}-title`} className="font-semibold text-ink">
        {t('termsTitle')}
      </h3>
      <Field
        id={`${id}-days`}
        label={t('termDays')}
        hint={t('termHint', { max: PAYMENT_TERM_MAX_DAYS })}
        inputMode="numeric"
        autoComplete="off"
        value={days}
        onChange={(event) => {
          setDays(event.currentTarget.value)
          setDaysError(undefined)
        }}
        error={daysError}
        className="max-w-40"
      />
      <TextArea id={`${id}-note`} label={t('note')} hint={t('noteHint')} value={note} onChange={(event) => setNote(event.currentTarget.value)} rows={3} maxLength={PO_NOTE_MAX_LENGTH} />
      <Button type="submit" variant="secondary" disabled={pending} className="self-start">
        {pending ? tActions('working') : t('saveTerms')}
      </Button>
    </form>
  )
}

export function DraftEditor({ poId, version, lines, paymentTermDays, notesToSupplier, save }: DraftEditorProps) {
  const t = useTranslations('purchaseOrder')
  const id = useId()
  const action = useOutcomeAction<PoOutcome>({ ok: false, code: 'FAILED' })
  const failureText = usePoFailureText()
  const [saved, setSaved] = useState(false)

  const run = async (input: Save): Promise<boolean> => {
    setSaved(false)
    const outcome = await action.run((key) => save({ poId, expectedVersion: version, ...input }, key))
    if (outcome.ok) setSaved(true)
    return outcome.ok
  }
  const failure = action.outcome && !action.outcome.ok ? action.outcome : null

  return (
    <section aria-labelledby={`${id}-edit`} className="flex flex-col gap-4 border-t border-line pt-5">
      <h2 id={`${id}-edit`} className="text-lg font-semibold text-ink">
        {t('actions.edit.title')}
      </h2>
      {saved ? <Notice tone="success">{t('actions.edit.saved')}</Notice> : null}
      {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
      {/* Remounted at every saved version, so the fields start from what the server keeps */}
      <LinesForm key={`lines-${version}`} lines={lines} run={run} pending={action.pending} />
      <TermsForm key={`terms-${version}`} paymentTermDays={paymentTermDays} notesToSupplier={notesToSupplier} run={run} pending={action.pending} />
    </section>
  )
}
