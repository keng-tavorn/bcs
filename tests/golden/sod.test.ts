import { describe, expect, it } from 'vitest'
import { checkSod, type ApprovalSubject, type OrgAuthorityChangeKind, type SodAction } from '@/core/sod'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/sod.yaml (spec §7.5): GC-SOD-01 to GC-SOD-16 (GC-SOD-10 on: the payment run and the bank account change of S9).

interface SodCase {
  id: string
  title?: string
  input: {
    action: 'DECIDE_APPROVAL' | 'POST_GR' | 'PROPOSE_ORG_AUTHORITY_CHANGE' | 'PREPARE_PAYMENT'
    actor: string
    requester?: string
    approvers?: string[]
    subject?: ApprovalSubject
    poCreator?: string
    kind?: OrgAuthorityChangeKind
    beneficiary?: string
    invoiceRecorders?: string[]
    payDate?: string
    recentBankChangeDays?: number
    bankChanges?: Array<{ proposer: string; effectiveOn: string }>
  }
  expect: Record<string, unknown>
}

const suite = loadYaml<{ sodPolicy: { approverMayReceive: boolean; requesterMayReceive: boolean }; cases: SodCase[] }>('sod.yaml')

function action(i: SodCase['input']): SodAction {
  const recentBankChanges = i.bankChanges ? { payDate: i.payDate!, recentBankChangeDays: i.recentBankChangeDays!, changes: i.bankChanges.map((b) => ({ proposerMemberId: b.proposer, effectiveOn: b.effectiveOn })) } : undefined
  if (i.action === 'PREPARE_PAYMENT') return { kind: 'PREPARE_PAYMENT', actorMemberId: i.actor, recentBankChanges: recentBankChanges! }
  if (i.action === 'POST_GR') return { kind: 'POST_GR', actorMemberId: i.actor, requesterMemberIds: i.requester ? [i.requester] : [], approverMemberIds: i.approvers ?? [] }
  if (i.action === 'PROPOSE_ORG_AUTHORITY_CHANGE') return { kind: 'PROPOSE_ORG_AUTHORITY_CHANGE', changeKind: i.kind!, actorMemberId: i.actor, beneficiaryMemberId: i.beneficiary ?? null }
  return {
    kind: 'DECIDE_APPROVAL',
    subject: i.subject ?? 'REQUEST',
    actorMemberId: i.actor,
    requesterMemberIds: i.requester ? [i.requester] : [],
    poCreatorMemberId: i.poCreator ?? null,
    ...(i.invoiceRecorders ? { invoiceRecorderMemberIds: i.invoiceRecorders } : {}),
    ...(recentBankChanges ? { recentBankChanges } : {}),
  }
}

describe('golden sod.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const result = checkSod(action(c.input), suite.sodPolicy)
      const actual = result.ok ? { ok: true } : { error: result.error, rule: result.rule }
      expect(pick(actual, c.expect)).toEqual(c.expect)
    })
  }
})

describe('[FR-DOA-007/AC1] separation of duties beyond the golden cases', () => {
  const policy = { approverMayReceive: false, requesterMayReceive: true }
  it('lets an approver receive only when the version allows it, and stops the requester when it does not', () => {
    const gr = { kind: 'POST_GR' as const, actorMemberId: 'vp_ops', requesterMemberIds: ['req_con'], approverMemberIds: ['vp_ops'] }
    expect(checkSod(gr, { ...policy, approverMayReceive: true })).toEqual({ ok: true })
    const own = { kind: 'POST_GR' as const, actorMemberId: 'req_con', requesterMemberIds: ['req_con'], approverMemberIds: [] }
    expect(checkSod(own, { ...policy, requesterMayReceive: false })).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-07' })
  })

  it('lets others approve a DOA version or an authority change, and checks every source requester of a PO', () => {
    expect(checkSod({ kind: 'DECIDE_APPROVAL', subject: 'DOA_VERSION', actorMemberId: 'ceo', requesterMemberIds: ['admin'] }, policy)).toEqual({ ok: true })
    expect(checkSod({ kind: 'DECIDE_APPROVAL', subject: 'ORG_AUTHORITY_CHANGE', actorMemberId: 'ceo', requesterMemberIds: ['admin'] }, policy)).toEqual({ ok: true })
    expect(checkSod({ kind: 'DECIDE_APPROVAL', subject: 'PURCHASE_ORDER', actorMemberId: 'req_it', requesterMemberIds: ['req_con', 'req_it'], poCreatorMemberId: 'proc_officer' }, policy)).toEqual({
      ok: false,
      error: 'SOD_VIOLATION',
      rule: 'BR-SOD-01',
    })
    expect(checkSod({ kind: 'DECIDE_APPROVAL', subject: 'PURCHASE_ORDER', actorMemberId: 'coo', requesterMemberIds: ['req_con'], poCreatorMemberId: 'proc_officer' }, policy)).toEqual({ ok: true })
  })

  it('treats ending a position or moving a department as having no self-benefit', () => {
    expect(checkSod({ kind: 'PROPOSE_ORG_AUTHORITY_CHANGE', changeKind: 'POSITION_END', actorMemberId: 'admin', beneficiaryMemberId: 'admin' }, policy)).toEqual({ ok: true })
    expect(checkSod({ kind: 'PROPOSE_ORG_AUTHORITY_CHANGE', changeKind: 'IDENTITY_RESET', actorMemberId: 'admin', beneficiaryMemberId: 'admin' }, policy)).toEqual({
      ok: false,
      error: 'SOD_VIOLATION',
      rule: 'BR-SOD-08',
    })
  })
})

describe('[FR-PAY-101/AC8] separation of duties of S9 beyond the golden cases', () => {
  const policy = { approverMayReceive: false, requesterMayReceive: true }
  it('lets another member approve a run with no invoice recorders or bank changes named, and a bank change proposed by someone else', () => {
    expect(checkSod({ kind: 'DECIDE_APPROVAL', subject: 'PAYMENT_RUN', actorMemberId: 'cfo', requesterMemberIds: ['fin_tre1'] }, policy)).toEqual({ ok: true })
    expect(checkSod({ kind: 'DECIDE_APPROVAL', subject: 'BANK_ACCOUNT_CHANGE', actorMemberId: 'cfo', requesterMemberIds: ['fin_ap1'] }, policy)).toEqual({ ok: true })
  })
})
