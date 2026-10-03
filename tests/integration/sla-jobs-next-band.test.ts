import { describe, expect, it } from 'vitest'
import type { DelegationSnapshot, DoaDocumentType } from '@/core/doa'
import { amountToSatang } from '@/core/money/dto'
import type { BusinessCalendar } from '@/core/sla'
import { DEFAULT_ESCALATE_AFTER_MINUTES, nextBandApprover, remindMinutesOf, slaPolicyOf, slaTimes } from '@/server/services/sla'
import { orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'

// The pure parts of the SLA jobs: which approver is "of the next band" (BR-SLA-04 — upwards only, never to lower
// authority, passing over a band whose approver is tied to the document like BR-DOA-06) on the §7.4 fixtures (members
// and departments are their codes), and the SLA times (BR-SLA-02, BR-SLA-03) on the §7.8 calendar.

const v1 = versionSnapshots().find((v) => v.versionNo === 1)!
const AT = new Date('2026-10-06T03:00:00Z')

function next(ruleCode: string, options: { documentType?: DoaDocumentType; amount?: string; department?: string | null; conflicts?: string[]; deciders?: string[]; vacate?: string[]; delegations?: DelegationSnapshot[] } = {}) {
  return nextBandApprover(
    {
      version: v1,
      ruleCode,
      documentType: options.documentType ?? 'PURCHASE_REQUEST',
      basisAmountSatang: options.amount ? amountToSatang(options.amount) : null,
      chargedDepartmentId: options.department === undefined ? 'CON' : options.department,
      at: AT,
      conflictMemberIds: options.conflicts ?? ['req_con'],
      currentDeciderIds: options.deciders ?? [],
    },
    orgSnapshot(options.vacate ?? []),
    options.delegations ?? [],
  )
}

const delegation = (over: Partial<DelegationSnapshot>): DelegationSnapshot => ({
  id: 'D1',
  delegatorMemberId: 'vp_ops',
  delegateMemberId: 'dm_proc',
  startsAt: new Date('2026-10-05T00:00:00Z'),
  endsAt: new Date('2026-10-10T00:00:00Z'),
  documentTypes: null,
  maxAmountSatang: null,
  status: 'ACTIVE',
  ...over,
})

describe('[FR-NOTI-003/AC2] the approver of the next band is found upwards only (BR-SLA-04)', () => {
  it('PR-01 (DM) → PR-02 (VP of the charged department’s chain) → PR-03 (CEO) → nothing above', () => {
    expect(next('PR-01', { deciders: ['dm_con'] })).toEqual({ kind: 'FOUND', ruleCode: 'PR-02', approverMemberId: 'vp_ops', assigneeMemberId: 'vp_ops', principalMemberId: null, resolvedFrom: 'POSITION:VP@OPS', notifyOrgAdmin: false })
    expect(next('PR-02', { deciders: ['vp_ops'] })).toMatchObject({ kind: 'FOUND', ruleCode: 'PR-03', assigneeMemberId: 'ceo', resolvedFrom: 'POSITION:CEO@HQ' })
    expect(next('PR-03', { deciders: ['ceo'] })).toEqual({ kind: 'NONE', reason: 'NO_HIGHER_BAND', ruleCode: null })
    // the chain of the charged department: IT goes up through SUP
    expect(next('PR-01', { department: 'IT', deciders: ['dm_it'] })).toMatchObject({ kind: 'FOUND', assigneeMemberId: 'vp_sup', resolvedFrom: 'POSITION:VP@SUP' })
  })

  it('purchase orders climb their own bands; rules without an amount band have no next band', () => {
    expect(next('PO-01', { documentType: 'PURCHASE_ORDER', deciders: ['coo'], conflicts: ['proc_officer'] })).toMatchObject({ kind: 'FOUND', ruleCode: 'PO-02', assigneeMemberId: 'ceo' })
    expect(next('PO-02', { documentType: 'PURCHASE_ORDER', deciders: ['ceo'] })).toMatchObject({ kind: 'NONE', reason: 'NO_HIGHER_BAND' })
    expect(next('GRV-01', { documentType: 'GR_VARIANCE', deciders: ['dm_con'] })).toMatchObject({ kind: 'NONE', reason: 'NO_HIGHER_BAND' })
    expect(next('DOA-CHG-01', { documentType: 'DOA_CHANGE', department: null, deciders: ['ceo'] })).toMatchObject({ kind: 'NONE', reason: 'NO_HIGHER_BAND' })
    expect(next('ORG-CHG-01', { documentType: 'ORG_AUTHORITY_CHANGE', department: null, deciders: ['ceo'] })).toMatchObject({ kind: 'NONE', reason: 'NO_HIGHER_BAND' })
    // a rule code of another document type is not this document's band
    expect(next('PO-01', { deciders: ['coo'] })).toMatchObject({ kind: 'NONE', reason: 'NO_HIGHER_BAND' })
  })

  it('passes over a band whose approver is tied to the document or already decides it, never down', () => {
    expect(next('PR-01', { conflicts: ['vp_ops'], deciders: ['dm_con'] })).toMatchObject({ kind: 'FOUND', ruleCode: 'PR-03', assigneeMemberId: 'ceo' })
    expect(next('PR-01', { deciders: ['dm_con', 'vp_ops'] })).toMatchObject({ kind: 'FOUND', ruleCode: 'PR-03', assigneeMemberId: 'ceo' })
    expect(next('PR-02', { conflicts: ['ceo'], deciders: ['vp_ops'] })).toMatchObject({ kind: 'NONE', reason: 'NO_HIGHER_BAND' })
  })

  it('a vacant next band is reported, not skipped (APPROVER_NOT_FOUND)', () => {
    expect(next('PR-01', { vacate: ['VP@OPS'], deciders: ['dm_con'] })).toEqual({ kind: 'NONE', reason: 'APPROVER_NOT_FOUND', ruleCode: 'PR-02' })
  })

  it('the holder’s own delegation applies (BR-DLG-04); a delegate tied to the document leaves it with the holder (BR-DLG-05)', () => {
    expect(next('PR-01', { deciders: ['dm_con'], delegations: [delegation({})] })).toMatchObject({ kind: 'FOUND', approverMemberId: 'vp_ops', assigneeMemberId: 'dm_proc', principalMemberId: 'vp_ops', notifyOrgAdmin: false })
    expect(next('PR-01', { deciders: ['dm_con'], conflicts: ['req_con', 'dm_proc'], delegations: [delegation({})] })).toMatchObject({ assigneeMemberId: 'vp_ops', principalMemberId: null, notifyOrgAdmin: true })
    // a capped delegation does not cover a larger amount (BR-DLG-01); a revoked one never applies
    expect(next('PR-01', { amount: '15000.00', deciders: ['dm_con'], delegations: [delegation({ maxAmountSatang: amountToSatang('10000.00') })] })).toMatchObject({ assigneeMemberId: 'vp_ops', principalMemberId: null })
    expect(next('PR-01', { deciders: ['dm_con'], delegations: [delegation({ status: 'REVOKED' })] })).toMatchObject({ assigneeMemberId: 'vp_ops', principalMemberId: null })
    // the delegate already decides the step: the holder takes it themselves
    expect(next('PR-01', { deciders: ['dm_con', 'dm_proc'], delegations: [delegation({})] })).toMatchObject({ assigneeMemberId: 'vp_ops', principalMemberId: null })
  })
})

// §7.8 calendar (tests/golden/sla.yaml)
const CALENDAR: BusinessCalendar = { timezone: 'Asia/Bangkok', workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], start: '08:30', end: '17:30', holidays: ['2026-10-13', '2026-10-23'] }

