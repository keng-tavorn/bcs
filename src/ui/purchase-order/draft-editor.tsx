'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { satangOf } from '@/core/forms/money-text'
import { parseQuantity } from '@/core/money/math'
import { PAYMENT_TERM_MAX_DAYS, PO_NOTE_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useOutcomeAction } from '../procurement/use-outcome-action'
import { readableMoney } from '../request-form/money'
import { TextArea } from '../request-view/text-area'
import { type PoOutcome } from './outcome'
import { usePoFailureText } from './po-actions'

// Editing a draft PO (spec FR-P2P-003 AC2, BR-CONS-04), one line at a time: the lines are listed with their unit price
// and quantity, and a line's button opens a form of its own — the price, the quantity (never more than what its request
// line has left, told before typing, §9.9 principle 3) and taking the line back to the pool — so no form on the page asks
// more than three things (§9.9: no single long form of more than 8 fields); the payment terms and the note to the
// supplier have their own form. A form sends only what changed with the version the page was opened at, so a draft
// changed elsewhere is refused (CONFLICT_VERSION) rather than overwritten. Prices read with thousands separators and two
// decimals (§9.9 principle 6); the separators are taken out before a price is checked, compared or sent, and money stays
// text, never a number. The browser sends prices and quantities; the totals come back from core on the server (AC3). A
// field's error goes as soon as the field changes.

const QUANTITY = /^\d{1,14}(\.\d{1,4})?$/
const DAYS = /^\d{1,4}$/

/** "1,234.50 " → "1234.50": separators and spaces are only for reading (as the request form's plainNumber) */
const plain = (text: string): string => text.replace(/[\s,]/g, '')

