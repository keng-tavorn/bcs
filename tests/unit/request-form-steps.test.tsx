import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FieldDef } from '@/core/forms/fields'
import { formDefinition, FormSchemaJson } from '@/server/forms/schema'
import { loadSeedForms } from '@/server/seed/forms'
import { parseFormJson } from '@/server/services/request-types/form-import'
import { planSteps, SCREENING_FIELDS, stepOfTarget, stopsNext, targetOfFailure, targetOfProblem, type PlannedStep } from '@/ui/request-form/form-steps'
import { applicableRules, formInput, initialValues, problemsOf, totalsOf, visibleFieldIds, type FormValues } from '@/ui/request-form/model'
import { ChooseType, matchesType } from '@/ui/request-form/new-request-dialog'
import { toFormFailure } from '@/ui/request-form/outcome'
import type { CatalogEntry, FormDefinition, RequestFormData } from '@/ui/request-form/types'
import th from '../../messages/th.json'

// FR-INT-011 AC2 AC3 and FR-INT-010 AC2 AC3 (§9.10 "ฟอร์มทีละขั้น", "dialog เริ่มคำขอใหม่"): the steps come from the form
// version's own steps, or are grouped by the table of §9.10 — and every form seeded for the demo works unchanged — a step
// with nothing to show is skipped, "ถัดไป" checks only what its step asks, and each point of "ตรวจก่อนส่ง" or refusal of the
// server leads to the step that fixes it. The dialog: its search over more than six types and the drafts link. The
// screens in a browser: tests/e2e/request-wizard.spec.ts.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }))

const SEED = loadSeedForms()
const LINE = { id: '00000000-0000-4000-8000-000000000001', code: 'CON-OPEX-2569', name: 'ค่าใช้จ่ายดำเนินงาน', departmentId: 'd', departmentName: 'ฝ่ายก่อสร้าง', costCenterCode: 'CC', costCenterName: 'ศูนย์ต้นทุน', granted: false }

function dataOf(code: string, documentType: RequestFormData['type']['documentType'] = code === 'NEW_SUPPLIER' ? 'SUPPLIER_REQUEST' : 'PURCHASE_REQUEST', form?: FormDefinition): RequestFormData {
  return {
    type: { code, name: code, description: null, documentType },
    form: form ?? formDefinition(SEED.get(code)),
    requesterDepartmentName: 'ฝ่ายก่อสร้าง',
    budgetLines: documentType === 'PURCHASE_REQUEST' ? [LINE] : [],
    defaultBudgetLineId: documentType === 'PURCHASE_REQUEST' ? LINE.id : null,
    vatRateBp: 700,
    attachmentKinds: documentType === 'PURCHASE_REQUEST' ? ['QUOTATION', 'DPA', 'OTHER'] : ['REGISTRY_PROOF', 'OTHER'],
    draft: null,
  }
}

/** The plan of a form with these answers and one line of `unitPrice` baht before VAT */
function planOf(data: RequestFormData, fields: Record<string, unknown> = {}, unitPrice = '5000.00') {
  const purchase = data.type.documentType === 'PURCHASE_REQUEST'
  const values: FormValues = {
    ...initialValues(data),
    title: 'คำขอ',
    fields,
    lines: purchase ? [{ key: 'l0', id: null, reserved: null, description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPrice, vatable: true, serviceEndDate: '2026-12-31' }] : [],
  }
  const totals = purchase ? totalsOf(values, data.vatRateBp) : null
  const input = formInput(values, [], totals, data.type.code)
  const visible = visibleFieldIds(data.form, input)
  const rules = applicableRules(data.form, input)
  const plan = planSteps({ form: data.form, purchase, visible, filesAllowed: data.attachmentKinds.length > 0, applicableRules: rules.map((r) => r.id) })
  return { plan, values, input, visible }
}
const keys = (plan: readonly PlannedStep[]) => plan.map((s) => s.key)
const stepWith = (plan: readonly PlannedStep[], field: string) => plan.find((s) => s.fields.includes(field))?.key

