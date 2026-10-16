// S17-13 S17-14 (FR-PLT-301 AC6 to AC9, BR-APP-04, BR-APP-06, BR-APP-09): what /go/receive works out on the phone
// without asking the server — who it records and sends for, the PO version a queued receipt expects, the excess beyond
// the tolerance its form asks about (as src/server/services/receiving measures it: receiveOnLine), and how many PO copies
// it keeps. The page itself runs offline in tests/e2e/go-receive.spec.ts.
import { describe, expect, it } from 'vitest'
import { parseQuantity } from '@/core/money/math'
import { excessOf } from '@/ui/go-receive/receipt-form'
import { knownFor } from '@/ui/go-receive/runner'
import { actingMember, keepResolved, type PoCopy, type PoLineCopy, type Prepared, type StoredItem } from '@/ui/go-receive/store'

const item = (over: Partial<StoredItem> = {}): StoredItem => ({
  key: 'k1',
  poId: 'PO-A',
  by: 'me',
  capturedAt: '2026-11-02T01:00:00Z',
  status: 'QUEUED',
  attempts: 0,
  photos: [],
  payload: { lines: [], deliveryNoteNo: '', notes: '' },
  poNumber: 'PO-2026-0001',
  supplier: 'ผู้ขาย',
  capturedOnVersion: 3,
  ...over,
})

describe('[FR-PLT-301/AC8] the PO version a queued receipt expects (BR-APP-06)', () => {
  it('is the version of the copy it was recorded on while the phone sent nothing newer of that PO', () => {
    expect(knownFor(item(), {})).toEqual({ 'PO-A': 3 })
    expect(knownFor(item(), { 'PO-B': 9 })).toEqual({ 'PO-A': 3, 'PO-B': 9 })
  })

  it("follows what the phone's own earlier receipt of the PO was answered with", () => {
    // Two receipts recorded on copy 3 without a signal: the first went and made the PO version 4
    expect(knownFor(item(), { 'PO-A': 4 })).toEqual({ 'PO-A': 4 })
  })

  it('a copy prepared again later never moves it: a PO changed meanwhile is refused, not received unseen', () => {
    // Recorded on copy 3; the PO went to 5 elsewhere and the copy was prepared again: the receipt still expects 3
    expect(knownFor(item({ capturedOnVersion: 3 }), {})['PO-A']).toBe(3)
    // An answer older than the copy it was recorded on (versions only grow) counts for nothing
    expect(knownFor(item({ capturedOnVersion: 6 }), { 'PO-A': 4 })['PO-A']).toBe(6)
  })
})

describe('[FR-PLT-301/AC7] the excess beyond the tolerance the offline form asks about (BR-APP-04, BR-GR-02)', () => {
  const line = (over: Partial<PoLineCopy> = {}): PoLineCopy => ({ poLineId: 'L1', description: 'ไม้อัด', uom: 'แผ่น', ordered: '100', received: '0', cancelled: '0', ...over })
  const q = (text: string) => parseQuantity(text)

  it('nothing within what is on order and the tolerance; beyond it, the excess', () => {
    expect(excessOf(line(), q('100'), 5)).toBe(0n)
    expect(excessOf(line(), q('105'), 5)).toBe(0n)
    expect(excessOf(line(), q('107'), 5)).toBe(q('2'))
  })

  it('counts what was received already and what an approved close-short gave up', () => {
    expect(excessOf(line({ received: '96' }), q('10'), 5)).toBe(q('1'))
    expect(excessOf(line({ cancelled: '50' }), q('55'), 0)).toBe(q('5'))
  })

  it('a line with nothing left on order takes every unit as an excess; nothing accepted asks nothing', () => {
    expect(excessOf(line({ cancelled: '100' }), q('3'), 10)).toBe(q('3'))
    expect(excessOf(line(), 0n, 5)).toBe(0n)
  })
})

describe('[FR-PLT-301/AC9] the member the page records and sends for (BR-APP-09)', () => {
  const prepared = { memberId: 'm-copies' }
  it('the one the server named; before any answer (opened without a signal), the one the copies were prepared for', () => {
    expect(actingMember({ member: 'm-now', known: true }, prepared)).toBe('m-now')
    expect(actingMember({ member: null, known: false }, prepared)).toBe('m-copies')
    expect(actingMember({ member: null, known: false }, null)).toBeNull()
  })

  it('nobody once the server said nobody is signed in: never the member the copies were for', () => {
    expect(actingMember({ member: null, known: true }, prepared)).toBeNull()
  })
})

describe('[FR-PLT-301/AC6] a copy resolved from a scanned QR is kept within maxPreparedPos (BR-APP-04)', () => {
  const copy = (poId: string): PoCopy => ({ poId, number: poId, version: 1, status: 'SENT', sentAt: null, supplier: 'ผู้ขาย', site: null, overTolerancePct: 5, lines: [], tokenHashes: [], preparedAt: '2026-10-16T03:00:00.000Z' })
  const prepared = (ids: string[], max: number): Prepared => ({ memberId: 'm', copies: ids.map(copy), truncated: false, retentionDays: 7, maxPreparedPos: max, preparedAt: '2026-10-16T03:00:00.000Z' })

  it('added while the phone keeps fewer than the organization allows; a copy of a PO it has replaces it', () => {
    expect(keepResolved(prepared(['A'], 2), copy('B'))?.copies.map((c) => c.poId)).toEqual(['B', 'A'])
    expect(keepResolved(prepared(['A', 'B'], 2), { ...copy('B'), version: 2 })?.copies.map((c) => c.version)).toEqual([1, 2])
  })

  it('not kept at the cap: the form opens from it, the phone keeps no more copies', () => {
    expect(keepResolved(prepared(['A', 'B'], 2), copy('C'))).toBeNull()
  })
})
