'use client'

import { Lock, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ComponentType } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { v4 as uuidv4 } from 'uuid'
import type { FormInput } from '@/core/forms'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { ConfirmRemove } from './confirm-remove'
import { asksOffAgreementReason, catalogProblems, lineAgreement, type CatalogPick } from './catalog-lines'
import { checkboxClass, describedBy, inputClass, Labelled, textareaClass } from './controls'
import { documentFieldIds } from './document-fields'
import { FieldInput, showDay } from './field-input'
import { lineAmount, requestLineNeed, savableLine, TITLE_MAX, validDate, validMoney, validQuantity, type FormAction, type FormLine, type FormValues, type Totals } from './model'
import type { SplitPart } from './split-lines'
import { showMoney, showSatang } from './money'
import { MoneyInput } from './money-input'
import { DeliverySiteField } from './place-supplier'
import { BudgetStatus, TotalsList } from './summary'
import type { BudgetLineOption, BudgetView, CatalogSearch, RequestFormData, ScreenLocale } from './types'

// Steps 1 and 2 of the request form (FR-INT-002, FR-INT-003, FR-INT-004): the title, the budget line (prefilled,
// BR-FORM-02; only the requester's own or granted lines, BR-BUD-04) with what is left on it, the questions of the
// request type shown or hidden as the requester answers (BR-FORM-01) — but those the attachment rules ask for, which step
// 3 asks beside the documents (./document-fields.ts); then where the goods go (prefilled, S4-02), the
// lines with their amounts, the totals and the budget check as the amounts change.

export interface StepProps {
  readonly data: RequestFormData
  readonly values: FormValues
  readonly update: (action: FormAction) => void
  readonly locale: ScreenLocale
  readonly input: FormInput
  readonly visible: ReadonlySet<string>
  readonly totals: Totals | null
  /** Show what is still missing (after the requester reached the last step or tried to send) */
  readonly showErrors: boolean
  /** The selected line's balance as the server last sent it */
  readonly budget: BudgetView | null
  readonly previewLoading: boolean
  /** Errors the server reported for fields of the form (by field id) */
  readonly fieldErrors: Readonly<Record<string, string>>
  /** S6-10: the catalogue the workspace's form offers each line; absent, lines are typed only (the LIFF form) */
  readonly catalog?: CatalogOffer
  /**
   * S6-17 (BR-BUD-16): the workspace's form offers each line a budget line of its own and "แบ่งบรรทัด" (the Dialog drawn
   * with the workspace's components, ./split-line-dialog.tsx); absent in the LIFF form (ADR-052)
   */
  readonly split?: SplitOffer
  /** A refusal of the last send about a line, by line number (`lines.N.budgetLineId`), said under that line's budget line */
  readonly lineErrors?: Readonly<Record<number, string>>
}

/** S6-17: the Dialog that splits a line */
export interface SplitOffer {
  readonly Dialog: ComponentType<SplitLineProps>
}

export interface SplitLineProps {
  readonly lineNo: number
  readonly line: FormLine
  readonly priceIncludesVat: boolean
  /** The budget lines the request may use (the request's chooser's), and the request's own */
  readonly budgetLines: readonly BudgetLineOption[]
  readonly requestBudgetLineId: string
  readonly onSplit: (parts: readonly SplitPart[]) => void
}

/** The picker of a line (./catalog-picker.tsx, drawn with the workspace's components) and the search it calls */
export interface CatalogOffer {
  readonly Picker: ComponentType<CatalogPickerProps>
  readonly search: CatalogSearch
}

export interface CatalogPickerProps {
  readonly lineNo: number
  /** The line is a catalogue item already: the picker changes it */
  readonly linked: boolean
  readonly search: CatalogSearch
  readonly onPick: (item: CatalogPick) => void
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)

export function DetailsStep(props: StepProps) {
  const { data, visible } = props
  const purchase = data.type.documentType === 'PURCHASE_REQUEST'
  // A question the attachment rules ask for is asked beside the documents, in step 3 (./document-fields.ts)
  const documentFields = documentFieldIds(data.form.rules)
  return (
    <div className="flex flex-col gap-6">
      <TitleField {...props} />
      {purchase ? <BudgetLineField {...props} /> : null}
      <FormFields {...props} ids={data.form.fields.filter((f) => visible.has(f.id) && !documentFields.has(f.id)).map((f) => f.id)} />
    </div>
  )
}

