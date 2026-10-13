import { compareQuotations, evaluateCondition, evaluateForm, type FormInput } from '@/core/forms'
import { amountToSatang } from '@/core/money/dto'
import { documentTotals, lineNet, type Satang } from '@/core/money/math'
import { catalogIndex, pickCatalogLine, unlinkCatalogLine, withAgreedPrices, type CatalogPick, type CatalogProblem } from './catalog-lines'
import type { FormDefinition, RequestFormData } from './types'

// The request form's state and the rules the screen runs as the requester types (S2-11, §7.9): which fields show, which
// lines and quotations are complete enough to save, the totals from core/money, and what the attachment rules need.
// The server runs the same core/forms and core/money again on every save and on submit (BR-FORM-01). Pure.

export interface FormLine {
  readonly key: string
  /** The saved line's id; null until a save carried the line. Every save names it (the line keeps its budget, §6.4) */
  readonly id: string | null
  /** What the saved line holds on the budget line of a returned request, baht text; null when nothing */
  readonly reserved: string | null
  readonly description: string
  readonly quantity: string
  readonly uom: string
  readonly unitPrice: string
  readonly vatable: boolean
  readonly serviceEndDate: string
  /** S6-10: the catalogue item the line is (BR-PRC-06); absent or null: typed freely */
  readonly catalogItemId?: string | null
}

export interface FormQuotation {
  readonly key: string
  readonly supplierName: string
  readonly amount: string
  readonly includesVat: boolean
  readonly fileId: string | null
  readonly fileName: string | null
  readonly selected: boolean
  /** Stored with the draft: a save may not leave it out while it is being changed */
  readonly saved: boolean
}

export interface FormValues {
  readonly title: string
  readonly budgetLineId: string
  /** Where the goods go (S4-02, BR-FORM-02 prefill); '' while none is chosen */
  readonly deliverySiteId: string
  /** The supplier the requester suggests (optional); '' for none */
  readonly suggestedSupplierId: string
  readonly priceIncludesVat: boolean
  readonly fields: Readonly<Record<string, unknown>>
  readonly lines: readonly FormLine[]
  readonly quotations: readonly FormQuotation[]
  readonly nonLowestQuoteReason: string
  /**
   * S6-10: the catalogue items the form knows (those its lines name, and those chosen since), by id — absent in a form
   * that does not offer the catalogue (the LIFF form), whose catalogue lines the server alone checks (./catalog-lines.ts)
   */
  readonly catalog?: Readonly<Record<string, CatalogPick>>
  /** S6-10 (BR-PRC-06): why a catalogue item goes to another supplier than the agreed one; absent where the catalogue is not offered */
  readonly offAgreementReason?: string
}

export type FormAction =
  | { readonly type: 'title'; readonly value: string }
  | { readonly type: 'budgetLine'; readonly value: string }
  | { readonly type: 'deliverySite'; readonly value: string }
  | { readonly type: 'suggestedSupplier'; readonly value: string }
  | { readonly type: 'priceIncludesVat'; readonly value: boolean }
  | { readonly type: 'field'; readonly id: string; readonly value: unknown }
  | { readonly type: 'line'; readonly key: string; readonly patch: Partial<Omit<FormLine, 'key'>> }
  | { readonly type: 'addLine'; readonly key: string }
  | { readonly type: 'removeLine'; readonly key: string }
  | { readonly type: 'quotation'; readonly key: string; readonly patch: Partial<Omit<FormQuotation, 'key' | 'selected'>> }
  | { readonly type: 'addQuotation'; readonly key: string }
  | { readonly type: 'removeQuotation'; readonly key: string }
  | { readonly type: 'selectQuotation'; readonly key: string }
  | { readonly type: 'reason'; readonly value: string }
  /** S6-10: a line takes an item of the catalogue; `offered`: the suppliers the form offers to suggest */
  | { readonly type: 'pickCatalog'; readonly key: string; readonly item: CatalogPick; readonly offered: readonly string[] }
  | { readonly type: 'unlinkCatalog'; readonly key: string }
  | { readonly type: 'offAgreementReason'; readonly value: string }
  /** A save went through: lines it carried get their ids, quotations it carried count as stored */
  | { readonly type: 'saved'; readonly lines: ReadonlyArray<{ readonly key: string; readonly id: string }>; readonly quotations: readonly string[] }

