import { describe, expect, it } from 'vitest'
import en from '../../messages/en.json'
import th from '../../messages/th.json'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { documentTotals } from '@/core/money/math'
import type { AttachmentRule, VisibilityRule } from '@/core/forms'
import { loadSeedForms } from '@/server/seed/forms'
import {
  applicableRules,
  compareFormQuotations,
  draftPayload,
  emptyLine,
  emptyQuotation,
  formInput,
  formReducer,
  initialValues,
  lineAmount,
  needsServiceEndDate,
  problemsOf,
  totalsOf,
  visibleFieldIds,
  visibleInput,
  type FormLine,
  type FormQuotation,
  type FormValues,
} from '@/ui/request-form/model'
import { adminsWereTold, FAILURE_KEYS, failureKey, failureStep, failureTarget, toFormFailure } from '@/ui/request-form/outcome'
import type { RequestFormData } from '@/ui/request-form/types'
import { loadYaml } from '../golden/doa-fixtures'

// The rules the request form runs as the requester types (S2-11): the same core/forms and core/money as the server, so
// the screen says what the server will say. The golden cases of §7.9 run through the screen's own helpers here.

const forms = loadSeedForms()
const formOf = (code: string) => {
  const f = forms.get(code)!
  return { fields: f.fields, visibility: f.visibility, rules: f.rules, lines: f.lines }
}

function dataOf(code: string, overrides: Partial<RequestFormData> = {}): RequestFormData {
  return {
    type: { code, name: 'ซื้อของ', description: null, documentType: code === 'NEW_SUPPLIER' ? 'SUPPLIER_REQUEST' : 'PURCHASE_REQUEST' },
    form: formOf(code),
    requesterDepartmentName: 'ฝ่ายก่อสร้าง',
    budgetLines: [{ id: 'line-1', code: 'CON-OPEX-2569', name: 'ค่าใช้จ่าย', departmentId: 'd', departmentName: 'ฝ่ายก่อสร้าง', costCenterCode: 'CC', costCenterName: 'ศูนย์', granted: false }],
    defaultBudgetLineId: 'line-1',
    vatRateBp: 700,
    attachmentKinds: ['DPA', 'JUSTIFICATION', 'PHOTO', 'OTHER'],
    draft: null,
    ...overrides,
  }
}

/** A line on the screen; `id` set: a line saved before */
const line = (description: string, quantity: string, uom: string, unitPrice: string, vatable = true, id: string | null = null): FormLine => ({
  ...emptyLine(id ?? (description || 'k')),
  id,
  description,
  quantity,
  uom,
  unitPrice,
  vatable,
})
const quote = (key: string, supplierName: string, amount: string, includesVat: boolean, extra: Partial<FormQuotation> = {}): FormQuotation => ({
  ...emptyQuotation(key),
  supplierName,
  amount,
  includesVat,
  fileId: `f-${key}`,
  fileName: 'q.pdf',
  ...extra,
})

interface FormsSuite {
  rules: AttachmentRule[]
  visibility: VisibilityRule[]
  cases: Array<{ id: string; input: { amountGross: string; attachments: Record<string, number>; fields?: Record<string, unknown> }; expect: { ok?: boolean; error?: string; rule?: string; droppedFields?: string[] } }>
}

describe('[FR-INT-002/AC2] the screen’s rule helpers give the golden results GC-FORM-01 to GC-FORM-08', () => {
  const suite = loadYaml<FormsSuite>('forms.yaml')
  const form = { fields: [], visibility: suite.visibility, rules: suite.rules, lines: {} }
  for (const c of suite.cases) {
    it(`${c.id}: what the form lists before sending matches the engine`, () => {
      const gross = amountToSatang(c.input.amountGross)
      const input = { fields: c.input.fields ?? {}, attachments: c.input.attachments, variables: { $amountGross: gross, $amountNet: gross, $requestType: 'BUY_GOODS' } }
      const unmet = applicableRules(form, input).filter((r) => !r.met)
      if (c.expect.ok) expect(unmet).toEqual([])
      else expect(unmet.map((r) => r.id)).toContain(c.expect.rule)
      for (const dropped of c.expect.droppedFields ?? []) expect(visibleInput(form, input).fields).not.toHaveProperty(dropped)
    })
  }
})

