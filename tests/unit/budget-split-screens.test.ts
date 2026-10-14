import { describe, expect, it } from 'vitest'
import { requestBudgetState } from '@/app/(workspace)/_tracking/budget-state'
import { splitLine } from '@/core/budget'
import { targetOfFailure } from '@/ui/request-form/form-steps'
import { draftPayload, emptyLine, formReducer, initialValues, ownBudgetLine, requestLineNeed, type FormLine, type FormValues } from '@/ui/request-form/model'
import { failureKey, failureStep, failureTarget, toFormFailure } from '@/ui/request-form/outcome'
import { halves, quantityText, splitFormLine, splitPreview } from '@/ui/request-form/split-lines'
import type { RequestFormData } from '@/ui/request-form/types'

// S6-17 on screen (FR-BUD-102 · BR-BUD-16 · OQ-106): a line of the request form on a budget line of its own, the split of
// a line by quantity with the rounding difference shown before saving (GC-BUD-25 GC-BUD-26 through core/budget
// splitLine), what the request's own budget line must hold, a refusal of a line's budget line said of that line, and the
// request page's budget state over every budget line. Pure; the server checks again (tests/integration/budget-split.test.ts).

const OWN = '00000000-0000-4000-8000-0000000000b1'
const OTHER = '00000000-0000-4000-8000-0000000000b2'
const SAVED = '00000000-0000-4000-8000-0000000000c1'

function formData(more: Partial<RequestFormData> = {}): RequestFormData {
  return {
    type: { code: 'BUY_GOODS', name: 'ซื้อของ', description: null, documentType: 'PURCHASE_REQUEST' },
    form: { fields: [], visibility: [], rules: [], lines: {} },
    requesterDepartmentName: null,
    budgetLines: [],
    defaultBudgetLineId: OWN,
    vatRateBp: 700,
    attachmentKinds: [],
    draft: null,
    ...more,
  }
}

const line = (key: string, patch: Partial<FormLine> = {}): FormLine => ({ ...emptyLine(key), description: 'เครื่องพิมพ์', quantity: '1', uom: 'เครื่อง', unitPrice: '100000.01', ...patch })
const withLines = (lines: FormLine[]): FormValues => ({ ...initialValues(formData()), title: 'แบ่งงบ', lines })

