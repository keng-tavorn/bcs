import { describe, expect, it } from 'vitest'
import { emptyLine, fund, releaseTransfer, reserveTransfer, transferDoaInput, transferIn, transferOut, type LineState } from '@/core/budget'

// BR-BUD-08 to BR-BUD-11 beyond the golden cases: a FROZEN line takes no transfer either way, an amount must be above
// zero, a transfer that reserved nothing cannot leave, a release with nothing reserved moves nothing, and the DOA input
// needs the line that decides its department.

const funded = (): LineState => {
  const r = fund(emptyLine(), 100_000n, 'imp')
  if (!r.ok) throw new Error('fund')
  return r.state
}

describe('[FR-BUD-103/AC1] transfer operations refuse what does not fit', () => {
  it('a FROZEN line neither reserves for a transfer nor takes one in', () => {
    const frozen = { ...funded(), status: 'FROZEN' as const }
    expect(reserveTransfer(frozen, 'T1', 1n)).toEqual({ ok: false, error: { code: 'BUDGET_LINE_CLOSED', status: 'FROZEN' } })
    expect(transferIn(frozen, 'T1', 1n)).toEqual({ ok: false, error: { code: 'BUDGET_LINE_CLOSED', status: 'FROZEN' } })
  })

  it('an amount must be above zero; nothing reserved leaves nothing and releases nothing', () => {
    expect(reserveTransfer(funded(), 'T1', 0n)).toMatchObject({ ok: false, error: { reason: 'AMOUNT_NOT_POSITIVE' } })
    expect(transferIn(funded(), 'T1', 0n)).toMatchObject({ ok: false, error: { reason: 'AMOUNT_NOT_POSITIVE' } })
    expect(transferOut(funded(), 'T9')).toMatchObject({ ok: false, error: { reason: 'NOTHING_RESERVED' } })
    expect(releaseTransfer(funded(), 'T9')).toMatchObject({ ok: true, movements: [] })
  })

  it('the DOA input needs the line that names the department', () => {
    expect(() => transferDoaInput({ kind: 'INCREASE', fromDepartmentId: 'CON', toDepartmentId: null, amountSatang: 1n, submitterMemberId: 'u1' })).toThrow(RangeError)
    expect(() => transferDoaInput({ kind: 'DECREASE', fromDepartmentId: null, toDepartmentId: 'IT', amountSatang: 1n, submitterMemberId: 'u1' })).toThrow(RangeError)
  })
})
