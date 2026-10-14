import { describe, expect, it } from 'vitest'
import { checkDuplicates, type DupRecent } from '@/core/duplicates'

// BR-DUP-02 to BR-DUP-04 beyond the golden cases: matches sent at the same instant keep a fixed order, a candidate with no
// supplier splits only by a line in common, and an amount no rule covers never makes a SPLIT.

const AT = new Date('2026-10-06T03:00:00Z')
const base = { requesterMemberId: 'u1', chargedDepartmentId: 'CON', suggestedSupplierId: null, lines: [{ description: 'A', uom: 'ชิ้น', quantity: '1' }] }
const recent = (id: string, over: Partial<DupRecent> = {}): DupRecent => ({ ...base, id, status: 'APPROVED', submittedAt: new Date('2026-10-05T03:00:00Z'), basisAmountSatang: 1_500_000n, ...over })
const ruleFor = (amount: bigint) => (amount <= 2_000_000n ? 'PR-01' : 'PR-02')

describe('[FR-INT-103/AC1] the duplicate check', () => {
  it('two matches sent at the same instant come in the order of their ids', () => {
    const flags = checkDuplicates({ ...base, id: 'c', basisAmountSatang: 1n }, [recent('r2'), recent('r3'), recent('r1'), recent('c')], { at: AT, windowDays: 7, ruleFor })
    // The request itself (a resubmit finds its own earlier send) is never a match
    expect(flags[0]).toEqual({ kind: 'DUPLICATE', matchedRequestIds: ['r1', 'r2', 'r3'] })
  })

  it('without a supplier, a request of another thing of the department is no split', () => {
    const other = recent('r1', { requesterMemberId: 'u2', lines: [{ description: 'B', uom: 'ชิ้น', quantity: '1' }] })
    expect(checkDuplicates({ ...base, id: 'c', basisAmountSatang: 1_000_000n }, [other], { at: AT, windowDays: 7, ruleFor })).toEqual([])
  })

  it('a combined amount no rule covers makes no split', () => {
    const other = recent('r1', { requesterMemberId: 'u2', lines: [{ description: 'A', uom: 'ชิ้น', quantity: '2' }] })
    expect(checkDuplicates({ ...base, id: 'c', basisAmountSatang: 1_000_000n }, [other], { at: AT, windowDays: 7, ruleFor: () => null })).toEqual([])
  })
})
