import { describe, expect, it } from 'vitest'
import en from '../../messages/en.json'
import th from '../../messages/th.json'
import { POOL_ERROR_KEYS, poolErrorKey, toPoolFailure } from '@/ui/procurement/outcome'
import { PO_ERROR_KEYS, poCancelErrorKey, poErrorKey, toPoFailure } from '@/ui/purchase-order/outcome'
import { TASK_ERROR_KEYS, taskErrorKey, toActionFailure } from '@/ui/tasks/outcome'

// Unit e: what the procurement pool, the purchase-order page and the decision page tell the screen when a command fails
// (§14.2, §9.9 rule 7) — a message key that says what happened and how to fix it, with only the safe parts of the
// details — and that every key has its words in Thai and in English (FR-PLT-002 AC2). The mapping is screen plumbing:
// the acceptance criteria it serves are asserted by the integration and e2e tests of the commands themselves.

describe('the pool explains every refusal of choosing a supplier and of a round', () => {
  it.each([
    [{ code: 'VALIDATION_FAILED', details: { field: 'requestLineIds', reason: 'LINE_NOT_IN_POOL', requestLineIds: ['x'] } }, 'LINE_NOT_IN_POOL'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'supplierId', reason: 'SUPPLIER_INACTIVE' } }, 'SUPPLIER_INACTIVE'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'supplierId', reason: 'SUPPLIER' } }, 'SUPPLIER'],
    [{ code: 'VALIDATION_FAILED', details: { reason: 'NO_CHANGE' } }, 'NO_CHANGE'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'idempotencyKey' } }, 'FAILED'],
    [{ code: 'FORBIDDEN', details: { capability: 'po.create' } }, 'FORBIDDEN'],
    [{ code: 'NOT_FOUND' }, 'NOT_FOUND'],
    [{ code: 'RATE_LIMITED' }, 'BUSY'],
    [{ code: 'IDEMPOTENCY_CONFLICT' }, 'CONFLICT'],
    [{ code: 'INTERNAL', details: { requestId: 'r-1' } }, 'INTERNAL'],
    [{ code: 'MODULE_DISABLED' }, 'FAILED'],
  ] as const)('%j → %s', (error, key) => {
    expect(poolErrorKey(toPoolFailure(error))).toBe(key)
  })

  it('keeps only the safe parts of the details', () => {
    expect(toPoolFailure({ code: 'VALIDATION_FAILED', details: { reason: 'LINE_NOT_IN_POOL', requestLineIds: ['a', 'b'], message: 'x' } })).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'LINE_NOT_IN_POOL' })
  })
})

