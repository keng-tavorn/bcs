import { describe, expect, it } from 'vitest'
import { approverView, lineViews, previewView } from '@/app/(workspace)/receiving/present'
import th from '../../messages/th.json'
import en from '../../messages/en.json'
import { RECEIVING_ERROR_KEYS, receivingErrorKey, receivingErrorValues, toReceivingFailure } from '@/ui/receiving/outcome'
import { cleanQuantity, compareQuantity, groupQuantity, isZeroQuantity } from '@/ui/receiving/quantity'

// S4-07 screens, the pure parts: every refusal of the receiving services has a message in Thai and in English that says
// what happened and how to fix it (§9.9 rule 7, FR-PLT-002 AC2); quantities stay decimal text (never a float) with
// thousands separators for reading; money reaches the screen with thousands separators and 2 decimals (FR-PLT-002 AC3),
// or not at all for those who may not see it. The receiving rules themselves are asserted in
// tests/integration/receiving-screens.test.ts against the real services.

describe('[FR-PLT-002/AC2] every refusal of the receiving screens has its own message in Thai and in English', () => {
  it('maps separation of duties by its rule, and every key exists in both languages', () => {
    expect(receivingErrorKey({ ok: false, code: 'SOD_VIOLATION', rule: 'BR-SOD-02' })).toBe('SOD_APPROVER')
    expect(receivingErrorKey({ ok: false, code: 'SOD_VIOLATION', rule: 'BR-SOD-07' })).toBe('SOD_REQUESTER')
    expect(receivingErrorKey({ ok: false, code: 'FORBIDDEN' })).toBe('FORBIDDEN')
    for (const k of RECEIVING_ERROR_KEYS) {
      expect(th.receiving.errors[k], `th ${k}`).toBeTruthy()
      expect(en.receiving.errors[k], `en ${k}`).toBeTruthy()
    }
    expect(th.receiving.errors.SOD_APPROVER).toContain('ผู้อนุมัติ')
  })

  it('names what to fix for the receipt itself', () => {
    const v = (reason: string, field?: string) => receivingErrorKey({ ok: false, code: 'VALIDATION_FAILED', reason, ...(field ? { field } : {}) })
    expect(v('EXCESS_DISPOSITION_REQUIRED')).toBe('EXCESS_CHOICE')
    expect(v('DAMAGED_DISPOSITION_REQUIRED')).toBe('DAMAGED_CHOICE')
    expect(v('DAMAGED_BEYOND_ORDER')).toBe('DAMAGED_BEYOND_ORDER')
    expect(v('PHOTO_REQUIRED')).toBe('PHOTO_REQUIRED')
    expect(v('FILE', 'photoFileIds')).toBe('PHOTO')
    expect(v('NOTHING_RECEIVED')).toBe('NOTHING_RECEIVED')
    expect(v('QUANTITY', 'lines.0.received')).toBe('QUANTITY')
    expect(receivingErrorKey({ ok: false, code: 'INVALID_STATE_TRANSITION', reason: 'CLOSE_SHORT_PENDING' })).toBe('CLOSE_SHORT_PENDING')
    expect(receivingErrorKey({ ok: false, code: 'INVALID_STATE_TRANSITION', reason: 'DAMAGED_PENDING' })).toBe('DAMAGED_PENDING')
    expect(receivingErrorKey({ ok: false, code: 'INVALID_STATE_TRANSITION' })).toBe('STATE')
    expect(receivingErrorKey({ ok: false, code: 'APPROVER_NOT_FOUND' })).toBe('NO_APPROVER')
    expect(receivingErrorKey({ ok: false, code: 'RATE_LIMITED' })).toBe('BUSY')
    expect(receivingErrorKey({ ok: false, code: 'SOMETHING_NEW' })).toBe('FAILED')
  })

  it('keeps only the screen-safe parts of a service error; a refusal for lack of budget without figures has a message without them', () => {
    expect(toReceivingFailure({ code: 'VALIDATION_FAILED', details: { reason: 'EXCESS_DISPOSITION_REQUIRED', excess: '1', field: 'lines.0.excessDisposition', secret: 'x' } })).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      reason: 'EXCESS_DISPOSITION_REQUIRED',
      excess: '1',
      field: 'lines.0.excessDisposition',
    })
    const plain = toReceivingFailure({ code: 'BUDGET_INSUFFICIENT' })
    expect(receivingErrorKey(plain)).toBe('BUDGET_INSUFFICIENT_PLAIN')
    expect(th.receiving.errors.BUDGET_INSUFFICIENT_PLAIN).not.toMatch(/\{(available|shortfall)\}/)
    expect(receivingErrorValues(plain)).toEqual({ excess: '-', keepable: '-', available: '-', shortfall: '-', requestId: '-' })
  })
})

