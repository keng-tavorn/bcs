import { describe, expect, it } from 'vitest'
import { bankChangePortalConflicts, checkSod } from '@/core/sod'

// BR-SOD-12 (S7-10 · ADR-190 · GC-SOD-18 is the golden): a bank account change from the supplier portal has no member
// proposer; the member who claimed it and the one who recorded the call never approve it. An internal change keeps
// BR-SOD-05 (its proposer never approves).

const policy = { approverMayReceive: false, requesterMayReceive: true }
const decide = (actor: string, requester: string[], bankChange?: Parameters<typeof bankChangePortalConflicts>[0]) =>
  checkSod({ kind: 'DECIDE_APPROVAL', subject: 'BANK_ACCOUNT_CHANGE', actorMemberId: actor, requesterMemberIds: requester, ...(bankChange ? { bankChange } : {}) }, policy)

describe('[BR-SOD-12] who never approves a bank account change from the portal', () => {
  it('the claimer or the call recorder: BR-SOD-12; anyone else may', () => {
    const change = { source: 'PORTAL' as const, submittedById: 'fin_ap1', callVerifiedById: 'fin_ap2' }
    expect(decide('fin_ap1', [], change)).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-12' })
    expect(decide('fin_ap2', [], change)).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-12' })
    expect(decide('cfo', [], change)).toEqual({ ok: true })
  })

  it('a change from the portal not yet claimed names no one; an internal change keeps BR-SOD-05 for its proposer', () => {
    expect(decide('cfo', [], { source: 'PORTAL', submittedById: null, callVerifiedById: null })).toEqual({ ok: true })
    expect(decide('fin_officer', ['fin_officer'], { source: 'INTERNAL', submittedById: 'fin_officer', callVerifiedById: 'fin_officer' })).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-05' })
    expect(decide('fin_officer', ['fin_officer'])).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-05' })
  })

  it('bankChangePortalConflicts: the claimer and the call recorder once each; none for an internal change', () => {
    expect(bankChangePortalConflicts({ source: 'PORTAL', submittedById: 'a', callVerifiedById: 'a' })).toEqual(['a'])
    expect(bankChangePortalConflicts({ source: 'PORTAL', submittedById: 'a', callVerifiedById: 'b' })).toEqual(['a', 'b'])
    expect(bankChangePortalConflicts({ source: 'PORTAL', submittedById: '', callVerifiedById: null })).toEqual([])
    expect(bankChangePortalConflicts({ source: 'INTERNAL', submittedById: 'a', callVerifiedById: 'b' })).toEqual([])
  })
})