describe('[FR-INT-002/AC1] fields show and hide as the requester answers', () => {
  it('IT: the asset tag only for hardware; lines need the service end date only for software (BR-FORM-05)', () => {
    const form = formOf('IT_PURCHASE')
    const input = (category: string) => ({ fields: { category }, attachments: {}, variables: { $amountGross: 0n, $amountNet: 0n, $requestType: 'IT_PURCHASE' } })
    expect(visibleFieldIds(form, input('HARDWARE')).has('assetTag')).toBe(true)
    expect(visibleFieldIds(form, input('SOFTWARE')).has('assetTag')).toBe(false)
    expect(needsServiceEndDate(form, input('SOFTWARE'))).toBe(true)
    expect(needsServiceEndDate(form, input('HARDWARE'))).toBe(false)
    // Every service line carries its end date
    expect(needsServiceEndDate(formOf('HIRE_SERVICE'), input(''))).toBe(true)
  })

  it('before sending, the screen lists an unfinished line, a missing title and a required answer that is shown, each with its step', () => {
    const data = dataOf('HIRE_SERVICE')
    const v: FormValues = { ...initialValues(data), lines: [line('ดูแลระบบ', '', 'เดือน', '3000.00')] }
    const kinds = problemsOf(data, v, formInput(v, [], totalsOf(v, 700), 'HIRE_SERVICE'), []).map((p) => p.kind)
    expect(kinds).toEqual(expect.arrayContaining(['TITLE', 'FIELD_REQUIRED', 'NO_LINES', 'LINE_INCOMPLETE']))
  })
})

describe('[FR-INT-005/AC1] the attachments the rules ask for at the current amount', () => {
  const data = dataOf('BUY_GOODS')
  const values = (price: string, extra: Partial<FormValues> = {}): FormValues => ({ ...initialValues(data), lines: [line('เครื่องผสมปูน', '1', 'เครื่อง', price)], priceIncludesVat: true, ...extra })
  const rulesAt = (v: FormValues, attachments: Array<{ kind: string }> = []) => applicableRules(data.form, formInput(v, attachments, totalsOf(v, 700), 'BUY_GOODS'))

  it('ATT-QUOTES applies above 100,000.00 baht including VAT and is met by three quotations with their files', () => {
    expect(rulesAt(values('100000.00'))).toEqual([])
    expect(rulesAt(values('100000.01')).map((r) => [r.id, r.met])).toEqual([['ATT-QUOTES', false]])
    const quotes = ['A', 'B', 'C'].map((ref, i) => quote(ref, `ผู้ขาย ${ref}`, '100000.00', true, { selected: i === 0 }))
    expect(rulesAt(values('100000.01', { quotations: quotes })).map((r) => [r.id, r.met])).toEqual([['ATT-QUOTES', true]])
    // A quotation without its file does not count
    expect(rulesAt(values('100000.01', { quotations: quotes.map((q, i) => (i === 2 ? { ...q, fileId: null } : q)) })).map((r) => r.met)).toEqual([false])
  })
})

describe('[FR-INT-005/AC5] IT and services ask the three screening questions; a supplier that processes personal data needs a DPA', () => {
  it('answering yes asks for a DPA, and attaching one meets ATT-DPA (BR-FORM-05)', () => {
    const service = dataOf('HIRE_SERVICE')
    const v = { ...initialValues(service), fields: { processesPersonalData: 'Y' }, lines: [line('ดูแลระบบ', '12', 'เดือน', '3000.00')] }
    const input = (attachments: Array<{ kind: string }>) => formInput(v, attachments, totalsOf(v, 700), 'HIRE_SERVICE')
    expect(applicableRules(service.form, input([])).map((r) => [r.id, r.met])).toEqual([['ATT-DPA', false]])
    expect(applicableRules(service.form, input([{ kind: 'DPA' }])).map((r) => [r.id, r.met])).toEqual([['ATT-DPA', true]])
    for (const code of ['HIRE_SERVICE', 'IT_PURCHASE']) {
      expect(formOf(code).fields.filter((f) => ['processesPersonalData', 'accessesSystems', 'accessesPremises'].includes(f.id))).toHaveLength(3)
    }
  })
})