describe('[FR-BUD-102/AC2] "แบ่งบรรทัด" splits a line by quantity and shows the rounding difference before saving', () => {
  it('starts with the quantity in halves, the first part taking the odd ten-thousandth', () => {
    expect(halves('1')).toEqual(['0.5', '0.5'])
    expect(halves('3')).toEqual(['1.5', '1.5'])
    expect(halves('0.0003')).toEqual(['0.0002', '0.0001'])
    expect(halves('1,000')).toEqual(['500', '500'])
    expect(halves('0.0001')).toBeNull()
    expect(halves('0')).toBeNull()
    expect(quantityText(25000n)).toBe('2.5')
    expect(quantityText(10000n)).toBe('1')
  })

  it('GC-BUD-26: halves of 100,000.01 are 50,000.01 each, a total 0.01 above the line, said before saving', () => {
    const p = splitPreview(line('a'), ['0.5', '0.5'])
    expect(p).toMatchObject({ nets: [5000001n, 5000001n], total: 10000002n, original: 10000001n, difference: 1n, ready: true, left: 0n, invalid: [] })
  })

  it('works out the parts as core/budget splitLine does (the golden cases and a few more)', () => {
    const cases: Array<[string, string, string[]]> = [
      ['100000.01', '1', ['0.5', '0.5']],
      ['300000.00', '1', ['0.6', '0.4']],
      ['10.01', '7.5', ['2.5', '2.5', '2.5']],
      ['0.03', '3', ['1', '1', '0.5', '0.5']],
    ]
    for (const [unitPrice, quantity, parts] of cases) {
      const ui = splitPreview({ unitPrice, quantity }, parts)
      const core = splitLine(BigInt(unitPrice.replace('.', '')), parts)
      expect([ui.nets, ui.total, ui.original]).toEqual([core.nets, core.total, core.original])
    }
  })

  it('GC-BUD-25: a split without remainders keeps the amount', () => {
    const p = splitPreview(line('a', { unitPrice: '300000.00' }), ['0.6', '0.4'])
    expect(p).toMatchObject({ nets: [18000000n, 12000000n], total: 30000000n, original: 30000000n, difference: 0n, ready: true })
  })

  it('refuses a part of zero or less, a part that is no number, one part alone, and parts that do not add up', () => {
    expect(splitPreview(line('a'), ['1', '0'])).toMatchObject({ invalid: [1], ready: false, total: null, nets: [10000001n, null] })
    expect(splitPreview(line('a'), ['-1', '2'])).toMatchObject({ invalid: [0], ready: false })
    expect(splitPreview(line('a'), ['', '1'])).toMatchObject({ invalid: [0], ready: false })
    expect(splitPreview(line('a'), ['1'])).toMatchObject({ ready: false, left: 0n })
    // Short of the line's quantity, or over it: the left quantity says which
    expect(splitPreview(line('a', { quantity: '10' }), ['4', '5'])).toMatchObject({ ready: false, left: 10000n, total: null })
    expect(splitPreview(line('a', { quantity: '10' }), ['4', '7'])).toMatchObject({ ready: false, left: -10000n })
    // A line without its numbers cannot be split
    expect(splitPreview(line('a', { unitPrice: '' }), ['0.5', '0.5']).ready).toBe(false)
  })

  it('replaces the line by its parts: the first keeps the saved line, the others are new; each with its quantity and budget line', () => {
    const v = withLines([line('a', { id: SAVED, reserved: '100000.01', catalogItemId: null, vatable: false }), line('b', { description: 'หมึก' })])
    const split = formReducer(v, { type: 'splitLine', key: 'a', parts: [{ key: 'p1', quantity: '0.5', budgetLineId: null }, { key: 'p2', quantity: '0.5', budgetLineId: OTHER }] })
    expect(split.lines.map((l) => [l.key, l.id, l.reserved, l.quantity, l.budgetLineId ?? null, l.description, l.vatable, l.unitPrice])).toEqual([
      ['a', SAVED, '100000.01', '0.5', null, 'เครื่องพิมพ์', false, '100000.01'],
      ['p2', null, null, '0.5', OTHER, 'เครื่องพิมพ์', false, '100000.01'],
      ['b', null, null, '1', null, 'หมึก', true, '100000.01'],
    ])
    expect(splitFormLine(v, 'missing', [])).toEqual(v)
  })
})