/** The request's title, every request's first question */
export function TitleField({ values, update, showErrors }: StepProps) {
  const t = useTranslations('requestForm')
  const titleError = showErrors && !values.title.trim() ? t('details.titleMissing') : undefined
  return (
    <Labelled id="request-title" label={t('details.title')} requiredText={t('fields.required')} hint={t('details.titleHint')} error={titleError}>
      <input
        id="request-title"
        name="title"
        className={inputClass}
        value={values.title}
        maxLength={TITLE_MAX}
        required
        aria-required
        aria-invalid={titleError ? true : undefined}
        aria-describedby={describedBy('request-title', true, Boolean(titleError))}
        onChange={(e) => update({ type: 'title', value: e.currentTarget.value })}
      />
    </Labelled>
  )
}

/** Fields of the request type's form, by id in the form's order: shown when visible (BR-FORM-01), missing ones said under each */
export function FormFields({ data, values, update, locale, visible, showErrors, fieldErrors, ids }: StepProps & { readonly ids: readonly string[] }) {
  const t = useTranslations('requestForm')
  return (
    <>
      {data.form.fields
        .filter((f) => visible.has(f.id) && ids.includes(f.id))
        .map((def) => (
          <FieldInput
            key={def.id}
            def={def}
            locale={locale}
            value={values.fields[def.id]}
            onChange={(value) => update({ type: 'field', id: def.id, value })}
            error={fieldErrors[def.id] ?? (showErrors && def.required && blank(values.fields[def.id]) ? t('fields.missing') : undefined)}
          />
        ))}
    </>
  )
}

export function BudgetLineField({ data, values, update, showErrors, budget, previewLoading }: StepProps) {
  const t = useTranslations('requestForm.budget')
  const tf = useTranslations('requestForm.fields')
  if (data.budgetLines.length === 0) return <Notice tone="warning">{t('noLines')}</Notice>
  const line = data.budgetLines.find((l) => l.id === values.budgetLineId) ?? null
  const error = showErrors && !line ? t('chooseMissing') : undefined
  const balance = line && budget?.kind === 'LINE' && budget.budgetLineId === line.id ? budget : null
  return (
    <div className="flex flex-col gap-3">
      <Labelled id="budget-line" label={t('line')} requiredText={tf('required')} hint={t('lineHint')} error={error}>
        <select
          id="budget-line"
          name="budgetLineId"
          className={inputClass}
          value={values.budgetLineId}
          required
          aria-required
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy('budget-line', true, Boolean(error))}
          onChange={(e) => update({ type: 'budgetLine', value: e.currentTarget.value })}
        >
          <option value="">{t('choose')}</option>
          {data.budgetLines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.granted ? t('optionGranted', { code: l.code, name: l.name, department: l.departmentName }) : t('option', { code: l.code, name: l.name })}
            </option>
          ))}
        </select>
      </Labelled>
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-ink-muted">{t('department')}</dt>
        <dd>{line?.departmentName ?? data.requesterDepartmentName ?? t('dash')}</dd>
        <dt className="text-ink-muted">{t('costCenter')}</dt>
        <dd>{line ? t('costCenterValue', { code: line.costCenterCode, name: line.costCenterName }) : t('dash')}</dd>
      </dl>
      {line ? (
        <div aria-live="polite" className="grid max-w-xl grid-cols-[minmax(0,1fr)_auto] gap-x-6 border-l-4 border-info bg-surface px-3 py-2">
          <span>{t('remaining')}</span>
          {balance ? <span className="money font-semibold">{t('baht', { amount: showMoney(balance.available) })}</span> : <span className="text-ink-muted">{budget?.kind === 'NOT_USABLE' ? t('notUsableShort') : previewLoading ? t('loading') : t('unknown')}</span>}
        </div>
      ) : null}
    </div>
  )
}

export function ItemsStep(props: StepProps & { readonly endDateRequired: boolean }) {
  // The parts of a line split by the step's own width (@container), not the screen's: the LIFF column (34rem of content,
  // §9.9 "LIFF เป็นคอลัมน์เดียว") keeps its phone layout at every width, and the workspace's wider form splits as before
  return (
    <div className="@container flex flex-col gap-6">
      {/* Where every line of the request goes (S4-02): prefilled, changeable */}
      <DeliverySiteField {...props} />
      <LinesSection {...props} />
    </div>
  )
}