describe('[FR-INT-011/AC2] the steps of every form seeded for the demo, without changing the forms', () => {
  it.each<[string, Record<string, unknown>, string[]]>([
    ['BUY_GOODS', {}, ['details', 'items', 'supplier', 'documents', 'review']],
    ['HIRE_SERVICE', {}, ['details', 'items', 'supplier', 'questions', 'documents', 'review']],
    ['CONTRACT_WORK', {}, ['details', 'items', 'supplier', 'documents', 'review']],
    ['IT_PURCHASE', { category: 'HARDWARE' }, ['details', 'items', 'supplier', 'questions', 'documents', 'review']],
    ['NEW_SUPPLIER', {}, ['details', 'documents', 'review']],
  ])('%s with %j: %j', (code, answers, expected) => {
    expect(keys(planOf(dataOf(code), answers).plan)).toEqual(expected)
  })

  it('every type seeded has a form, and every field shown is asked on exactly one step, never on the check step', () => {
    expect([...SEED.keys()].sort()).toEqual(['BUY_GOODS', 'CONTRACT_WORK', 'HIRE_SERVICE', 'IT_PURCHASE', 'NEW_SUPPLIER'])
    for (const code of SEED.keys()) {
      for (const amount of ['5000.00', '150000.00']) {
        const { plan, visible } = planOf(dataOf(code), { category: 'HARDWARE' }, amount)
        const placed = plan.flatMap((s) => s.fields)
        expect(new Set(placed).size, code).toBe(placed.length)
        expect(new Set(placed), code).toEqual(visible)
        expect(plan.at(-1)?.key).toBe('review')
        expect(plan.at(-1)?.fields).toEqual([])
      }
    }
  })

  it('groups by the table of §9.10: details, items, supplier, screening and conditional questions, documents', () => {
    const it = planOf(dataOf('IT_PURCHASE'), { category: 'HARDWARE' }, '150000.00').plan
    expect(stepWith(it, 'category')).toBe('details')
    // Shown under a condition on an earlier answer, and the screening questions of BR-FORM-05
    expect(stepWith(it, 'assetTag')).toBe('questions')
    for (const id of SCREENING_FIELDS) expect(stepWith(it, id)).toBe('questions')
    // The single-source reason ATT-QUOTES asks for stays beside that rule (./document-fields.ts), above 100,000.00 with VAT
    expect(stepWith(it, 'singleSourceJustification')).toBe('documents')
    const parts = Object.fromEntries(it.map((s) => [s.key, s.sections]))
    expect(parts).toEqual({ details: ['title', 'deliverySite'], items: ['budgetLine', 'lines'], supplier: ['supplier', 'quotations'], questions: [], documents: ['rules', 'files'], review: [] })
    // HIRE_SERVICE asks its scope and period with the details
    const hire = planOf(dataOf('HIRE_SERVICE')).plan
    expect(hire.find((s) => s.key === 'details')?.fields).toEqual(['scopeOfWork', 'servicePeriod'])
  })

  it('a step with nothing to show is skipped, and comes back when an answer shows its question', () => {
    const fields: FieldDef[] = [
      { id: 'kind', type: 'select', required: true, options: ['A', 'B'] },
      { id: 'detailB', type: 'text', required: true },
    ]
    const form: FormDefinition = { fields, visibility: [{ field: 'detailB', when: { field: 'kind', op: 'eq', value: 'B' } }], rules: [], lines: {} }
    const data = dataOf('X', 'PURCHASE_REQUEST', form)
    expect(keys(planOf(data, { kind: 'A' }).plan)).not.toContain('questions')
    expect(stepWith(planOf(data, { kind: 'B' }).plan, 'detailB')).toBe('questions')
  })

  it('a new-supplier request keeps the documents step for its files although no rule asks for one, marked optional', () => {
    const docs = planOf(dataOf('NEW_SUPPLIER')).plan.find((s) => s.key === 'documents')
    expect(docs).toMatchObject({ sections: ['files'], optional: true })
    // With nothing to attach and no rule, there is no documents step
    const none = planSteps({ form: dataOf('NEW_SUPPLIER').form, purchase: false, visible: new Set(), filesAllowed: false, applicableRules: [] })
    expect(keys(none)).toEqual(['details', 'review'])
    // A rule that applies makes it a step to fill in
    const buy = planOf(dataOf('BUY_GOODS'), {}, '150000.00').plan.find((s) => s.key === 'documents')
    expect(buy?.optional).toBe(false)
  })

  it('the form’s own steps: their fields there in the form’s order, every other field on the details step, the parts around them', () => {
    const base = SEED.get('HIRE_SERVICE')!
    const own = { ...base, steps: [{ key: 'scope', titleTh: 'ขอบเขตงาน', titleEn: 'Scope', fields: ['servicePeriod', 'scopeOfWork'], optional: false }, { key: 'empty', titleTh: 'ว่าง', titleEn: 'Empty', fields: [], optional: true }, { key: 'risk', titleTh: 'ความเสี่ยง', titleEn: 'Risk', fields: ['accessesSystems'], optional: true }] }
    const form = formDefinition(FormSchemaJson.parse(own))
    const { plan } = planOf(dataOf('HIRE_SERVICE', 'PURCHASE_REQUEST', form))
    expect(keys(plan)).toEqual(['details', 'scope', 'risk', 'items', 'supplier', 'documents', 'review'])
    expect(plan.find((s) => s.key === 'scope')).toMatchObject({ title: { th: 'ขอบเขตงาน', en: 'Scope' }, fields: ['scopeOfWork', 'servicePeriod'], optional: false })
    expect(plan.find((s) => s.key === 'risk')?.optional).toBe(true)
    // Not in a step of its own: on the details step
    expect(plan.find((s) => s.key === 'details')?.fields).toEqual(expect.arrayContaining(['processesPersonalData', 'accessesPremises']))
  })
})

