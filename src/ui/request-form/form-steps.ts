import type { FieldDef, FieldType } from '@/core/forms/fields'
import { documentFieldIds } from './document-fields'
import type { Problem } from './model'
import { failureKey, failureTarget, type FormFailure } from './outcome'
import type { FormDefinition } from './types'

// The steps of the workspace's request form (FR-INT-011 AC2, §9.10 "ฟอร์มทีละขั้น"): the form's own steps when its
// version has them (FormVersion.schema.steps), otherwise the six automatic ones of §9.10 — details; items, prices and
// budget; supplier and quotations; further questions; documents; check and send. A step with nothing to show is
// skipped, so every published form works unchanged. Steps change no rule: the server checks the whole form on every
// save and submit (BR-FORM-01); a step only decides where a field is asked and what "ถัดไป" checks first (AC3). Pure,
// so the grouping is tested with every seeded form (tests/unit/request-form-steps.test.ts). The LIFF form keeps its own
// three steps (S16-11 changes only its colours).

export const AUTO_STEPS = ['details', 'items', 'supplier', 'questions', 'documents', 'review'] as const
export type AutoStep = (typeof AUTO_STEPS)[number]

/** The parts of the form that are not fields of its version: every purchase request has them (S2-11, S4-02, S3-07) */
export type Section = 'title' | 'deliverySite' | 'budgetLine' | 'lines' | 'supplier' | 'quotations' | 'rules' | 'files'

export interface PlannedStep {
  /** The automatic step's id, or the key of the form's own step */
  readonly key: string
  readonly auto: AutoStep | null
  /** The title of the form's own step in both languages; an automatic step's title is a message */
  readonly title: { readonly th: string; readonly en: string } | null
  /** Ids of the visible fields asked on this step, in the form's order */
  readonly fields: readonly string[]
  readonly sections: readonly Section[]
  /** Shown as "ไม่บังคับ" beside the step */
  readonly optional: boolean
}

/**
 * The screening questions of BR-FORM-05, by the ids the rule names: asked on the questions step. The spec names them for
 * every organization's IT and service forms, so they are no organization's own code (§17.3).
 */
export const SCREENING_FIELDS: ReadonlySet<string> = new Set(['processesPersonalData', 'accessesSystems', 'accessesPremises'])

/** Where a field of each type is asked when the form has no steps of its own (the table of §9.10) */
const STEP_OF_TYPE: Readonly<Record<FieldType, AutoStep>> = {
  text: 'details',
  textarea: 'details',
  number: 'details',
  date: 'details',
  select: 'details',
  multiselect: 'details',
  checkbox: 'details',
  member: 'details',
  department: 'details',
  deliverySite: 'details',
  lineItems: 'items',
  money: 'items',
  budgetLine: 'items',
  costCenter: 'items',
  supplier: 'supplier',
  attachment: 'documents',
}

/** Where the parts of a purchase request that are not fields go (the same table: the delivery site is a detail) */
const STEP_OF_SECTION: Readonly<Record<Section, AutoStep>> = {
  title: 'details',
  deliverySite: 'details',
  budgetLine: 'items',
  lines: 'items',
  supplier: 'supplier',
  quotations: 'supplier',
  rules: 'documents',
  files: 'documents',
}

/**
 * The automatic step of one field. A question the attachment rules ask to be answered (the single-source reason of
 * ATT-QUOTES) stays beside those rules on the documents step, as on the LIFF form (./document-fields.ts); a screening
 * question, and a question shown only under a condition on an earlier answer, is a further question.
 */
function autoStepOf(def: FieldDef, form: FormDefinition, asked: ReadonlySet<string>): AutoStep {
  if (asked.has(def.id)) return 'documents'
  const step = STEP_OF_TYPE[def.type]
  if (step === 'details' && (SCREENING_FIELDS.has(def.id) || form.visibility.some((v) => v.field === def.id))) return 'questions'
  return step
}

export interface StepPlanInput {
  readonly form: FormDefinition
  readonly purchase: boolean
  /** Ids of the fields shown with the answers so far (core/forms, BR-FORM-01) */
  readonly visible: ReadonlySet<string>
  /** The request may hold files of its own (the type has attachment kinds, or the draft holds some) */
  readonly filesAllowed: boolean
  /** Ids of the attachment rules that apply at the current amount and answers */
  readonly applicableRules: readonly string[]
}

/**
 * The steps the requester goes through, in order, with the fields and parts each holds. Without steps of its own the
 * form gets the automatic ones; with them, the fields they list are asked there, every other field on the details step
 * (§9.10), and the parts that are not fields keep their automatic steps around them: details, the form's own steps,
 * items, supplier, documents, check and send. A step with no field and no part to show is skipped. The documents step
 * stays while the request may hold files — a new-supplier request attaches its registry proof there although no rule
 * asks for one (S2-11) — and is "ไม่บังคับ" while no rule applies and no file field is required.
 */