export const emptyLine = (key: string): FormLine => ({ key, id: null, reserved: null, description: '', quantity: '', uom: '', unitPrice: '', vatable: true, serviceEndDate: '' })
export const emptyQuotation = (key: string): FormQuotation => ({ key, supplierName: '', amount: '', includesVat: false, fileId: null, fileName: null, selected: false, saved: false })

/** The saved choice when the form still offers it (a site or supplier closed since is chosen again), '' otherwise */
function offered(id: string | null | undefined, options: ReadonlyArray<{ readonly id: string }> | undefined): string {
  return id && (options ?? []).some((o) => o.id === id) ? id : ''
}

/** A draft names a delivery site or supplier the form no longer offers (closed or deactivated since it was saved) */
export function droppedChoice(saved: string | null | undefined, options: ReadonlyArray<{ readonly id: string }> | undefined): boolean {
  return Boolean(saved) && offered(saved, options) === ''
}

/**
 * The values a form opens with: the saved draft, or a new purchase form with one empty line, its budget line and its
 * delivery site prefilled (BR-FORM-02)
 */
export function initialValues(data: RequestFormData): FormValues {
  const opened = openingValues(data)
  // A form that offers the catalogue knows the items of its lines, and their lines take today's agreed prices (S6-10)
  return data.catalogItems ? withAgreedPrices({ ...opened, catalog: catalogIndex(data.catalogItems), offAgreementReason: data.draft?.offAgreementReason ?? '' }) : opened
}

function openingValues(data: RequestFormData): FormValues {
  const d = data.draft
  const purchase = data.type.documentType === 'PURCHASE_REQUEST'
  if (!d) {
    return {
      title: '',
      budgetLineId: data.defaultBudgetLineId ?? '',
      deliverySiteId: purchase ? offered(data.defaultDeliverySiteId, data.deliverySites) : '',
      suggestedSupplierId: '',
      priceIncludesVat: false,
      fields: {},
      lines: purchase ? [emptyLine('line-0')] : [],
      quotations: [],
      nonLowestQuoteReason: '',
    }
  }
  return {
    title: d.title,
    budgetLineId: d.budgetLineId ?? data.defaultBudgetLineId ?? '',
    // A draft keeps what it saved, also "not chosen yet"
    deliverySiteId: offered(d.deliverySiteId, data.deliverySites),
    suggestedSupplierId: offered(d.suggestedSupplierId, data.suppliers),
    priceIncludesVat: d.priceIncludesVat,
    fields: { ...d.formData },
    lines:
      d.lines.length || !purchase
        ? d.lines.map((l) => ({ ...l, key: l.id, id: l.id, reserved: l.reserved && amountToSatang(l.reserved.amount) > 0n ? l.reserved.amount : null, serviceEndDate: l.serviceEndDate ?? '' }))
        : [emptyLine('line-0')],
    quotations: d.quotations.map((q, i) => ({ key: `quote-${i}`, ...q, saved: true })),
    nonLowestQuoteReason: d.nonLowestQuoteReason,
  }
}