describe('[FR-INT-011/AC2] the stored steps: optional in FormVersion.schema, checked on import (FR-ADM-005)', () => {
  const form = { fields: [{ id: 'a', type: 'text' }, { id: 'b', type: 'text' }], visibility: [], rules: [] }
  it('a form without steps reads as before; with them, each step keeps its key, titles, fields and optional flag', () => {
    expect(formDefinition(form).steps).toBeUndefined()
    const read = formDefinition({ ...form, steps: [{ key: 's1', titleTh: 'หนึ่ง', titleEn: 'One', fields: ['a'] }] })
    expect(read.steps).toEqual([{ key: 's1', titleTh: 'หนึ่ง', titleEn: 'One', fields: ['a'], optional: false }])
  })

  it('an import is refused for a step key used twice, a field the form has not, and a field in two steps', () => {
    const steps = [
      { key: 's1', titleTh: 'หนึ่ง', titleEn: 'One', fields: ['a', 'zz'] },
      { key: 's1', titleTh: 'สอง', titleEn: 'Two', fields: ['a'] },
    ]
    expect(parseFormJson(JSON.stringify({ ...form, steps }))).toEqual({
      ok: false,
      problems: [
        { reason: 'UNKNOWN_FIELD', field: 'zz', path: 'steps[0].fields[1]' },
        { reason: 'DUPLICATE_STEP', step: 's1', path: 'steps[1].key' },
        { reason: 'FIELD_IN_TWO_STEPS', field: 'a', path: 'steps[1].fields[0]' },
      ],
    })
    expect(parseFormJson(JSON.stringify({ ...form, steps: [{ key: 's1', titleTh: 'หนึ่ง', titleEn: 'One', fields: ['b'], optional: true }] }))).toMatchObject({ ok: true })
  })
})