describe('[FR-PLT-002/AC3] numbers on the receiving screens: money with thousands separators and 2 decimals, quantities exact', () => {
  it('formats the budget figures of a refusal (decimal text from the server) for reading', () => {
    expect(toReceivingFailure({ code: 'BUDGET_INSUFFICIENT', details: { available: '1234567.5', shortfall: '30.00' } })).toEqual({ ok: false, code: 'BUDGET_INSUFFICIENT', available: '1,234,567.50', shortfall: '30.00' })
    expect(toReceivingFailure({ code: 'BUDGET_INSUFFICIENT', details: { available: 'lots', shortfall: 12 } })).toEqual({ ok: false, code: 'BUDGET_INSUFFICIENT' })
  })

  it('cleans what was typed and refuses what is not a quantity of up to 4 decimals', () => {
    expect(cleanQuantity(' 1,000 ')).toBe('1000')
    expect(cleanQuantity('6.5')).toBe('6.5')
    expect(cleanQuantity('0.0001')).toBe('0.0001')
    expect(cleanQuantity('1.00001')).toBeNull()
    expect(cleanQuantity('-1')).toBeNull()
    expect(cleanQuantity('หก')).toBeNull()
    expect(cleanQuantity('')).toBeNull()
  })

  it('groups the whole part, compares exactly, and knows zero', () => {
    expect(groupQuantity('1234567.25')).toBe('1,234,567.25')
    expect(groupQuantity('100')).toBe('100')
    expect(compareQuantity('0.1', '0.10')).toBe(0)
    expect(compareQuantity('2', '10')).toBe(-1)
    expect(isZeroQuantity('0.0000')).toBe(true)
  })

  const approver = { kind: 'ROUTE' as const, ruleCode: 'GRV-01', assignee: { id: 'm1', name: { th: 'ดำรง', en: 'Damrong' } }, actingFor: null, role: { kind: 'POSITION' as const, positionCode: 'DM', position: { th: 'ผู้จัดการฝ่าย', en: 'Department Manager' }, department: { th: 'ฝ่ายก่อสร้าง', en: null }, orgWide: false } }

  it('formats the preview: quantities and money (BigInt satang, 2 decimals), the approver with position and department', () => {
    const view = previewView({
      poStatusAfter: 'RECEIVED',
      linesOutstandingAfter: 0,
      tolerancePct: 5,
      showAmounts: true,
      lines: [{ poLineId: 'l1', description: 'อิฐ', uom: 'ก้อน', received: '1104', rejected: '0', accepted: '1104', outstandingAfter: '0', withinTolerance: '4', holdSatang: 4_000n, excess: { quantity: '100', amountSatang: 100_000_00n, keepApprover: approver }, damaged: null }],
    })
    expect(view.lines[0]).toEqual({
      poLineId: 'l1',
      description: 'อิฐ',
      uom: 'ก้อน',
      received: '1,104',
      rejected: null,
      accepted: '1,104',
      outstandingAfter: '0',
      withinTolerance: '4',
      hold: '40.00',
      excess: { quantity: '100', amount: '100,000.00', keep: { kind: 'ROUTE', ruleCode: 'GRV-01', name: { th: 'ดำรง', en: 'Damrong' }, actingFor: null, position: { th: 'ผู้จัดการฝ่าย', en: 'Department Manager' }, department: { th: 'ฝ่ายก่อสร้าง', en: null } } },
      damaged: null,
    })
  })

  it('leaves amounts out when the service hid them, says when keeping is not possible, and shows what waits on a line', () => {
    const view = previewView({
      poStatusAfter: 'PARTIALLY_RECEIVED',
      linesOutstandingAfter: 1,
      tolerancePct: 0,
      showAmounts: false,
      lines: [{ poLineId: 'l1', description: 'ไม้อัด', uom: 'แผ่น', received: '10', rejected: '2', accepted: '8', outstandingAfter: '2', withinTolerance: null, holdSatang: null, excess: null, damaged: { quantity: '2', amountSatang: null, keepApprover: { kind: 'BLOCKED', code: 'BEYOND_ORDER' } } }],
    })
    expect(view.lines[0]).toMatchObject({ rejected: '2', hold: null, damaged: { quantity: '2', amount: null, keep: { kind: 'BLOCKED', code: 'BEYOND_ORDER' } } })
    expect(approverView({ ...approver, role: { kind: 'POSITION', positionCode: 'CEO', position: null, department: { th: 'สำนักงานใหญ่', en: null }, orgWide: true } })).toMatchObject({ position: { th: 'CEO', en: null }, department: null })
    expect(lineViews([{ id: 'l1', lineNo: 1, description: 'ตะปู', uom: 'ตัว', ordered: '1000', received: '250', cancelled: '0', outstanding: '750', keepPending: '0', unitPriceSatang: null }])).toEqual([
      { id: 'l1', description: 'ตะปู', uom: 'ตัว', ordered: '1,000', received: '250', outstanding: '750', cancelled: null, keepPending: null },
    ])
    expect(lineViews([{ id: 'l2', lineNo: 2, description: 'ไม้อัด', uom: 'แผ่น', ordered: '10', received: '5', cancelled: '4', outstanding: '1', keepPending: '1', unitPriceSatang: null }])[0]).toMatchObject({ cancelled: '4', keepPending: '1' })
  })
})