export function formReducer(state: FormValues, action: FormAction): FormValues {
  switch (action.type) {
    case 'title':
      return { ...state, title: action.value }
    case 'budgetLine':
      return { ...state, budgetLineId: action.value }
    case 'deliverySite':
      return { ...state, deliverySiteId: action.value }
    case 'suggestedSupplier':
      // The suggested supplier is the supplier of the lines: its agreed prices apply (BR-PRC-06)
      return withAgreedPrices({ ...state, suggestedSupplierId: action.value })
    case 'priceIncludesVat':
      return { ...state, priceIncludesVat: action.value }
    case 'field':
      return { ...state, fields: { ...state.fields, [action.id]: action.value } }
    case 'line':
      return { ...state, lines: state.lines.map((l) => (l.key === action.key ? { ...l, ...action.patch } : l)) }
    case 'addLine':
      return { ...state, lines: [...state.lines, emptyLine(action.key)] }
    case 'removeLine':
      return { ...state, lines: state.lines.filter((l) => l.key !== action.key) }
    case 'quotation':
      return { ...state, quotations: state.quotations.map((q) => (q.key === action.key ? { ...q, ...action.patch } : q)) }
    case 'addQuotation':
      return { ...state, quotations: [...state.quotations, emptyQuotation(action.key)] }
    case 'removeQuotation':
      return { ...state, quotations: state.quotations.filter((q) => q.key !== action.key) }
    case 'selectQuotation':
      // One chosen quotation at most (BR-FORM-06)
      return { ...state, quotations: state.quotations.map((q) => ({ ...q, selected: q.key === action.key })) }
    case 'reason':
      return { ...state, nonLowestQuoteReason: action.value }
    case 'pickCatalog':
      return pickCatalogLine(state, action.key, action.item, action.offered)
    case 'unlinkCatalog':
      return unlinkCatalogLine(state, action.key)
    case 'offAgreementReason':
      return { ...state, offAgreementReason: action.value }
    case 'saved': {
      const ids = new Map(action.lines.map((l) => [l.key, l.id]))
      const stored = new Set(action.quotations)
      return {
        ...state,
        lines: state.lines.map((l) => (ids.has(l.key) ? { ...l, id: ids.get(l.key)! } : l)),
        quotations: state.quotations.map((q) => (stored.has(q.key) ? { ...q, saved: true } : q)),
      }
    }
  }
}

// ---------- numbers typed by people ----------

const QUANTITY = /^\d{1,14}(\.\d{1,4})?$/
const MONEY = /^\d{1,13}(\.\d{1,2})?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** "1,234.50 " → "1234.50": thousands separators and spaces are only for reading */
export function plainNumber(text: string): string {
  return text.replace(/[\s,]/g, '')
}

export function validQuantity(text: string): boolean {
  const t = plainNumber(text)
  return QUANTITY.test(t) && /[1-9]/.test(t)
}

export function validMoney(text: string): boolean {
  return MONEY.test(plainNumber(text))
}

export const validDate = (text: string) => DATE.test(text)

// ---------- what can be saved ----------

/** A line the service accepts: item, quantity above zero, unit and unit price (the day the service ends may follow later) */
export function savableLine(line: FormLine): boolean {
  return line.description.trim().length > 0 && line.uom.trim().length > 0 && validQuantity(line.quantity) && validMoney(line.unitPrice)
}

export function savableQuotation(q: FormQuotation): boolean {
  return q.supplierName.trim().length > 0 && validMoney(q.amount)
}

export interface DraftPayload {
  readonly title?: string
  readonly budgetLineId?: string | null
  readonly deliverySiteId?: string | null
  readonly suggestedSupplierId?: string | null
  readonly priceIncludesVat: boolean
  readonly formData: Record<string, unknown>
  readonly lines?: Array<{ id: string | null; description: string; quantity: string; uom: string; unitPrice: string; vatable: boolean; serviceEndDate?: string; catalogItemId: string | null; categoryCode?: string }>
  readonly quotations?: Array<{ supplierName: string; amount: string; includesVat: boolean; fileId?: string; selected: boolean }>
  readonly nonLowestQuoteReason?: string | null
  readonly offAgreementReason?: string | null
}

/** One save: what it sends, and which lines and quotations of the screen it carries (in order) */
export interface DraftSave {
  readonly draft: DraftPayload
  /** Keys of the lines sent, in order; null when the lines were left out */
  readonly lineKeys: readonly string[] | null
  /** Keys of the quotations sent; null when they were left out */
  readonly quotationKeys: readonly string[] | null
}

/** Longest title the service takes */
export const TITLE_MAX = 200

/**
 * What an autosave sends (FR-INT-006 AC1). A save changes only the parts it carries, so it never takes away what the
 * requester did not take away:
 * - lines go only while every saved line is complete; a saved line being retyped holds them all back (the server keeps
 *   them as they were), and each line names its id, so it keeps its content and the budget it holds (§6.4). A new line
 *   is sent once it is complete.
 * - quotations likewise: a saved quotation being changed holds them back; a new one goes once complete.
 * - a blank title is never sent for a saved draft (the stored one stays); a new draft starts under the type's name.
 */