export interface DraftLineEdit {
  readonly id: string
  readonly no: number
  readonly description: string
  readonly uom: string
  /** Decimal text as stored, e.g. "20" or "1.5" */
  readonly quantity: string
  /** Baht as the page shows it: thousands separators and 2 decimals, e.g. "1,500.00" */
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
type LineErrors = { price?: string | undefined; quantity?: string | undefined }

/** Why a line's price or quantity cannot be sent (keys of purchaseOrder.actions.edit) */
export interface LineProblems {
  readonly price?: 'badPrice'
  readonly quantity?: 'badQuantity' | 'overMax'
}

export type LineChange = { readonly ok: true; readonly edit: { readonly poLineId: string; readonly unitPrice?: string; readonly quantity?: string } | null } | { readonly ok: false; readonly problems: LineProblems }

/**
 * What one line's form sends (FR-P2P-003 AC2): the price and the quantity that changed, or nothing when neither did — the
 * price without its separators (§9.9 principle 6), the quantity never above what the request line has left — or why it
 * cannot be sent, as the service would refuse it. Money stays text: the typed price is compared with the line's as an
 * amount in satang (bigint), never as a number, so "1200" and "1,200.00" are the same price.
 */
export function lineChange(line: Pick<DraftLineEdit, 'id' | 'unitPrice' | 'quantity' | 'maxQuantity'>, typed: { readonly price: string; readonly quantity: string }): LineChange {
  const price = plain(typed.price)
  const quantity = typed.quantity.trim()
  const satang = satangOf(price)
  const problems: { price?: 'badPrice'; quantity?: 'badQuantity' | 'overMax' } = {}
  if (satang === null) problems.price = 'badPrice'
  if (line.maxQuantity !== null) {
    if (!QUANTITY.test(quantity) || parseQuantity(quantity) <= 0n) problems.quantity = 'badQuantity'
    else if (parseQuantity(quantity) > parseQuantity(line.maxQuantity)) problems.quantity = 'overMax'
  }
  if (problems.price || problems.quantity) return { ok: false, problems }
  const newPrice = satang !== satangOf(plain(line.unitPrice))
  // A line that orders several request lines keeps its quantity (its field is shut)
  const newQuantity = line.maxQuantity !== null && parseQuantity(quantity) !== parseQuantity(line.quantity)
  if (!newPrice && !newQuantity) return { ok: true, edit: null }
  return { ok: true, edit: { poLineId: line.id, ...(newPrice ? { unitPrice: price } : {}), ...(newQuantity ? { quantity } : {}) } }
}

/**
 * One line's form: its unit price, its quantity, or taking it off. `alone`: the draft has no other line, so taking it off
 * is refused before anything is sent. A price reads grouped again once the field is left ("1150" → "1,150.00"); text
 * that is no amount stays as typed, with its error.
 */
function LineForm({ line, base, alone, run, pending, onClose }: { line: DraftLineEdit; base: string; alone: boolean; run: (input: Save) => Promise<boolean>; pending: boolean; onClose: () => void }) {
  const t = useTranslations('purchaseOrder.actions.edit')
  const tActions = useTranslations('purchaseOrder.actions')
  const [price, setPrice] = useState(line.unitPrice)
  const [quantity, setQuantity] = useState(line.quantity)
  const [remove, setRemove] = useState(false)
  const [errors, setErrors] = useState<LineErrors>({})
  const [formError, setFormError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (remove) {
      // A draft keeps at least one line, and a whole draft cannot be thrown away yet
      if (alone) return setFormError(t('allRemoved'))
      await run({ lines: [], removeLineIds: [line.id] })
      return
    }
    const change = lineChange(line, { price, quantity })
    if (!change.ok) {
      const { problems } = change
      return setErrors({
        ...(problems.price ? { price: t('badPrice') } : {}),
        ...(problems.quantity ? { quantity: problems.quantity === 'overMax' ? t('overMax', { max: line.maxQuantity ?? '' }) : t('badQuantity') } : {}),
      })
    }
    setErrors({})
    // Nothing changed is still asked of the service, which says so (as the whole form did)
    await run({ lines: change.edit ? [change.edit] : [], removeLineIds: [] })
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="float-left mb-1 w-full font-medium break-words text-ink">{t('lineLegend', { no: line.no, description: line.description })}</legend>
        {formError ? <Notice tone="danger">{formError}</Notice> : null}
        {/* Two columns by the list's width, as the closed lines go beside their buttons (LinesPart) */}
        <div className="grid gap-3 @min-[28rem]:grid-cols-2">
          <Field
            id={`${base}-price`}
            label={t('price')}
            inputMode="decimal"
            autoComplete="off"
            value={price}
            disabled={remove}
            onChange={(event) => {
              setPrice(event.currentTarget.value)
              setErrors((current) => ({ ...current, price: undefined }))
              setFormError(null)
            }}
            onBlur={(event) => {
              const shown = readableMoney(event.currentTarget.value)
              if (shown !== null) setPrice(shown)
            }}
            error={errors.price}
            className="text-right tabular"
          />
          <Field
            id={`${base}-quantity`}
            label={t('quantity', { uom: line.uom })}
            inputMode="decimal"
            autoComplete="off"
            value={quantity}
            disabled={remove || line.maxQuantity === null}
            hint={line.maxQuantity === null ? t('mergedHint') : t('maxHint', { max: line.maxQuantity, uom: line.uom })}
            onChange={(event) => {
              setQuantity(event.currentTarget.value)
              setErrors((current) => ({ ...current, quantity: undefined }))
              setFormError(null)
            }}
            error={errors.quantity}
            className="text-right tabular"
          />
        </div>
        <label htmlFor={`${base}-remove`} className="flex min-h-11 items-start gap-3">
          <input
            id={`${base}-remove`}
            type="checkbox"
            checked={remove}
            onChange={(event) => {
              setRemove(event.currentTarget.checked)
              setFormError(null)
            }}
            aria-describedby={`${base}-remove-hint`}
            className="mt-1 size-5 shrink-0 accent-[var(--primary)]"
          />
          <span className="flex flex-col">
            <span className="text-ink">{t('remove')}</span>
            <span id={`${base}-remove-hint`} className="text-base text-ink-muted md:text-sm">
              {t('removeHint')}
            </span>
          </span>
        </label>
      </fieldset>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? tActions('working') : t('saveLine', { no: line.no })}
        </Button>
        <Button variant="link" onClick={onClose} disabled={pending} className="min-h-11">
          {t('closeLine')}
        </Button>
      </div>
    </form>
  )
}