interface QuotationsSuite {
  vatRateBp: number
  cases: Array<{
    id: string
    input: { quotes: Array<{ ref: string; amount: string; includesVat: boolean }>; selected: string; nonLowestQuoteReason?: string }
    expect: { ok?: boolean; error?: string; rule?: string; nets?: Record<string, string>; lowest: string[] }
  }>
}

describe('[FR-INT-005/AC4] quotations compared on screen as they are typed give the golden results GC-FORM-09 to GC-FORM-11', () => {
  const suite = loadYaml<QuotationsSuite>('quotations.yaml')
  const data = dataOf('BUY_GOODS')
  for (const c of suite.cases) {
    it(`${c.id}: prices before VAT, the lowest, and whether a reason is asked for`, () => {
      const v: FormValues = {
        ...initialValues(data),
        title: 'เครื่องผสมปูน',
        lines: [line('เครื่อง', '1', 'เครื่อง', '107000.00')],
        priceIncludesVat: true,
        quotations: c.input.quotes.map((q) => quote(q.ref, `ผู้ขาย ${q.ref}`, q.amount, q.includesVat, { selected: q.ref === c.input.selected })),
        nonLowestQuoteReason: c.input.nonLowestQuoteReason ?? '',
      }
      // The screen computes the lowest with core/forms itself (nothing is given to it)
      const compared = compareFormQuotations(v, suite.vatRateBp)
      expect(compared.lowest).toEqual(c.expect.lowest)
      if (c.expect.nets) expect(Object.fromEntries(Object.entries(compared.nets).map(([k, s]) => [k, satangToAmount(s)]))).toEqual(c.expect.nets)
      const kinds = problemsOf(data, v, formInput(v, [], totalsOf(v, suite.vatRateBp), 'BUY_GOODS'), compared.lowest).map((p) => p.kind)
      if (c.expect.rule === 'QUOTE-LOWEST') expect(kinds).toContain('QUOTATION_REASON')
      else expect(kinds).not.toContain('QUOTATION_REASON')
    })
  }

  it('no quotation chosen is listed before sending', () => {
    const v: FormValues = { ...initialValues(data), quotations: [quote('A', 'ก', '100.00', false), quote('B', 'ข', '90.00', false)] }
    const compared = compareFormQuotations(v, 700)
    expect(problemsOf(data, v, formInput(v, [], totalsOf(v, 700), 'BUY_GOODS'), compared.lowest).map((p) => p.kind)).toContain('QUOTATION_CHOOSE')
  })
})