export function draftPayload(values: FormValues, typeName: string, isNew: boolean): DraftSave {
  const title = values.title.trim().slice(0, TITLE_MAX)
  const linesReady = values.lines.every((l) => l.id === null || savableLine(l))
  const sentLines = linesReady ? values.lines.filter(savableLine) : null
  const quotesReady = values.quotations.every((q) => !q.saved || savableQuotation(q))
  const sentQuotes = quotesReady ? values.quotations.filter(savableQuotation) : null
  const reason = values.nonLowestQuoteReason.trim()
  const offReason = (values.offAgreementReason ?? '').trim()
  const draft: DraftPayload = {
    ...(title ? { title } : isNew ? { title: typeName.slice(0, TITLE_MAX) } : {}),
    ...(values.budgetLineId ? { budgetLineId: values.budgetLineId } : isNew ? {} : { budgetLineId: null }),
    // The site and the suggested supplier: chosen ones go; one taken away is cleared (null) on a saved draft
    ...(values.deliverySiteId ? { deliverySiteId: values.deliverySiteId } : isNew ? {} : { deliverySiteId: null }),
    ...(values.suggestedSupplierId ? { suggestedSupplierId: values.suggestedSupplierId } : isNew ? {} : { suggestedSupplierId: null }),
    priceIncludesVat: values.priceIncludesVat,
    formData: { ...values.fields },
    ...(sentLines
      ? {
          lines: sentLines.map((l) => ({
            id: l.id,
            description: l.description.trim(),
            quantity: plainNumber(l.quantity),
            uom: l.uom.trim(),
            unitPrice: plainNumber(l.unitPrice),
            vatable: l.vatable,
            ...(validDate(l.serviceEndDate) ? { serviceEndDate: l.serviceEndDate } : {}),
            // S6-10: every line says whether it is a catalogue item; one the form knows brings the item's category
            catalogItemId: l.catalogItemId ?? null,
            ...(l.catalogItemId && values.catalog?.[l.catalogItemId] ? { categoryCode: values.catalog[l.catalogItemId]!.categoryCode } : {}),
          })),
        }
      : {}),
    ...(sentQuotes
      ? {
          quotations: sentQuotes.map((q) => ({
            supplierName: q.supplierName.trim(),
            amount: plainNumber(q.amount),
            includesVat: q.includesVat,
            ...(q.fileId ? { fileId: q.fileId } : {}),
            selected: q.selected,
          })),
        }
      : {}),
    ...(reason ? { nonLowestQuoteReason: reason } : isNew ? {} : { nonLowestQuoteReason: null }),
    // Only a form that offers the catalogue asks it, so only such a form clears it (the LIFF form leaves it as saved)
    ...(offReason ? { offAgreementReason: offReason } : isNew || values.offAgreementReason === undefined ? {} : { offAgreementReason: null }),
  }
  return { draft, lineKeys: sentLines ? sentLines.map((l) => l.key) : null, quotationKeys: sentQuotes ? sentQuotes.map((q) => q.key) : null }
}

/** Quotations compared before VAT as they are typed (BR-FORM-06, GC-FORM-09 to GC-FORM-11): prices and the lowest, by key */
export function compareFormQuotations(values: FormValues, rateBp: number | null): { readonly nets: Readonly<Record<string, Satang>>; readonly lowest: readonly string[] } {
  const quoted = values.quotations.filter(savableQuotation)
  if (rateBp === null || quoted.length === 0) return { nets: {}, lowest: [] }
  const compared = compareQuotations(
    quoted.map((q) => ({ ref: q.key, amountSatang: amountToSatang(plainNumber(q.amount)), includesVat: q.includesVat })),
    quoted.find((q) => q.selected)?.key ?? null,
    rateBp,
    values.nonLowestQuoteReason,
  )
  return { nets: compared.nets, lowest: compared.lowest }
}

// ---------- totals ----------