/** The lines with their amounts, the totals and the budget check as the amounts change (inside an @container parent) */
export function LinesSection(props: StepProps & { readonly endDateRequired: boolean }) {
  const t = useTranslations('requestForm')
  const { data, values, update, totals, budget, previewLoading } = props
  const need = requestLineNeed(values, data.vatRateBp)
  const pending = values.lines.filter((l) => (l.description.trim() || l.quantity.trim() || l.uom.trim() || l.unitPrice.trim()) && !savableLine(l)).length
  return (
    <>
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" name="priceIncludesVat" className={checkboxClass} checked={values.priceIncludesVat} onChange={(e) => update({ type: 'priceIncludesVat', value: e.currentTarget.checked })} />
        <span>{t('lines.pricesIncludeVat')}</span>
      </label>
      <ol className="flex flex-col divide-y divide-line border-y border-line">
        {values.lines.map((line, i) => (
          <li key={line.key} className="py-5">
            <LineFields {...props} line={line} n={i + 1} canRemove={values.lines.length > 1} />
          </li>
        ))}
      </ol>
      <Button variant="secondary" className="self-start" onClick={() => update({ type: 'addLine', key: uuidv4() })}>
        <Plus className="size-4" aria-hidden="true" />
        {t('lines.add')}
      </Button>
      <OffAgreementReason {...props} />
      <section aria-labelledby="totals-heading" className="flex flex-col gap-2">
        <h3 id="totals-heading" className="subheading font-semibold">
          {t('totals.title')}
        </h3>
        <div aria-live="polite">
          <TotalsList totals={totals} rateBp={data.vatRateBp} />
        </div>
        {pending ? <p className="text-base text-ink-muted md:text-sm">{t('totals.pending', { count: pending })}</p> : null}
      </section>
      <section aria-labelledby="budget-heading" className="flex flex-col gap-2">
        <h3 id="budget-heading" className="subheading font-semibold">
          {t('budget.title')}
        </h3>
        <BudgetStatus lineChosen={Boolean(values.budgetLineId)} budget={budget} need={need?.net ?? null} others={need?.others ?? 0} loading={previewLoading} />
      </section>
    </>
  )
}

/**
 * S6-10 (BR-PRC-06): why the request goes to another supplier than the agreed one of a catalogue item, asked under the
 * lines while one of them is off its agreed prices (or a reason is kept). Required before sending; the server refuses
 * the send without it (AGREEMENT_OFF).
 */
function OffAgreementReason({ values, update, showErrors, data }: StepProps) {
  const t = useTranslations('requestForm.catalog')
  const tf = useTranslations('requestForm.fields')
  if (!asksOffAgreementReason(values)) return null
  const missing = catalogProblems(values).some((p) => p.kind === 'AGREEMENT_REASON')
  const error = showErrors && missing ? t('reasonMissing') : undefined
  const supplier = (data.suppliers ?? []).find((s) => s.id === values.suggestedSupplierId)
  return (
    <Labelled
      id="off-agreement-reason"
      label={t('reasonLabel')}
      requiredText={missing ? tf('required') : undefined}
      hint={supplier ? t('reasonHint', { supplier: supplier.name }) : t('reasonHintNoSupplier')}
      error={error}
      className="max-w-xl"
    >
      <textarea
        id="off-agreement-reason"
        name="offAgreementReason"
        className={textareaClass}
        value={values.offAgreementReason ?? ''}
        maxLength={REASON_MAX_LENGTH}
        aria-required={missing || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy('off-agreement-reason', true, Boolean(error))}
        onChange={(e) => update({ type: 'offAgreementReason', value: e.currentTarget.value })}
      />
    </Labelled>
  )
}

/** S6-10: where a line stands with the catalogue — the picker, the item it is, and what its agreed prices ask */
function CatalogLine({ line, n, values, update, data, catalog }: StepProps & { line: FormLine; n: number; catalog: CatalogOffer }) {
  const t = useTranslations('requestForm.catalog')
  const state = lineAgreement(line, values)
  const offered = (data.suppliers ?? []).map((s) => s.id)
  const { Picker } = catalog
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Picker lineNo={n} linked={Boolean(line.catalogItemId)} search={catalog.search} onPick={(item) => update({ type: 'pickCatalog', key: line.key, item, offered })} />
        {line.catalogItemId ? (
          <Button variant="link" onClick={() => update({ type: 'unlinkCatalog', key: line.key })}>
            {t('unlink', { n })}
          </Button>
        ) : null}
      </div>
      {state.kind === 'LISTED' || state.kind === 'LOCKED' || state.kind === 'OFF' ? (
        <p className="text-base text-ink-muted md:text-sm">{t('fromCatalog', { code: state.item.code, name: state.item.nameTh })}</p>
      ) : null}
      {state.kind === 'OFF' ? (
        <Notice tone="warning">{t('offNote', { suppliers: state.item.agreements.map((a) => a.supplierName).join(t('join')) })}</Notice>
      ) : null}
      {state.kind === 'UNLISTED' ? <Notice tone="danger">{t('unlisted', { n })}</Notice> : null}
      {state.kind === 'LOCKED' && values.priceIncludesVat ? <Notice tone="danger">{t('beforeVat')}</Notice> : null}
    </div>
  )
}

