import { describe, expect, it } from 'vitest'
import { buildItem, buildRun, flagsKey, itemFlags, nextRunDate, proposeDocuments, type ItemDocument, type PayCalendar } from '@/core/payment'

// src/core/payment beyond the golden cases of payment-run.yaml (S9-02): the refusals a run passes on, the NEXT shift,
// documents without a due date, an item without the optional facts, and the order of codes either way round.

const calendar: PayCalendar = { workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], holidays: ['2026-10-23'] }
const doc = (payable: bigint, base?: bigint, incomeType = 'SERVICE'): ItemDocument => ({ kind: 'INVOICE', doc: `D${payable}`, payableSatang: payable, whtLines: base === undefined ? [] : [{ incomeType, rateBp: 300, baseSatang: base }] })

describe('[FR-PAY-101/AC3] buildItem and buildRun refuse what cannot be paid', () => {
  it('a negative tax base is VALIDATION_FAILED WHT_BASE_NEGATIVE (paymentWithholding of S8)', () => {
    expect(buildItem([doc(10_000n, -1n)])).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'WHT_BASE_NEGATIVE' })
  })

  it('a run names the supplier whose item transfers nothing, and keeps its own refusal', () => {
    expect(buildRun([{ code: 'SP0002', docs: [doc(10_000n)] }, { code: 'SP0001', docs: [doc(0n)] }])).toEqual({ ok: false, code: 'PAYMENT_ITEM_NOT_POSITIVE', transferSatang: 0n, supplierCode: 'SP0001' })
  })

  it('numbers items by supplier code whatever order they come in, and shares the tax back over the documents', () => {
    const run = buildRun([{ code: 'SP0003', docs: [doc(10_700n, 10_000n)] }, { code: 'SP0001', docs: [doc(5_000n)] }, { code: 'SP0002', docs: [doc(2_000n)] }])
    expect(run.ok && run.items.map((i) => [i.seq, i.code])).toEqual([[1, 'SP0001'], [2, 'SP0002'], [3, 'SP0003']])
    const item = buildItem([doc(10_700n, 10_000n), doc(5_350n, 5_000n)])
    expect(item.ok && item.docs).toEqual([{ doc: 'D10700', whtSatang: 300n }, { doc: 'D5350', whtSatang: 150n }])
  })
})

describe('[FR-PAY-101/AC2] the pay date and the documents proposed', () => {
  it('moves a Friday holiday to the next working day when the policy says NEXT', () => {
    expect(nextRunDate('2026-10-19', { runWeekdays: ['FRI'], holidayShift: 'NEXT' }, calendar)).toBe('2026-10-26')
  })

  it('needs one run weekday at least', () => {
    expect(() => nextRunDate('2026-10-19', { runWeekdays: [], holidayShift: 'PREVIOUS' }, calendar)).toThrow(RangeError)
  })

  it('never proposes an invoice without a due date', () => {
    const docs = [
      { id: 'I1', kind: 'INVOICE' as const },
      { id: 'I2', kind: 'INVOICE' as const, dueDate: null },
      { id: 'I3', kind: 'INVOICE' as const, dueDate: '2026-10-01' },
    ]
    expect(proposeDocuments('2026-10-16', docs).map((d) => d.id)).toEqual(['I3'])
  })
})

describe('[FR-PAY-101/AC4] flags without the optional facts', () => {
  it('an active supplier with a seeded account and nothing else has no flag', () => {
    expect(itemFlags({ payDate: '2026-10-16', supplier: { registryFlag: 'NONE', status: 'ACTIVE', taxId: null }, account: { activatedOn: '2026-10-15', fromSeed: true } }, { recentBankChangeDays: 30 })).toEqual({ flags: [], requiresReason: false })
  })

  it('a supplier without a tax id shares an account with any other supplier', () => {
    const r = itemFlags({ payDate: '2026-10-16', supplier: { registryFlag: 'NONE', status: 'ACTIVE', taxId: null }, account: { activatedOn: '2026-01-05', fromSeed: true }, sameAccountTaxIds: ['0999998010560'] }, { recentBankChangeDays: 30 })
    expect(r.flags).toEqual(['SHARED_BANK_ACCOUNT'])
  })

  it('keys the items by supplier code whichever comes first', () => {
    const a = { code: 'SP0001', flags: ['SUPPLIER_INACTIVE' as const] }
    const b = { code: 'SP0002', flags: ['REGISTRY_CHANGED' as const] }
    expect(flagsKey([a, b])).toBe(flagsKey([b, a]))
    expect(flagsKey([a, b])).toBe('SP0001:SUPPLIER_INACTIVE;SP0002:REGISTRY_CHANGED')
  })
})

describe('S9-02 review: what the engine refuses rather than guesses', () => {
  it('throws on a day that does not exist instead of using the day it rolls into', () => {
    expect(() => nextRunDate('2026-02-30', { runWeekdays: ['FRI'], holidayShift: 'PREVIOUS' }, calendar)).toThrow(RangeError)
    expect(() => itemFlags({ payDate: '2026-13-01', supplier: { registryFlag: 'NONE', status: 'ACTIVE', taxId: null }, account: { activatedOn: '2026-01-05', fromSeed: false } }, { recentBankChangeDays: 30 })).toThrow(RangeError)
  })

  it('stops with an error when the calendar has no working day within a year, never searching forever', () => {
    expect(() => nextRunDate('2026-10-12', { runWeekdays: ['FRI'], holidayShift: 'PREVIOUS' }, { workdays: [], holidays: [] })).toThrow(/no working day/)
  })

  it('refuses two items for one supplier code (BR-PAY-05)', () => {
    expect(() => buildRun([{ code: 'SP0001', docs: [doc(1_000n)] }, { code: 'SP0001', docs: [doc(2_000n)] }])).toThrow(RangeError)
  })

  it('flags an account shared with or by a supplier without a tax id (a foreign supplier is never known to be the same one)', () => {
    const flags = (taxId: string | null, others: (string | null)[]) => itemFlags({ payDate: '2026-10-16', supplier: { registryFlag: 'NONE', status: 'ACTIVE', taxId }, account: { activatedOn: '2026-01-05', fromSeed: true }, sameAccountTaxIds: others }, { recentBankChangeDays: 30 }).flags
    expect(flags(null, [null])).toEqual(['SHARED_BANK_ACCOUNT'])
    expect(flags('0999998010560', [null])).toEqual(['SHARED_BANK_ACCOUNT'])
    expect(flags('0999998010560', ['0999998010560'])).toEqual([])
  })
})