export interface Totals {
  readonly net: Satang
  readonly vat: Satang
  readonly gross: Satang
}

/** BR-VAT-02: the document totals of the lines that will be sent, with today's rate (submit computes them again) */
export function totalsOf(values: FormValues, rateBp: number | null): Totals | null {
  if (rateBp === null) return null
  const lines = values.lines.filter(savableLine).map((l) => ({ quantity: plainNumber(l.quantity), unitPriceSatang: amountToSatang(plainNumber(l.unitPrice)), vatable: l.vatable }))
  return documentTotals(lines, rateBp, values.priceIncludesVat)
}

/** The amount of one line (quantity × unit price, BR-MONEY-02 (1)); null until both are numbers */
export function lineAmount(line: FormLine): Satang | null {
  if (!validQuantity(line.quantity) || !validMoney(line.unitPrice)) return null
  return lineNet(plainNumber(line.quantity), amountToSatang(plainNumber(line.unitPrice)))
}

// ---------- conditions and attachment rules ----------

/** Attachments by kind as the server will count them once saved: the files of quotations are QUOTATION */
export function attachmentCounts(values: FormValues, attachments: ReadonlyArray<{ readonly kind: string }>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const a of attachments) counts[a.kind] = (counts[a.kind] ?? 0) + 1
  const quoted = values.quotations.filter((q) => savableQuotation(q) && q.fileId).length
  if (quoted) counts.QUOTATION = (counts.QUOTATION ?? 0) + quoted
  return counts
}

export function formInput(values: FormValues, attachments: ReadonlyArray<{ readonly kind: string }>, totals: Totals | null, requestTypeCode: string): FormInput {
  return {
    fields: values.fields,
    attachments: attachmentCounts(values, attachments),
    variables: { $amountGross: totals?.gross ?? 0n, $amountNet: totals?.net ?? 0n, $requestType: requestTypeCode },
  }
}

/** FR-INT-002 AC1: the fields shown now (BR-FORM-01: a hidden field is dropped and never checked) */
export function visibleFieldIds(form: FormDefinition, input: FormInput): Set<string> {
  const hidden = new Set(form.visibility.filter((v) => !evaluateCondition(v.when, input)).map((v) => v.field))
  return new Set(form.fields.map((f) => f.id).filter((id) => !hidden.has(id)))
}

/** The fields as the rules see them: hidden ones dropped exactly as evaluateForm drops them on the server (BR-FORM-01) */
export function visibleInput(form: FormDefinition, input: FormInput): FormInput {
  const dropped = evaluateForm({ visibility: form.visibility, rules: [] }, input)
  return dropped.ok ? { ...input, fields: dropped.fields } : input
}

/** BR-FORM-05: whether lines must carry the day the service ends, for the current answers */
export function needsServiceEndDate(form: FormDefinition, input: FormInput): boolean {
  const rule = form.lines.serviceEndDate
  return rule ? evaluateCondition(rule.when, visibleInput(form, input)) : false
}

export interface RuleStatus {
  readonly id: string
  /** What the rule asks for: kinds and counts, fields that must be filled, any/all */
  readonly require: FormDefinition['rules'][number]['require']
  /** Why it applies now (its `when`) */
  readonly when: FormDefinition['rules'][number]['when']
  readonly met: boolean
}

/** FR-INT-005 AC1: the attachment rules that apply to the request as it is now, each met or not (BR-FORM-03) */
export function applicableRules(form: FormDefinition, input: FormInput): RuleStatus[] {
  const visible = visibleInput(form, input)
  return form.rules
    .filter((rule) => evaluateCondition(rule.when, visible))
    .map((rule) => ({ id: rule.id, require: rule.require, when: rule.when, met: evaluateForm({ visibility: form.visibility, rules: [rule] }, input).ok }))
}

// ---------- what still needs doing before sending ----------