function LineFields(props: StepProps & { line: FormLine; n: number; canRemove: boolean; endDateRequired: boolean }) {
  const { line, n, canRemove, update, values, showErrors, endDateRequired, locale, catalog, data, split } = props
  const tc = useTranslations('requestForm.catalog')
  // S6-10: a catalogue item with an agreed price with the suggested supplier takes that price, which cannot be changed
  const agreement = lineAgreement(line, values)
  const locked = agreement.kind === 'LOCKED' ? agreement.agreement : null
  const t = useTranslations('requestForm.lines')
  const tf = useTranslations('requestForm.fields')
  const p = `line-${n}`
  const set = (patch: Partial<Omit<FormLine, 'key'>>) => update({ type: 'line', key: line.key, patch })
  // A number that is not a number shows at once; a missing part once the requester reached the last step, so the line
  // they are typing is not red
  const must = showErrors
  const shown = {
    description: must && !line.description.trim() ? t('descriptionMissing') : undefined,
    quantity: line.quantity.trim() && !validQuantity(line.quantity) ? t('quantityInvalid') : must && !line.quantity.trim() ? t('quantityMissing') : undefined,
    uom: must && !line.uom.trim() ? t('uomMissing') : undefined,
    unitPrice: line.unitPrice.trim() && !validMoney(line.unitPrice) ? t('priceInvalid') : must && !line.unitPrice.trim() ? t('priceMissing') : undefined,
    end: endDateRequired && (showErrors || savableLine(line)) && !validDate(line.serviceEndDate) ? t('serviceEndDateMissing') : undefined,
  }
  const amount = lineAmount(line)
  const control = (id: string, error: string | undefined, hint = false) => ({ 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy(id, hint, Boolean(error)) })
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="mb-1 subheading font-semibold">{t('line', { n })}</legend>
      {catalog ? <CatalogLine {...props} catalog={catalog} /> : null}
      <Labelled id={`${p}-description`} label={t('description')} requiredText={tf('required')} error={shown.description}>
        <input id={`${p}-description`} className={inputClass} value={line.description} maxLength={500} required aria-required onChange={(e) => set({ description: e.currentTarget.value })} {...control(`${p}-description`, shown.description)} />
      </Labelled>
      <div className="grid grid-cols-2 gap-3 @min-[40rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
        <Labelled id={`${p}-quantity`} label={t('quantity')} requiredText={tf('required')} error={shown.quantity}>
          <input id={`${p}-quantity`} className={`${inputClass} tabular text-right`} inputMode="decimal" value={line.quantity} required aria-required onChange={(e) => set({ quantity: e.currentTarget.value })} {...control(`${p}-quantity`, shown.quantity)} />
        </Labelled>
        <Labelled id={`${p}-uom`} label={t('uom')} requiredText={tf('required')} hint={t('uomHint')} error={shown.uom}>
          <input id={`${p}-uom`} className={inputClass} value={line.uom} maxLength={30} required aria-required onChange={(e) => set({ uom: e.currentTarget.value })} {...control(`${p}-uom`, shown.uom, true)} />
        </Labelled>
        <Labelled
          id={`${p}-price`}
          className="col-span-2 @min-[40rem]:col-span-1"
          label={values.priceIncludesVat ? t('unitPriceGross') : t('unitPriceNet')}
          requiredText={tf('required')}
          hint={
            locked ? (
              <span className="inline-flex items-start gap-1.5">
                <Lock className="mt-1 size-4 shrink-0" aria-hidden="true" />
                <span>{tc('locked', { supplier: locked.supplierName })}</span>
              </span>
            ) : undefined
          }
          error={shown.unitPrice}
        >
          <MoneyInput
            id={`${p}-price`}
            className={`${inputClass} tabular text-right read-only:bg-surface`}
            value={line.unitPrice}
            required
            aria-required
            readOnly={locked !== null}
            onChange={(e) => set({ unitPrice: e.currentTarget.value })}
            {...control(`${p}-price`, shown.unitPrice, locked !== null)}
          />
        </Labelled>
      </div>
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" className={checkboxClass} checked={line.vatable} onChange={(e) => set({ vatable: e.currentTarget.checked })} />
        <span>{t('vatable')}</span>
      </label>
      {props.split && (data.budgetLines.length > 1 || line.budgetLineId) ? <LineBudgetField {...props} /> : null}
      {endDateRequired ? (
        <Labelled
          id={`${p}-end`}
          label={t('serviceEndDate')}
          requiredText={tf('required')}
          // FR-PLT-002 AC3: the date picker follows the device; the date is also said with its Buddhist-era year
          hint={validDate(line.serviceEndDate) ? t('serviceEndDateChosen', { date: showDay(line.serviceEndDate, locale) }) : t('serviceEndDateHint')}
          error={shown.end}
        >
          <input id={`${p}-end`} type="date" className={inputClass} value={line.serviceEndDate} required aria-required onChange={(e) => set({ serviceEndDate: e.currentTarget.value })} {...control(`${p}-end`, shown.end, true)} />
        </Labelled>
      ) : null}
      {/* As wide as the totals and the budget below (max-w-xl, ./summary.tsx): the line's amount ends at their right edge (§9.9 principle 6) */}
      <div className="flex max-w-xl flex-wrap items-start justify-between gap-x-6 gap-y-3">
        {split && data.budgetLines.length > 1 && amount !== null ? (
          <split.Dialog
            lineNo={n}
            line={line}
            priceIncludesVat={values.priceIncludesVat}
            budgetLines={data.budgetLines}
            requestBudgetLineId={values.budgetLineId}
            onSplit={(parts) => update({ type: 'splitLine', key: line.key, parts })}
          />
        ) : null}
        {canRemove ? (
          <ConfirmRemove
            label={t('remove', { n })}
            question={t('removeQuestion', { n })}
            // A returned request keeps what its lines reserved (§6.4); a line taken away gives its share back once saved
            detail={line.reserved ? t('removeReserved', { amount: showMoney(line.reserved) }) : undefined}
            confirmLabel={t('removeConfirm')}
            keepLabel={t('removeKeep')}
            onConfirm={() => update({ type: 'removeLine', key: line.key })}
          />
        ) : null}
        <p className="money ml-auto">{amount !== null ? t('amount', { amount: showSatang(amount) }) : t('amountPending')}</p>
      </div>
    </fieldset>
  )
}