describe('[FR-NOTI-003/AC1] SLA times of a task: reminder at the version’s share, escalation after its delay (BR-SLA-02)', () => {
  it('reads the policy of the DOA version, with BR-SLA-02 defaults for anything missing or malformed', () => {
    expect(slaPolicyOf({ remindPct: 0.5, escalateAfterBusinessHours: 8 })).toEqual({ remindShare: 0.5, escalateAfterMinutes: 480 })
    expect(slaPolicyOf({ remindPct: 0.25, escalateAfterBusinessHours: 2 })).toEqual({ remindShare: 0.25, escalateAfterMinutes: 120 })
    expect(slaPolicyOf({ escalateAfterBusinessMinutes: 90, escalateAfterBusinessHours: 8 })).toEqual({ remindShare: 0.5, escalateAfterMinutes: 90 })
    expect(slaPolicyOf({ escalateAfterBusinessHours: 0 })).toEqual({ remindShare: 0.5, escalateAfterMinutes: 0 })
    for (const bad of [{}, null, 'x', { escalateAfterBusinessHours: -1 }, { escalateAfterBusinessHours: 1.5 }, { escalateAfterBusinessHours: '' }]) {
      expect(slaPolicyOf(bad)).toEqual({ remindShare: 0.5, escalateAfterMinutes: DEFAULT_ESCALATE_AFTER_MINUTES })
    }
    expect(DEFAULT_ESCALATE_AFTER_MINUTES).toBe(480)
    // as core remindAt: the share as a whole percent, half up (GC-SLA-07: 50% of 480 = 240)
    expect(remindMinutesOf(480, 0.5)).toBe(240)
    expect(remindMinutesOf(45, 0.5)).toBe(23)
    expect(remindMinutesOf(960, 0.25)).toBe(240)
  })

  it('GC-SLA-07 for a new task; after an answer the reminder is counted from the time left (GC-SLA-06)', () => {
    const policy = { remindShare: 0.5, escalateAfterMinutes: 480 }
    const fresh = { assignedAt: new Date('2026-10-05T01:30:00Z'), dueAt: new Date('2026-10-05T09:30:00Z'), remindAt: new Date('2026-10-05T05:30:00Z'), slaMinutes: 480, lastResumedAt: null, reminded: false }
    expect(slaTimes(fresh, policy, CALENDAR)).toEqual({ remindAt: new Date('2026-10-05T05:30:00Z'), dueAt: new Date('2026-10-05T09:30:00Z'), escalateAt: new Date('2026-10-06T08:30:00Z') })
    expect(slaTimes({ ...fresh, reminded: true }, policy, CALENDAR).remindAt).toBeNull()
    // moved to its holder after the reminder time (a delegation, a new position holder): not reminded for it
    expect(slaTimes({ ...fresh, assignedAt: new Date('2026-10-05T06:00:00Z') }, policy, CALENDAR).remindAt).toBeNull()
    // GC-SLA-06: paused after 180 minutes, answered Wednesday 10:00, due 15:00; the reminder 60 minutes after the answer
    const resumed = { ...fresh, dueAt: new Date('2026-10-07T08:00:00Z'), lastResumedAt: new Date('2026-10-07T03:00:00Z') }
    expect(slaTimes(resumed, policy, CALENDAR)).toEqual({ remindAt: new Date('2026-10-07T04:00:00Z'), dueAt: new Date('2026-10-07T08:00:00Z'), escalateAt: new Date('2026-10-08T07:00:00Z') })
    // paused after the reminder point: none after the answer
    expect(slaTimes({ ...resumed, dueAt: new Date('2026-10-07T05:00:00Z') }, policy, CALENDAR).remindAt).toBeNull()
    // the escalation skips the holiday of Tuesday 13 Oct: due Monday 12 Oct 17:00 → Wednesday 14 Oct 16:00
    expect(slaTimes({ ...fresh, assignedAt: new Date('2026-10-12T02:00:00Z'), dueAt: new Date('2026-10-12T10:00:00Z'), remindAt: new Date('2026-10-12T06:00:00Z') }, policy, CALENDAR).escalateAt).toEqual(new Date('2026-10-14T09:00:00Z'))
  })
})