describe('[FR-INT-006/AC1] what an autosave sends, so it never takes away what the requester did not take away', () => {
  const data = dataOf('BUY_GOODS')
  const SAVED_1 = '0192f3b0-0000-7000-8000-000000000001'
  const SAVED_2 = '0192f3b0-0000-7000-8000-000000000002'

  it('typed numbers are saved plain; a new draft without a title is saved under the type’s name', () => {
    const v: FormValues = {
      ...initialValues(data),
      lines: [line('ปูน', '1,000', 'ถุง', '1,234.50'), line('ยังไม่ครบ', '', 'ถุง', '10.00'), line('ศูนย์', '0', 'ถุง', '10.00')],
      quotations: [quote('q1', 'ร้าน ก', '1,234.50', false, { selected: true }), { ...emptyQuotation('q2'), amount: '99.00' }],
      fields: { singleSourceJustification: 'มีรายเดียว' },
    }
    const save = draftPayload(v, 'ซื้อของ', true)
    // New lines and quotations go once complete; the unfinished ones stay on screen
    expect(save.draft).toEqual({
      title: 'ซื้อของ',
      budgetLineId: 'line-1',
      priceIncludesVat: false,
      formData: { singleSourceJustification: 'มีรายเดียว' },
      lines: [{ id: null, description: 'ปูน', quantity: '1000', uom: 'ถุง', unitPrice: '1234.50', vatable: true }],
      quotations: [{ supplierName: 'ร้าน ก', amount: '1234.50', includesVat: false, fileId: 'f-q1', selected: true }],
    })
    expect(save.lineKeys).toEqual(['ปูน'])
    expect(save.quotationKeys).toEqual(['q1'])
    expect(draftPayload({ ...v, title: '  ' + 'ก'.repeat(300) }, 'ซื้อของ', true).draft.title).toHaveLength(200)
  })

  it('a saved line being retyped holds every line back: the server keeps the saved ones as they were', () => {
    const v: FormValues = {
      ...initialValues(data),
      title: 'วัสดุก่อสร้าง',
      lines: [line('ปูน', '', 'ถุง', '300.00', true, SAVED_1), line('ทราย', '1', 'คิว', '5000.00', true, SAVED_2)],
    }
    const save = draftPayload(v, 'ซื้อของ', false)
    expect(save.draft).not.toHaveProperty('lines')
    expect(save.lineKeys).toBeNull()
    // Complete again: both go, each with its own id, in the order on screen
    const fixed = draftPayload({ ...v, lines: [line('ปูน', '100', 'ถุง', '300.00', true, SAVED_1), v.lines[1]!] }, 'ซื้อของ', false)
    expect(fixed.draft.lines?.map((l) => [l.id, l.description])).toEqual([
      [SAVED_1, 'ปูน'],
      [SAVED_2, 'ทราย'],
    ])
  })

  it('a line taken away is left out and the others keep their ids; a new line learns its id from the save', () => {
    const start: FormValues = { ...initialValues(data), lines: [line('ปูน', '100', 'ถุง', '300.00', true, SAVED_1), line('ทราย', '1', 'คิว', '5000.00', true, SAVED_2)] }
    const removed = formReducer(start, { type: 'removeLine', key: SAVED_1 })
    const added = formReducer(removed, { type: 'addLine', key: 'new-line' })
    const typed = formReducer(added, { type: 'line', key: 'new-line', patch: { description: 'หิน', quantity: '2', uom: 'คิว', unitPrice: '800' } })
    const save = draftPayload(typed, 'ซื้อของ', false)
    expect(save.draft.lines?.map((l) => [l.id, l.description])).toEqual([
      [SAVED_2, 'ทราย'],
      [null, 'หิน'],
    ])
    const saved = formReducer(typed, { type: 'saved', lines: [{ key: SAVED_2, id: SAVED_2 }, { key: 'new-line', id: 'id-of-new-line' }], quotations: [] })
    expect(saved.lines.map((l) => l.id)).toEqual([SAVED_2, 'id-of-new-line'])
  })

  it('a saved quotation being changed holds the quotations back; a blank title, budget line or reason on a saved draft', () => {
    const v: FormValues = {
      ...initialValues(data),
      title: '   ',
      budgetLineId: '',
      nonLowestQuoteReason: ' ',
      quotations: [quote('q1', '', '1000.00', false, { saved: true, selected: true }), quote('q2', 'ร้าน ข', '900.00', false)],
    }
    const save = draftPayload(v, 'ซื้อของ', false)
    expect(save.draft).not.toHaveProperty('quotations')
    expect(save.quotationKeys).toBeNull()
    // The stored title stays; the budget line and the reason the requester cleared are cleared
    expect(save.draft).not.toHaveProperty('title')
    expect(save.draft).toMatchObject({ budgetLineId: null, nonLowestQuoteReason: null })
    // A new quotation still being typed does not hold the saved ones back
    const typing = draftPayload({ ...v, quotations: [{ ...v.quotations[0]!, supplierName: 'ร้าน ก' }, { ...emptyQuotation('q3'), supplierName: 'ร้าน ค' }] }, 'ซื้อของ', false)
    expect(typing.quotationKeys).toEqual(['q1'])
  })

  it('a draft opens with what was saved, each line with its id and what it holds; a new form with one empty line and the prefilled budget line', () => {
    expect(initialValues(data)).toMatchObject({ title: '', budgetLineId: 'line-1', lines: [{ description: '', id: null }] })
    const saved = dataOf('BUY_GOODS', {
      draft: {
        requestId: 'r',
        version: 3,
        status: 'RETURNED',
        title: 'ร่าง',
        budgetLineId: null,
        priceIncludesVat: true,
        formData: { a: 1 },
        lines: [
          { id: SAVED_1, reserved: { amount: '18691.59', currency: 'THB' }, description: 'ปูน', quantity: '2', uom: 'ถุง', unitPrice: '10000.00', vatable: false, serviceEndDate: null },
          { id: SAVED_2, reserved: { amount: '0.00', currency: 'THB' }, description: 'ทราย', quantity: '1', uom: 'คิว', unitPrice: '10.00', vatable: true, serviceEndDate: '2027-10-31' },
        ],
        quotations: [{ supplierName: 'ร้าน', amount: '1.00', includesVat: false, fileId: null, fileName: null, selected: true }],
        nonLowestQuoteReason: '',
        attachments: [],
        returnReason: null,
      },
    })
    expect(initialValues(saved)).toMatchObject({
      title: 'ร่าง',
      budgetLineId: 'line-1',
      priceIncludesVat: true,
      lines: [
        { key: SAVED_1, id: SAVED_1, reserved: '18691.59', serviceEndDate: '' },
        { key: SAVED_2, id: SAVED_2, reserved: null, serviceEndDate: '2027-10-31' },
      ],
      quotations: [{ saved: true }],
    })
  })

  it('choosing a quotation leaves only that one chosen', () => {
    const v = formReducer({ ...initialValues(data), quotations: [quote('a', 'a', '1', false, { selected: true }), quote('b', 'b', '1', false)] }, { type: 'selectQuotation', key: 'b' })
    expect(v.quotations.map((q) => q.selected)).toEqual([false, true])
  })
})