describe('[FR-BUD-102/AC1] each line may use a budget line of its own', () => {
  it('sends a line\'s budget line once the form knows it (null: the request\'s), and leaves it out of a line that never had the choice', () => {
    const v = withLines([line('a', { budgetLineId: OTHER }), line('b', { budgetLineId: null }), line('c')])
    const sent = draftPayload(v, 'ซื้อของ', true).draft.lines!
    expect(sent.map((l) => ('budgetLineId' in l ? l.budgetLineId : 'absent'))).toEqual([OTHER, null, 'absent'])
  })

  it('keeps the budget line a saved draft gave each line', () => {
    const data = formData({
      draft: {
        requestId: SAVED,
        version: 1,
        status: 'DRAFT',
        title: 'แบ่งงบ',
        budgetLineId: OWN,
        priceIncludesVat: false,
        formData: {},
        lines: [{ id: SAVED, reserved: null, description: 'เครื่องพิมพ์', quantity: '1', uom: 'เครื่อง', unitPrice: '10.00', vatable: true, serviceEndDate: null, budgetLineId: OTHER }],
        quotations: [],
        nonLowestQuoteReason: '',
        attachments: [],
        returnReason: null,
      },
    })
    const v = initialValues(data)
    expect(v.lines[0]!.budgetLineId).toBe(OTHER)
    expect(draftPayload(v, 'ซื้อของ', false).draft.lines![0]!.budgetLineId).toBe(OTHER)
  })

  it('the request\'s budget line must hold only the lines without one of their own; a line naming the request\'s own is the request\'s', () => {
    const v = withLines([line('a', { unitPrice: '1000.00' }), line('b', { unitPrice: '2000.00', budgetLineId: OTHER }), line('c', { unitPrice: '300.00', budgetLineId: OWN })])
    expect(ownBudgetLine(v.lines[1]!, v)).toBe(OTHER)
    expect(ownBudgetLine(v.lines[2]!, v)).toBeNull()
    expect(requestLineNeed(v, 700)).toEqual({ net: 130000n, others: 1 })
    // Prices with VAT: each line before VAT as the submit reserves it (lineNetsBeforeVat)
    expect(requestLineNeed({ ...v, priceIncludesVat: true, lines: [line('a', { unitPrice: '107.00' }), line('b', { unitPrice: '107.00', budgetLineId: OTHER })] }, 700)).toEqual({ net: 10000n, others: 1 })
    expect(requestLineNeed(v, null)).toBeNull()
    expect(requestLineNeed(withLines([]), 700)).toEqual({ net: 0n, others: 0 })
  })

  it('a refusal of a line\'s budget line at submit is said of that line, on the items step', () => {
    const forbidden = toFormFailure({ code: 'FORBIDDEN', details: { field: 'lines.1.budgetLineId', reason: 'BUDGET_LINE_NOT_ALLOWED' } })
    expect([failureKey(forbidden), failureStep(forbidden), failureTarget(forbidden).lineNo, targetOfFailure(forbidden)]).toEqual(['LINE_BUDGET_LINE_NOT_ALLOWED', 'items', 2, { section: 'lines' }])
    const year = toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'lines.0.budgetLineId', reason: 'BUDGET_LINE_YEAR' } })
    expect([failureKey(year), failureStep(year), failureTarget(year).lineNo]).toEqual(['LINE_BUDGET_LINE_YEAR', 'items', 1])
    const unknown = toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'lines.2.budgetLineId', reason: 'BUDGET_LINE' } })
    expect(failureKey(unknown)).toBe('LINE_BUDGET_LINE')
    // The request's own budget line is still the request's
    const own = toFormFailure({ code: 'FORBIDDEN', details: { field: 'budgetLineId', reason: 'BUDGET_LINE_NOT_ALLOWED' } })
    expect([failureKey(own), failureStep(own), targetOfFailure(own)]).toEqual(['BUDGET_LINE_NOT_ALLOWED', 'details', { section: 'budgetLine' }])
  })

  it('the request page reads the budget as held while any of its budget lines holds', () => {
    const b = (reserved: bigint, committed = 0n) => ({ lineId: OWN, code: 'X', name: 'x', status: 'OPEN' as const, reservedSatang: reserved, committedSatang: committed, actualSatang: 0n })
    expect(requestBudgetState({ status: 'SUBMITTED', budget: b(0n), budgetLines: [b(0n), b(500n)] })).toEqual({ kind: 'held', key: 'stateReserved' })
    expect(requestBudgetState({ status: 'APPROVED', budget: b(0n), budgetLines: [b(0n), b(0n, 500n)] })).toEqual({ kind: 'held', key: 'stateCommitted' })
    expect(requestBudgetState({ status: 'CANCELLED', budget: b(0n), budgetLines: [b(0n), b(0n)] })).toEqual({ kind: 'closed', key: 'stateReleased' })
    expect(requestBudgetState({ status: 'SUBMITTED', budget: b(700n) })).toEqual({ kind: 'held', key: 'stateReserved' })
  })
})