export function planSteps({ form, purchase, visible, filesAllowed, applicableRules }: StepPlanInput): PlannedStep[] {
  const asked = documentFieldIds(form.rules)
  const own = form.steps ?? []
  const listed = new Set(own.flatMap((s) => s.fields))
  const autoFields = new Map<AutoStep, string[]>(AUTO_STEPS.map((s) => [s, []]))
  for (const def of form.fields) {
    if (!visible.has(def.id) || listed.has(def.id)) continue
    autoFields.get(own.length ? 'details' : autoStepOf(def, form, asked))!.push(def.id)
  }
  const sections = new Map<AutoStep, Section[]>(AUTO_STEPS.map((s) => [s, []]))
  const parts: readonly Section[] = purchase ? ['title', 'deliverySite', 'budgetLine', 'lines', 'supplier', 'quotations', 'rules', 'files'] : ['title', 'rules', 'files']
  for (const part of parts) sections.get(STEP_OF_SECTION[part])!.push(part)
  if (form.rules.length === 0) sections.set('documents', filesAllowed ? ['files'] : [])

  const autoStep = (id: AutoStep): PlannedStep => {
    const fields = autoFields.get(id)!
    const required = form.fields.some((f) => fields.includes(f.id) && f.required && f.type === 'attachment')
    return { key: id, auto: id, title: null, fields, sections: sections.get(id)!, optional: id === 'documents' && applicableRules.length === 0 && !required }
  }
  const ownSteps: PlannedStep[] = own.map((s) => ({
    key: s.key,
    auto: null,
    title: { th: s.titleTh, en: s.titleEn },
    fields: form.fields.filter((f) => s.fields.includes(f.id) && visible.has(f.id)).map((f) => f.id),
    sections: [],
    optional: s.optional,
  }))
  const order: PlannedStep[] = own.length
    ? [autoStep('details'), ...ownSteps, autoStep('items'), autoStep('supplier'), autoStep('documents'), autoStep('review')]
    : AUTO_STEPS.map(autoStep)
  return order.filter((s) => s.auto === 'review' || s.fields.length > 0 || s.sections.length > 0)
}

/** What a problem or a refusal is about: a field of the form, or one of the parts that are not fields */
export type StepTarget = { readonly field: string } | { readonly section: Section }

/** The part of the form that fixes each problem "ตรวจก่อนส่ง" lists */
export function targetOfProblem(p: Problem): StepTarget {
  switch (p.kind) {
    case 'FIELD_REQUIRED':
      return { field: p.fieldId }
    case 'TITLE':
      return { section: 'title' }
    case 'BUDGET_LINE':
      return { section: 'budgetLine' }
    case 'NO_LINES':
    case 'LINE_INCOMPLETE':
    case 'SERVICE_END_DATE':
      return { section: 'lines' }
    case 'QUOTATION_INCOMPLETE':
    case 'QUOTATION_FILE':
    case 'QUOTATION_CHOOSE':
    case 'QUOTATION_REASON':
      return { section: 'quotations' }
    case 'ATTACHMENTS':
      return { section: 'rules' }
  }
}

const BUDGET_LINE_KEYS: ReadonlySet<string> = new Set(['CHOOSE_BUDGET_LINE', 'NO_BUDGET_LINE', 'BUDGET_LINE_YEAR', 'BUDGET_LINE_NOT_ALLOWED', 'BUDGET_LINE_CLOSED'])

/** The part of the form that fixes what the server refused; null when nothing in the form can fix it */
export function targetOfFailure(f: FormFailure): StepTarget | null {
  const key = failureKey(f)
  const field = f.field ?? ''
  const fieldId = failureTarget(f).fieldId
  if (fieldId) return { field: fieldId }
  if (key === 'FORM_FIELD' || field.startsWith('formData.') || field === 'title') return { section: 'title' }
  if (BUDGET_LINE_KEYS.has(key)) return { section: 'budgetLine' }
  if (key === 'SITE_UNKNOWN') return { section: 'deliverySite' }
  if (key === 'NO_LINES' || key === 'SERVICE_END_DATE' || key === 'BUDGET_INSUFFICIENT' || field.startsWith('lines')) return { section: 'lines' }
  if (key === 'SUPPLIER_UNKNOWN') return { section: 'supplier' }
  if (key.startsWith('QUOTE_') || field.startsWith('quotations') || field === 'nonLowestQuoteReason') return { section: 'quotations' }
  if (key === 'ATTACHMENT_RULE_FAILED') return { section: 'rules' }
  return null
}

/** The step that holds a target; the details step when no step shows it (a field hidden since, or a part not offered) */
export function stepOfTarget(steps: readonly PlannedStep[], target: StepTarget): PlannedStep {
  const found = steps.find((s) => ('field' in target ? s.fields.includes(target.field) : s.sections.includes(target.section)))
  return found ?? steps[0]!
}

/**
 * Problems "ถัดไป" stops on (AC3): what the requester types on the step. A quotation's file and the attachment rules
 * are left to the documents and the check before sending — the file may come later, and the server checks the rules
 * when the request is sent (BR-FORM-03) — and no budget line to choose stops nothing, as there is none to choose.
 */
export function stopsNext(p: Problem, hasBudgetLines: boolean): boolean {
  if (p.kind === 'ATTACHMENTS' || p.kind === 'QUOTATION_FILE') return false
  if (p.kind === 'BUDGET_LINE') return hasBudgetLines
  return true
}