export type Problem =
  | { readonly kind: 'TITLE' }
  | { readonly kind: 'BUDGET_LINE' }
  | { readonly kind: 'NO_LINES' }
  | { readonly kind: 'LINE_INCOMPLETE'; readonly lineNo: number }
  | { readonly kind: 'SERVICE_END_DATE'; readonly lineNo: number }
  | { readonly kind: 'FIELD_REQUIRED'; readonly fieldId: string }
  | { readonly kind: 'QUOTATION_INCOMPLETE'; readonly quotationNo: number }
  | { readonly kind: 'QUOTATION_FILE'; readonly quotationNo: number }
  | { readonly kind: 'QUOTATION_CHOOSE' }
  | { readonly kind: 'QUOTATION_REASON' }
  | { readonly kind: 'ATTACHMENTS'; readonly ruleId: string }

/** A problem the workspace's form lists: those of every form, and the catalogue's (S6-10, ./catalog-lines.ts) */
export type FormProblem = Problem | CatalogProblem

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)

/**
 * What the screen can already tell is missing (the server decides at submit). `lowestKeys` are the quotations with the
 * lowest price before VAT (core/forms compareQuotations), when there are any.
 */
export function problemsOf(data: RequestFormData, values: FormValues, input: FormInput, lowestKeys: readonly string[]): Problem[] {
  const problems: Problem[] = []
  const purchase = data.type.documentType === 'PURCHASE_REQUEST'
  if (!values.title.trim()) problems.push({ kind: 'TITLE' })
  if (purchase && !values.budgetLineId) problems.push({ kind: 'BUDGET_LINE' })
  const visible = visibleFieldIds(data.form, input)
  for (const f of data.form.fields) if (f.required && visible.has(f.id) && blank(values.fields[f.id])) problems.push({ kind: 'FIELD_REQUIRED', fieldId: f.id })
  if (purchase) {
    const endDate = needsServiceEndDate(data.form, input)
    if (!values.lines.some(savableLine)) problems.push({ kind: 'NO_LINES' })
    values.lines.forEach((l, i) => {
      const touched = l.description.trim() || l.quantity.trim() || l.uom.trim() || l.unitPrice.trim()
      if (touched && !savableLine(l)) problems.push({ kind: 'LINE_INCOMPLETE', lineNo: i + 1 })
      else if (endDate && savableLine(l) && !validDate(l.serviceEndDate)) problems.push({ kind: 'SERVICE_END_DATE', lineNo: i + 1 })
    })
    values.quotations.forEach((q, i) => {
      if (!savableQuotation(q)) problems.push({ kind: 'QUOTATION_INCOMPLETE', quotationNo: i + 1 })
      else if (!q.fileId) problems.push({ kind: 'QUOTATION_FILE', quotationNo: i + 1 })
    })
    const quoted = values.quotations.filter(savableQuotation)
    const chosen = quoted.find((q) => q.selected)
    if (quoted.length && !chosen) problems.push({ kind: 'QUOTATION_CHOOSE' })
    if (chosen && lowestKeys.length && !lowestKeys.includes(chosen.key) && !values.nonLowestQuoteReason.trim()) problems.push({ kind: 'QUOTATION_REASON' })
  }
  for (const rule of applicableRules(data.form, input)) if (!rule.met) problems.push({ kind: 'ATTACHMENTS', ruleId: rule.id })
  return problems
}

/** No field of the form is asked beside the documents */
const NO_DOCUMENT_FIELDS: ReadonlySet<string> = new Set()

/**
 * The step where each problem is fixed. A field the attachment rules ask to be filled is asked beside the documents
 * (`documentFields`, ./document-fields.ts), every other field with the request's details.
 */
export function problemStep(p: FormProblem, documentFields: ReadonlySet<string> = NO_DOCUMENT_FIELDS): 'details' | 'items' | 'documents' {
  switch (p.kind) {
    case 'FIELD_REQUIRED':
      return documentFields.has(p.fieldId) ? 'documents' : 'details'
    case 'TITLE':
    case 'BUDGET_LINE':
      return 'details'
    case 'NO_LINES':
    case 'LINE_INCOMPLETE':
    case 'SERVICE_END_DATE':
    case 'AGREEMENT_REASON':
    case 'AGREEMENT_BEFORE_VAT':
    case 'CATALOG_UNLISTED':
      return 'items'
    default:
      return 'documents'
  }
}