describe('the purchase-order page explains every refusal and what to fix', () => {
  it.each([
    [{ code: 'INVALID_STATE_TRANSITION', details: { from: 'SENT', command: 'po.cancel', reason: 'GR_POSTED' } }, 'GR_POSTED'],
    [{ code: 'INVALID_STATE_TRANSITION', details: { from: 'PARTIALLY_RECEIVED', command: 'po.close', reason: 'SHORT_NOT_APPROVED' } }, 'SHORT_NOT_APPROVED'],
    [{ code: 'INVALID_STATE_TRANSITION', details: { from: 'APPROVED', command: 'po.edit' } }, 'STATE'],
    [{ code: 'CONFLICT_VERSION', details: { currentVersion: 3 } }, 'CONFLICT_VERSION'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'lines.0.quantity', reason: 'QUANTITY_OVER_REQUEST', left: '10' } }, 'QUANTITY_OVER_REQUEST'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'lines.0.quantity', reason: 'MERGED_LINE' } }, 'MERGED_LINE'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'removeLineIds', reason: 'NO_LINES' } }, 'NO_LINES'],
    [{ code: 'VALIDATION_FAILED', details: { reason: 'NO_CHANGE' } }, 'NO_CHANGE'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'supplierId', reason: 'SUPPLIER_INACTIVE' } }, 'SUPPLIER_INACTIVE'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'lines', reason: 'NO_SOURCE_REQUEST' } }, 'NO_SOURCE_REQUEST'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'supplierEmail', reason: 'MISSING' } }, 'EMAIL_MISSING'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'reason', reason: 'REQUIRED' } }, 'REASON'],
    // A malformed field is named, so the message says which one to fix — never the generic "not saved"
    [{ code: 'VALIDATION_FAILED', details: { field: 'paymentTermDays' } }, 'PAYMENT_DAYS'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'notesToSupplier' } }, 'NOTE'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'lines' } }, 'LINES'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'disposition' } }, 'DISPOSITION'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'poId' } }, 'NOT_FOUND'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'expectedVersion' } }, 'CONFLICT_VERSION'],
    // How much is missing only reaches a member who may view the budget line (the service decides)
    [{ code: 'BUDGET_INSUFFICIENT' }, 'BUDGET_INSUFFICIENT'],
    [{ code: 'BUDGET_INSUFFICIENT', details: { available: '100.00', shortfall: '20.00' } }, 'BUDGET_SHORTFALL'],
    [{ code: 'TAX_RATE_NOT_CONFIGURED', details: { date: '2026-10-05' } }, 'TAX_RATE'],
    [{ code: 'EXTERNAL_SERVICE_ERROR', details: { service: 'email', code: 'ECONNECTION' } }, 'EMAIL_SERVICE'],
    [{ code: 'APPROVER_NOT_FOUND', details: { ruleCode: 'PO-01' } }, 'APPROVER_NOT_FOUND'],
    [{ code: 'FORBIDDEN' }, 'FORBIDDEN'],
    [{ code: 'RATE_LIMITED' }, 'BUSY'],
    [{ code: 'IDEMPOTENCY_CONFLICT' }, 'CONFLICT'],
    [{ code: 'INTERNAL', details: { requestId: 'r-2' } }, 'INTERNAL'],
    [{ code: 'MODULE_DISABLED' }, 'FAILED'],
  ] as const)('%j → %s', (error, key) => {
    expect(poErrorKey(toPoFailure(error))).toBe(key)
  })

  it('tells a lack of budget at cancelling in its own words, and everything else as the page does', () => {
    expect(poCancelErrorKey(toPoFailure({ code: 'BUDGET_INSUFFICIENT' }))).toBe('CANCEL_BUDGET_INSUFFICIENT')
    expect(poCancelErrorKey(toPoFailure({ code: 'BUDGET_INSUFFICIENT', details: { shortfall: '20.00' } }))).toBe('CANCEL_BUDGET_SHORTFALL')
    expect(poCancelErrorKey(toPoFailure({ code: 'VALIDATION_FAILED', details: { field: 'reason' } }))).toBe('REASON')
  })

  it('passes what is left of a request line and what the budget lacks as decimal text, never the available budget', () => {
    expect(toPoFailure({ code: 'VALIDATION_FAILED', details: { field: 'lines.0.quantity', reason: 'QUANTITY_OVER_REQUEST', left: '10' } })).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'lines.0.quantity', reason: 'QUANTITY_OVER_REQUEST', left: '10' })
    expect(toPoFailure({ code: 'BUDGET_INSUFFICIENT', details: { available: '100.00', shortfall: '20.00' } })).toEqual({ ok: false, code: 'BUDGET_INSUFFICIENT', shortfall: '20.00' })
    // A member without budget.view gets the refusal without details from the service: nothing to pass on
    expect(toPoFailure({ code: 'BUDGET_INSUFFICIENT' })).toEqual({ ok: false, code: 'BUDGET_INSUFFICIENT' })
  })
})

describe('the decision page explains a refusal for lack of budget without amounts', () => {
  it.each([
    [{ code: 'BUDGET_INSUFFICIENT', details: { available: '10.00', shortfall: '390.00' } }, 'BUDGET'],
    [{ code: 'BUDGET_INSUFFICIENT' }, 'BUDGET'],
    [{ code: 'BUDGET_LINE_CLOSED', details: { status: 'FROZEN' } }, 'BUDGET_LINE_CLOSED'],
  ] as const)('%j → %s', (error, key) => {
    expect(taskErrorKey(toActionFailure(error))).toBe(key)
  })
})

describe('[FR-PLT-002/AC2] every message of the procurement screens is written in Thai and in English', () => {
  it('has a Thai and an English message for every error key of the pool, the purchase-order page and the decision page', () => {
    for (const messages of [th, en]) {
      for (const key of POOL_ERROR_KEYS) expect(messages.procurement.pool.errors[key]).toEqual(expect.any(String))
      for (const key of PO_ERROR_KEYS) expect(messages.purchaseOrder.errors[key]).toEqual(expect.any(String))
      for (const key of TASK_ERROR_KEYS) expect(messages.tasks.errors[key]).toEqual(expect.any(String))
    }
  })

  it('says how much budget is missing only in the messages that receive it', () => {
    for (const messages of [th, en]) {
      expect(messages.purchaseOrder.errors.BUDGET_INSUFFICIENT).not.toContain('{shortfall}')
      expect(messages.purchaseOrder.errors.CANCEL_BUDGET_INSUFFICIENT).not.toContain('{shortfall}')
      expect(messages.purchaseOrder.errors.BUDGET_SHORTFALL).toContain('{shortfall}')
      expect(messages.tasks.errors.BUDGET).not.toMatch(/\{(available|shortfall)\}/)
    }
  })
})