describe('[FR-INT-011/AC3] "ถัดไป" checks only its step; each point leads to the step that fixes it', () => {
  it('the problems of a blank BUY_GOODS form fall on the steps that ask them', () => {
    const data = dataOf('BUY_GOODS')
    const values: FormValues = { ...initialValues(data), title: '', budgetLineId: '', quotations: [{ key: 'q', supplierName: 'ร้าน', amount: '', includesVat: false, fileId: null, fileName: null, selected: false, saved: false }] }
    const input = formInput(values, [], totalsOf(values, 700), 'BUY_GOODS')
    const { plan } = planOf(data)
    const problems = problemsOf(data, values, input, [])
    const where = problems.map((p) => [p.kind, stepOfTarget(plan, targetOfProblem(p)).key])
    expect(where).toEqual(
      expect.arrayContaining([
        ['TITLE', 'details'],
        ['BUDGET_LINE', 'items'],
        ['NO_LINES', 'items'],
        ['QUOTATION_INCOMPLETE', 'supplier'],
      ]),
    )
  })

  it('a quotation’s file and the attachment rules wait for the documents and the check; no budget line to choose stops nothing', () => {
    expect(stopsNext({ kind: 'QUOTATION_FILE', quotationNo: 1 }, true)).toBe(false)
    expect(stopsNext({ kind: 'ATTACHMENTS', ruleId: 'ATT-QUOTES' }, true)).toBe(false)
    expect(stopsNext({ kind: 'BUDGET_LINE' }, false)).toBe(false)
    expect(stopsNext({ kind: 'BUDGET_LINE' }, true)).toBe(true)
    for (const kind of ['TITLE', 'NO_LINES', 'QUOTATION_CHOOSE', 'QUOTATION_REASON'] as const) expect(stopsNext({ kind }, true)).toBe(true)
    expect(stopsNext({ kind: 'FIELD_REQUIRED', fieldId: 'x' }, true)).toBe(true)
  })

  it('a refusal of the server leads to its step: a field to its step, the budget line, the lines, the quotations, the rules', () => {
    const { plan } = planOf(dataOf('HIRE_SERVICE'))
    const at = (error: { code: string; details?: Record<string, unknown> }) => {
      const target = targetOfFailure(toFormFailure(error))
      return target ? stepOfTarget(plan, target).key : null
    }
    expect(at({ code: 'VALIDATION_FAILED', details: { field: 'formData.processesPersonalData', reason: 'FORM' } })).toBe('questions')
    expect(at({ code: 'VALIDATION_FAILED', details: { field: 'formData.scopeOfWork', reason: 'FORM' } })).toBe('details')
    expect(at({ code: 'VALIDATION_FAILED', details: { reason: 'BUDGET_LINE' } })).toBe('items')
    expect(at({ code: 'BUDGET_INSUFFICIENT', details: { available: '1.00', shortfall: '2.00' } })).toBe('items')
    expect(at({ code: 'VALIDATION_FAILED', details: { rule: 'QUOTE-LOWEST' } })).toBe('supplier')
    expect(at({ code: 'ATTACHMENT_RULE_FAILED', details: { rule: 'ATT-DPA' } })).toBe('documents')
    expect(at({ code: 'VALIDATION_FAILED', details: { field: 'deliverySiteId' } })).toBe('details')
    expect(at({ code: 'DOA_NOT_CONFIGURED' })).toBeNull()
  })
})

const intl = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="th" messages={th} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )
const TYPES: CatalogEntry[] = ['ซื้อของ', 'จ้างบริการ', 'จ้างเหมา', 'ซื้อไอที', 'ผู้ขายใหม่', 'เช่าอุปกรณ์', 'งานซ่อม'].map((name, i) => ({ code: `T${i}`, name, description: `ใช้เมื่อ${name}`, documentType: 'PURCHASE_REQUEST' }))

describe('[FR-INT-010/AC1] [FR-INT-010/AC2] [FR-INT-010/AC3] the dialog that starts a new request', () => {
  it('lists each type as one choice with when to use it, and the full-width "ดำเนินการต่อ" at its foot', () => {
    const html = intl(<ChooseType types={TYPES.slice(0, 5)} drafts={null} onDone={() => undefined} />)
    expect(html.match(/role="radio"/g)).toHaveLength(5)
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('ใช้เมื่อ: ใช้เมื่อซื้อของ')
    expect(html).toMatch(/<button[^>]*class="[^"]*w-full[^"]*"[^>]*>ดำเนินการต่อ<\/button>/)
  })

  it('says how many drafts the requester has, with the link to them; none says nothing', () => {
    expect(intl(<ChooseType types={TYPES.slice(0, 5)} drafts={2} onDone={() => undefined} />)).toMatch(/คุณมีร่างคำขอ 2 ใบ[\s\S]*href="\/requests\/new#drafts"[^>]*>ดูร่าง</)
    expect(intl(<ChooseType types={TYPES.slice(0, 5)} drafts={0} onDone={() => undefined} />)).not.toContain('ดูร่าง')
  })

  it('more than six types get a keyword search; six or fewer do not', () => {
    expect(intl(<ChooseType types={TYPES} drafts={null} onDone={() => undefined} />)).toContain('type="search"')
    expect(intl(<ChooseType types={TYPES.slice(0, 6)} drafts={null} onDone={() => undefined} />)).not.toContain('type="search"')
    // The catalogue's matching: every word in the name, the description or the code
    expect(TYPES.filter((t) => matchesType(t, 'เช่า')).map((t) => t.code)).toEqual(['T5'])
    expect(TYPES.filter((t) => matchesType(t, 'ใช้เมื่อ จ้าง')).map((t) => t.code)).toEqual(['T1', 'T2'])
  })
})