describe('[FR-INT-004/AC1] the totals the form shows are core/money’s', () => {
  it('VAT once on the VAT-able lines, prices before or including VAT', () => {
    const data = dataOf('BUY_GOODS')
    const v = { ...initialValues(data), lines: [line('ก', '2.5', 'ชิ้น', '10.01'), line('ข', '1', 'ชิ้น', '100.00', false)] }
    expect(totalsOf(v, 700)).toEqual(documentTotals([{ quantity: '2.5', unitPriceSatang: 1001n }, { quantity: '1', unitPriceSatang: 10000n, vatable: false }], 700, false))
    expect(totalsOf({ ...v, priceIncludesVat: true }, 700)).toEqual(documentTotals([{ quantity: '2.5', unitPriceSatang: 1001n }, { quantity: '1', unitPriceSatang: 10000n, vatable: false }], 700, true))
    expect(lineAmount(line('ก', '2.5', 'ชิ้น', '10.01'))).toBe(2503n)
    expect(lineAmount(line('ก', '', 'ชิ้น', '10.01'))).toBeNull()
    expect(totalsOf(v, null)).toBeNull()
  })
})

describe('[FR-DOA-003/AC3] the form explains every refusal of the submit, and where to fix it', () => {
  it('reads the details the screen needs, never the raw message', () => {
    const budget = toFormFailure({ code: 'BUDGET_INSUFFICIENT', details: { available: '40000.00', shortfall: '20000.00' } })
    expect(budget).toEqual({ ok: false, code: 'BUDGET_INSUFFICIENT', available: '40000.00', shortfall: '20000.00' })
    expect([failureKey(budget), failureStep(budget)]).toEqual(['BUDGET_INSUFFICIENT', 'items'])
    const gap = toFormFailure({ code: 'APPROVER_NOT_FOUND', details: { ruleCode: 'PR-02', position: 'VP', departments: ['CON', 'OPS'], adminsNotified: 2 } })
    expect(gap).toEqual({ ok: false, code: 'APPROVER_NOT_FOUND', ruleCode: 'PR-02', position: 'VP', departments: ['CON', 'OPS'], adminsNotified: 2 })
    expect([failureKey(gap), failureStep(gap), adminsWereTold(gap)]).toEqual(['APPROVER_NOT_FOUND', null, true])
    // Nobody could be told (no active ORG_ADMIN, or the report failed): the screen never says they were
    expect(adminsWereTold(toFormFailure({ code: 'NO_HIGHER_AUTHORITY', details: { adminsNotified: 0 } }))).toBe(false)
    expect(adminsWereTold(toFormFailure({ code: 'DOA_NOT_CONFIGURED' }))).toBe(false)
    const attachments = toFormFailure({ code: 'ATTACHMENT_RULE_FAILED', details: { rule: 'ATT-QUOTES', failures: [{ rule: 'ATT-QUOTES', missing: [{ kind: 'ATTACHMENT', attachment: 'QUOTATION', need: 3, have: 1 }] }] } })
    expect(attachments.failures).toEqual([{ rule: 'ATT-QUOTES', missing: [{ kind: 'ATTACHMENT', attachment: 'QUOTATION', need: 3, have: 1 }] }])
    expect([failureKey(attachments), failureStep(attachments)]).toEqual(['ATTACHMENT_RULE_FAILED', 'documents'])
  })

  it('maps the service’s reasons to their own messages', () => {
    const k = (code: string, details: Record<string, unknown> = {}) => failureKey(toFormFailure({ code, details }))
    expect(k('VALIDATION_FAILED', { field: 'nonLowestQuoteReason', reason: 'QUOTE-LOWEST', rule: 'QUOTE-LOWEST' })).toBe('QUOTE_LOWEST')
    expect(k('VALIDATION_FAILED', { field: 'formData.category', reason: 'FORM' })).toBe('FORM_FIELD')
    expect(failureTarget(toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'formData.category', reason: 'FORM' } }))).toEqual({ fieldId: 'category' })
    expect(failureTarget(toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'lines.1.serviceEndDate', reason: 'SERVICE_END_DATE' } }))).toEqual({ lineNo: 2 })
    expect(k('FORBIDDEN', { reason: 'BUDGET_LINE_NOT_ALLOWED' })).toBe('BUDGET_LINE_NOT_ALLOWED')
    expect(k('VALIDATION_FAILED', { reason: 'CHOOSE_BUDGET_LINE' })).toBe('CHOOSE_BUDGET_LINE')
    expect(k('VALIDATION_FAILED', { field: 'chargedDepartmentId', reason: 'NO_DEPARTMENT' })).toBe('NO_DEPARTMENT')
    expect(k('VALIDATION_FAILED', { field: '(body)', reason: 'TOO_LARGE' })).toBe('TOO_LARGE')
    expect(k('VALIDATION_FAILED', { field: 'lines.0.id', reason: 'LINE_ID' })).toBe('LINE_ID')
    expect(k('INVALID_STATE_TRANSITION', { from: 'PENDING_APPROVAL' })).toBe('STATE')
    expect(k('RATE_LIMITED')).toBe('BUSY')
    expect(k('UNAUTHENTICATED')).toBe('UNAUTHENTICATED')
    expect(k('SOMETHING_NEW')).toBe('FAILED')
  })

  it('every message key exists in Thai and English; a DOA gap says to contact the administrators by their role, and whether they were told', () => {
    for (const key of FAILURE_KEYS) {
      expect(th.requestForm.errors[key], key).toBeTruthy()
      expect(en.requestForm.errors[key], key).toBeTruthy()
    }
    for (const key of ['APPROVER_NOT_FOUND', 'NO_HIGHER_AUTHORITY', 'DOA_NOT_CONFIGURED'] as const) {
      expect(th.requestForm.errors[key]).toContain('ติดต่อผู้ดูแลระบบขององค์กร')
      expect(en.requestForm.errors[key]).toContain('administrator')
    }
    expect(th.requestForm.errors.adminsTold).toContain('ระบบแจ้งผู้ดูแลระบบแล้ว')
    expect(th.requestForm.errors.adminsNotTold).toContain('แจ้งผู้ดูแลระบบด้วยตนเอง')
    // The confirmation repeats the button's words (§9.9 rule 7)
    expect(th.requestForm.sent.sendWaiting.startsWith(th.requestForm.submit.send)).toBe(true)
    expect(th.requestForm.sent.resubmitWaiting.startsWith(th.requestForm.submit.resubmit)).toBe(true)
    expect(th.requestForm.sent.procurement.startsWith(th.requestForm.submit.toProcurement)).toBe(true)
  })
})