/**
 * The draft's lines with their unit price and quantity, each with the button that opens its form; one line is open at a
 * time. The focus goes to the price of the line opened, and back to its button when it closes without saving.
 */
function LinesPart({ lines, run, pending }: { lines: readonly DraftLineEdit[]; run: (input: Save) => Promise<boolean>; pending: boolean }) {
  const t = useTranslations('purchaseOrder.actions.edit')
  const id = useId()
  const [open, setOpen] = useState<string | null>(null)
  /** The line whose form closed without saving: its button takes the focus back */
  const closed = useRef<string | null>(null)
  useEffect(() => {
    if (open) document.getElementById(`${id}-${open}-price`)?.focus()
    else if (closed.current) document.getElementById(`${id}-${closed.current}-edit`)?.focus()
  }, [open, id])

  return (
    // A line goes beside its button by the list's own width, not the screen's, as the PO's lines above do: on a laptop
    // the menu and the aside leave the PO's column narrow, and there each line stacks as on a phone rather than squeeze
    // its labels. From 28rem the price's label, a price of 12 figures, the button and the gaps fit one row (about 27rem)
    <div className="@container flex flex-col gap-3">
      <h3 id={`${id}-title`} className="font-semibold text-ink">
        {t('linesTitle')}
      </h3>
      {/* The terms' form below draws the rule under the last line */}
      <ul aria-labelledby={`${id}-title`} className="flex flex-col divide-y divide-line border-t border-line">
        {lines.map((line) => (
          <li key={line.id} className="py-3">
            {open === line.id ? (
              <LineForm
                line={line}
                base={`${id}-${line.id}`}
                alone={lines.length === 1}
                run={run}
                pending={pending}
                onClose={() => {
                  closed.current = line.id
                  setOpen(null)
                }}
              />
            ) : (
              <div className="flex flex-col gap-2 @min-[28rem]:flex-row @min-[28rem]:items-start @min-[28rem]:justify-between @min-[28rem]:gap-6">
                {/* Beside the button, the line takes the room left and its list the same 24rem on every line, so the
                    prices end on one right edge and their decimals line up (§9.9 principle 6) */}
                <div className="flex min-w-0 flex-col gap-1 @min-[28rem]:flex-1">
                  <p className="font-medium break-words text-ink">{t('lineLegend', { no: line.no, description: line.description })}</p>
                  <dl className="flex w-full flex-col gap-0.5 @min-[28rem]:max-w-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-ink-muted">{t('price')}</dt>
                      <dd className="money text-ink">{line.unitPrice}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-ink-muted">{t('quantity', { uom: line.uom })}</dt>
                      <dd className="tabular text-ink">{line.quantity}</dd>
                    </div>
                  </dl>
                </div>
                <Button
                  id={`${id}-${line.id}-edit`}
                  variant="secondary"
                  onClick={() => {
                    closed.current = null
                    setOpen(line.id)
                  }}
                  className="shrink-0 self-start"
                >
                  {t('editLine', { no: line.no })}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
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
      {/* Remounted at every saved version, so the lines and fields start from what the server keeps, every line closed */}
      <LinesPart key={`lines-${version}`} lines={lines} run={run} pending={action.pending} />
      <TermsForm key={`terms-${version}`} paymentTermDays={paymentTermDays} notesToSupplier={notesToSupplier} run={run} pending={action.pending} />
    </section>
  )
}