/**
 * S6-17 (FR-BUD-102 AC1 · BR-BUD-16): the line's own budget line, from the budget lines the request's chooser offers —
 * "ตามคำขอ" (null) by default. A budget line chosen before and no longer offered stays chosen and says so; the submit
 * checks every line's like the request's, and a refusal of this line's is said under it.
 */
function LineBudgetField({ line, n, data, values, update, lineErrors }: StepProps & { line: FormLine; n: number }) {
  const t = useTranslations('requestForm.lines')
  const tb = useTranslations('requestForm.budget')
  const id = `line-${n}-budget`
  const chosen = line.budgetLineId ?? ''
  const gone = chosen !== '' && !data.budgetLines.some((l) => l.id === chosen)
  const own = data.budgetLines.find((l) => l.id === values.budgetLineId)
  const error = lineErrors?.[n]
  return (
    <Labelled id={id} label={t('budgetLine')} hint={t('budgetLineHint')} error={error} className="max-w-xl">
      <select
        id={id}
        className={inputClass}
        value={chosen}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, true, Boolean(error))}
        onChange={(e) => update({ type: 'line', key: line.key, patch: { budgetLineId: e.currentTarget.value || null } })}
      >
        <option value="">{own ? t('budgetLineSameCode', { code: own.code }) : t('budgetLineSame')}</option>
        {gone ? <option value={chosen}>{t('budgetLineGone')}</option> : null}
        {data.budgetLines.map((l) => (
          <option key={l.id} value={l.id}>
            {l.granted ? tb('optionGranted', { code: l.code, name: l.name, department: l.departmentName }) : tb('option', { code: l.code, name: l.name })}
          </option>
        ))}
      </select>
    </Labelled>
  )
}
