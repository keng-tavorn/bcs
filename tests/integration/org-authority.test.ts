import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { grantStepUp } from '@/server/auth/step-up'
import { decideTask } from '@/server/services/approvals/decide'
import { importDoaDraft, submitDoaVersion } from '@/server/services/doa'
import { resetMemberTwoFactor } from '@/server/services/members'
import { applyDueChange, proposeOrgChange } from '@/server/services/org-authority'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { pinStepUp, seedTestPins, TEST_PIN } from '../support/pin'

// S2-16 (FR-DOA-010, FR-DOA-002 AC2, BR-DOA-15, BR-SOD-08): authority changes and DOA versions are approved by the
// approver of their governance rule (CEO in the fixtures) with a step-up every time: the PIN (FR-AUTH-005 AC2, S5-05).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const CEO_SECRET = 'C'.repeat(32)

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  // The CEO signs in with a password and an authenticator, and decides with the transaction PIN
  const ceo = await prisma.member.findUniqueOrThrow({ where: { id: org.member.ceo! } })
  const userId = await upsertUserWithPassword({ email: ceo.email, name: ceo.displayNameTh, password: 'ceo-password-123456' })
  await enableTotpWithSecret(userId, CEO_SECRET, [])
  await prisma.member.update({ where: { id: ceo.id }, data: { userId } })
  await seedTestPins(org.organizationId)
})

/** An organization of its own, with admin and admin2 as ORG_ADMIN and a CEO who decides with the PIN */
async function orgWithCeo(): Promise<DoaOrg> {
  const solo = await createDoaOrg()
  for (const code of ['admin', 'admin2']) await prisma.roleAssignment.create({ data: { organizationId: solo.organizationId, memberId: solo.member[code]!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const ceo = await prisma.member.findUniqueOrThrow({ where: { id: solo.member.ceo! } })
  const userId = await upsertUserWithPassword({ email: ceo.email, name: ceo.displayNameTh, password: 'ceo-password-123456' })
  await enableTotpWithSecret(userId, CEO_SECRET, [])
  await prisma.member.update({ where: { id: ceo.id }, data: { userId } })
  await seedTestPins(solo.organizationId)
  return solo
}

/** Version 2 of the fixture under its own number, edited */
const FIXTURE = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')
const version2 = (versionNo: number, edit: (text: string) => string = (t) => t) =>
  edit(`versions:\n${FIXTURE.slice(FIXTURE.indexOf('  - code: DOA-DEMO\n    version: 2')).replace('version: 2', `version: ${versionNo}`)}`)

const assign = (positionCode: string, department: string, member: string, effectiveFrom = NOW.toISOString()) =>
  proposeOrgChange(
    org.ctxOf('admin', NOW),
    { kind: 'POSITION_ASSIGN', payload: { positionCode, departmentId: org.department[department]!, memberId: org.member[member]! }, effectiveFrom, reason: 'แต่งตั้งตามคำสั่งบริษัท' },
    key(),
  )

async function taskOf(subjectId: string) {
  return prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId } } } })
}

async function ceoStepUp(subjectType: string, subjectId: string, pin = TEST_PIN) {
  return grantStepUp({ organizationId: org.organizationId, memberId: org.member.ceo!, subjectType, subjectId, method: 'PIN', pin }, new Date(), { sender: null })
}

describe('[FR-DOA-010/AC1] ORG_ADMIN proposes the five kinds with an effective time that is not in the past', () => {
  it('accepts each kind and records the impact before it is decided', async () => {
    const results = [
      await assign('VP', 'OPS', 'dm_proc', '2026-10-20T01:00:00Z'),
      await proposeOrgChange(org.ctxOf('admin', NOW), { kind: 'POSITION_END', payload: { positionCode: 'DM', departmentId: org.department.IT!, replacementMemberId: org.member.fin_officer! }, effectiveFrom: '2026-10-20T01:00:00Z', reason: 'เกษียณ' }, key()),
      await proposeOrgChange(org.ctxOf('admin', NOW), { kind: 'DEPARTMENT_REPARENT', payload: { departmentId: org.department.IT!, newParentId: org.department.OPS! }, effectiveFrom: '2026-10-20T01:00:00Z', reason: 'ปรับโครงสร้าง' }, key()),
      await proposeOrgChange(
        org.ctxOf('admin', NOW),
        { kind: 'DELEGATION_ON_BEHALF', payload: { delegatorMemberId: org.member.dm_fin!, delegateMemberId: org.member.fin_officer!, startsAt: '2026-10-21T01:00:00Z', endsAt: '2026-10-22T01:00:00Z' }, effectiveFrom: '2026-10-20T01:00:00Z', reason: 'ผู้มอบป่วยกะทันหัน' },
        key(),
      ),
      await proposeOrgChange(org.ctxOf('admin', NOW), { kind: 'IDENTITY_RESET', payload: { memberId: org.member.dm_con! }, reason: 'ทำโทรศัพท์หาย' }, key()),
    ]
    for (const r of results) expect(r).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.ceo } })
    const first = results[0]!
    if (!first.ok) return
    const change = await prisma.orgAuthorityChange.findUniqueOrThrow({ where: { id: first.data.changeId } })
    expect(change).toMatchObject({ status: 'PENDING_APPROVAL', impactSummary: { gains: [org.member.dm_proc], loses: [org.member.vp_ops] } })
    // GC-DOA-27: the route follows rule ORG-CHG-01
    expect(await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: first.data.changeId } })).toMatchObject({ ruleCode: 'ORG-CHG-01' })
  })

  it('refuses an effective time in the past', async () => {
    expect(await assign('VP', 'OPS', 'dm_proc', '2026-10-01T00:00:00Z')).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'EFFECTIVE_IN_PAST' } } })
  })

  it('refuses a proposal that benefits the proposer (BR-SOD-08)', async () => {
    expect(await assign('VP', 'SUP', 'admin')).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION' } })
  })
})

describe('[FR-DOA-010/AC2] the governance approver decides with a step-up every time', () => {
  it('needs a fresh, correct PIN step-up for that change; the step-up is used once', async () => {
    const proposed = await assign('VP', 'SUP', 'dm_fin', '2026-10-25T01:00:00Z')
    if (!proposed.ok) throw new Error('propose failed')
    const task = await taskOf(proposed.data.changeId)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    expect(await ceoStepUp('ORG_AUTHORITY_CHANGE', proposed.data.changeId, '000000')).toMatchObject({ ok: false, reason: 'INVALID_CODE' })
    // A step-up for another document does not count
    await ceoStepUp('ORG_AUTHORITY_CHANGE', randomUUID())
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    expect(await ceoStepUp('ORG_AUTHORITY_CHANGE', proposed.data.changeId)).toMatchObject({ ok: true })
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'SCHEDULED' } })
    const decided = await prisma.event.findFirstOrThrow({ where: { aggregateId: task.id, type: 'approval_task.decided' } })
    expect((decided.data as { stepUpGrantId?: string }).stepUpGrantId).toEqual(expect.any(String))
  })

  it('a policy decision is made on the web or LIFF only, never from a chat button', async () => {
    const proposed = await assign('VP', 'SUP', 'dm_it', '2026-10-26T01:00:00Z')
    if (!proposed.ok) throw new Error('propose failed')
    const task = await taskOf(proposed.data.changeId)
    await ceoStepUp('ORG_AUTHORITY_CHANGE', proposed.data.changeId)
    expect(await decideTask(org.ctxOf('ceo', NOW, 'LINE_CHAT'), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'CHANNEL' } } })
  })
})

describe('[FR-DOA-010/AC3] a change that leaves nobody to approve policy changes is refused', () => {
  it('refuses ending the CEO without a replacement, and accepts it with one in the same request', async () => {
    const end = (replacementMemberId?: string) =>
      proposeOrgChange(org.ctxOf('admin', NOW), { kind: 'POSITION_END', payload: { positionCode: 'CEO', departmentId: org.department.HQ!, ...(replacementMemberId ? { replacementMemberId } : {}) }, effectiveFrom: '2026-10-28T01:00:00Z', reason: 'ลาออก' }, key())
    expect(await end()).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'GOVERNANCE_UNRESOLVABLE', rules: ['DOA-CHG-01', 'ORG-CHG-01'] } } })
    expect(await end(org.member.coo!)).toMatchObject({ ok: true })
  })
})

describe('[FR-DOA-010/AC4] at the effective time the change applies, open tasks follow the new holder and people are told', () => {
  it('appoints a new VP of OPS: the old holder ends, the open task moves, gainers, losers and admins are told', async () => {
    // A request waiting for the VP of OPS
    const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'เหล็กเส้น', priceIncludesVat: true, lines: [{ description: 'เหล็ก', quantity: '1', uom: 'ชุด', unitPrice: '45000.00' }] }, key())
    if (!draft.ok) throw new Error('draft failed')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
    const waiting = await taskOf(draft.data.requestId)
    expect(waiting.assigneeMemberId).toBe(org.member.vp_ops)

    const effective = '2026-10-06T02:00:00Z'
    const proposed = await assign('VP', 'OPS', 'dm_proc', effective)
    if (!proposed.ok) throw new Error('propose failed')
    expect((await prisma.orgAuthorityChange.findUniqueOrThrow({ where: { id: proposed.data.changeId } })).impactSummary).toMatchObject({ openTasks: 1 })
    const task = await taskOf(proposed.data.changeId)
    await ceoStepUp('ORG_AUTHORITY_CHANGE', proposed.data.changeId)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'SCHEDULED' } })
    // Not due yet
    const job = (at: string) => makeCtx({ organizationId: org.organizationId, actor: { type: 'SYSTEM', job: 'org-authority-apply' }, channel: 'SYSTEM', now: new Date(at) })
    expect(await applyDueChange(job('2026-10-06T01:00:00Z'), { changeId: proposed.data.changeId }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NOT_DUE' } } })
    expect(await applyDueChange(job(effective), { changeId: proposed.data.changeId }, key())).toMatchObject({ ok: true })

    expect(await prisma.orgAuthorityChange.findUniqueOrThrow({ where: { id: proposed.data.changeId } })).toMatchObject({ status: 'APPLIED' })
    const holders = await prisma.positionAssignment.findMany({ where: { organizationId: org.organizationId, departmentId: org.department.OPS!, position: { code: 'VP' } }, orderBy: { validFrom: 'asc' } })
    expect(holders.map((h) => [h.memberId, h.validTo?.toISOString() ?? null])).toEqual([
      [org.member.vp_ops, effective.replace('Z', '.000Z')],
      [org.member.dm_proc, null],
    ])
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: 'REASSIGNED' })
    const moved = await taskOf(draft.data.requestId)
    expect(moved).toMatchObject({ assigneeMemberId: org.member.dm_proc, reassignedFromTaskId: waiting.id })
    for (const who of ['vp_ops', 'dm_proc', 'admin']) {
      expect(await prisma.notification.count({ where: { recipientMemberId: org.member[who], templateKey: 'doa.authority_changed', subjectId: proposed.data.changeId } }), who).toBe(1)
    }
  })
})

describe('[FR-DOA-002/AC2] a DOA version is approved by the DOA_CHANGE approver with a step-up; the submitter never approves it', () => {
  it('publishes version 2 when the CEO approves with a step-up', async () => {
    const imported = await importDoaDraft(org.ctxOf('admin', NOW), { yaml: version2(20) }, key())
    if (!imported.ok) throw new Error('import failed')
    const versionId = imported.data.versionIds[0]!
    const submitted = await submitDoaVersion(org.ctxOf('admin', NOW), { versionId, boundaryTableConfirmed: true }, key())
    expect(submitted).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.ceo } })
    const task = await taskOf(versionId)
    await ceoStepUp('DOA_VERSION', versionId)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE', boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PUBLISHED' } })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: versionId } })).toMatchObject({ status: 'PUBLISHED', approvedById: org.member.ceo })
  })
})

describe('[FR-AUTH-002/AC3] a member the DOA relies on is reset only through an IDENTITY_RESET change', () => {
  const activate = async (code: string) => {
    const m = await prisma.member.findUniqueOrThrow({ where: { id: org.member[code]! } })
    const userId = await upsertUserWithPassword({ email: m.email, name: m.displayNameTh, password: 'member-password-123456' })
    await enableTotpWithSecret(userId, 'M'.repeat(32), [])
    await prisma.member.update({ where: { id: m.id }, data: { userId } })
    return userId
  }
  const reset = (code: string) => resetMemberTwoFactor(org.ctxOf('admin', NOW), { memberId: org.member[code]!, reason: 'ทำโทรศัพท์หาย' }, key())

  it('refuses a direct reset of a DOA position holder and of a member with an open approval task', async () => {
    const holder = await activate('dm_it')
    expect(await reset('dm_it')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'USE_ORG_AUTHORITY_CHANGE', kind: 'IDENTITY_RESET' } } })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: holder } })).twoFactorEnabled).toBe(true)

    // fin_officer holds no position the DOA names, but holds an open task (as a delegate would)
    const officer = await activate('fin_officer')
    const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'กระดาษ', priceIncludesVat: true, lines: [{ description: 'กระดาษ', quantity: '1', uom: 'รีม', unitPrice: '500.00' }] }, key())
    if (!draft.ok) throw new Error('draft failed')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
    const task = await taskOf(draft.data.requestId)
    const open = await prisma.approvalTask.create({
      data: { organizationId: org.organizationId, stepId: task.stepId, assigneeMemberId: org.member.fin_officer!, principalMemberId: task.assigneeMemberId, resolvedFrom: task.resolvedFrom, status: 'OPEN', assignedAt: NOW },
    })
    expect(await reset('fin_officer')).toMatchObject({ ok: false, error: { details: { reason: 'USE_ORG_AUTHORITY_CHANGE', kind: 'IDENTITY_RESET' } } })
    await prisma.approvalTask.update({ where: { id: open.id }, data: { status: 'CANCELLED', decidedAt: NOW } })
    expect(await reset('fin_officer')).toMatchObject({ ok: true })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: officer } })).twoFactorEnabled).toBe(false)
  })
})

describe('[GC-SOD-06] [GC-SOD-08] [GC-SOD-09] the proposer never gains from their own proposal (BR-SOD-08)', () => {
  const blocked = async (proposer: string) => prisma.event.count({ where: { organizationId: org.organizationId, type: 'security.sod_blocked', aggregateId: proposer } })

  it('GC-SOD-06: ORG_ADMIN proposing themselves as DM of IT is refused and recorded', async () => {
    const before = await blocked(org.member.admin!)
    expect(await assign('DM', 'IT', 'admin')).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-08' } } })
    expect(await blocked(org.member.admin!)).toBe(before + 1)
  })

  it('GC-SOD-08: ORG_ADMIN proposing themselves to act for the CEO is refused', async () => {
    const r = await proposeOrgChange(
      org.ctxOf('admin', NOW),
      { kind: 'DELEGATION_ON_BEHALF', payload: { delegatorMemberId: org.member.ceo!, delegateMemberId: org.member.admin!, startsAt: '2026-10-21T01:00:00Z', endsAt: '2026-10-22T01:00:00Z' }, effectiveFrom: '2026-10-20T01:00:00Z', reason: 'CEO เดินทาง' },
      key(),
    )
    expect(r).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-08' } } })
  })

  it('GC-SOD-09: ORG_ADMIN proposing someone else as DM of IT goes to the governance approver', async () => {
    expect(await assign('DM', 'IT', 'dm_it', '2026-10-27T01:00:00Z')).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.ceo } })
  })
})

describe('[GC-SOD-07] the proposer never approves their own change, even when the task comes to them', () => {
  it('a proposer who becomes the CEO is refused when deciding the change they proposed', async () => {
    const solo = await orgWithCeo()

    // admin proposes a change; it waits for the CEO
    const mine = await proposeOrgChange(solo.ctxOf('admin', NOW), { kind: 'POSITION_ASSIGN', payload: { positionCode: 'VP', departmentId: solo.department.SUP!, memberId: solo.member.dm_fin! }, effectiveFrom: '2026-10-25T01:00:00Z', reason: 'แต่งตั้ง VP' }, key())
    if (!mine.ok) throw new Error('propose failed')
    // admin2 proposes admin as the new CEO, at once; the CEO approves and the open CEO tasks move to admin
    const promote = await proposeOrgChange(solo.ctxOf('admin2', NOW), { kind: 'POSITION_ASSIGN', payload: { positionCode: 'CEO', departmentId: solo.department.HQ!, memberId: solo.member.admin! }, effectiveFrom: NOW.toISOString(), reason: 'แต่งตั้ง CEO' }, key())
    if (!promote.ok) throw new Error(JSON.stringify(promote.error))
    const promoteTask = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: promote.data.changeId } } } })
    await pinStepUp(solo.organizationId, solo.member.ceo!, 'ORG_AUTHORITY_CHANGE', promote.data.changeId)
    expect(await decideTask(solo.ctxOf('ceo', NOW), { taskId: promoteTask.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPLIED' } })
    const moved = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: mine.data.changeId } } } })
    expect(moved.assigneeMemberId).toBe(solo.member.admin)

    expect(await decideTask(solo.ctxOf('admin', NOW), { taskId: moved.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-08' } } })
    expect(await prisma.event.count({ where: { organizationId: solo.organizationId, type: 'security.sod_blocked', aggregateId: mine.data.changeId } })).toBe(1)
    expect(await prisma.orgAuthorityChange.findUniqueOrThrow({ where: { id: mine.data.changeId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
  })
})

describe('[FR-DOA-007/AC2] every separation-of-duties violation is blocked and recorded with its rule', () => {
  it('records BR-SOD-01, BR-SOD-06 and BR-SOD-08 as security.sod_blocked with the rule code', async () => {
    const solo = await orgWithCeo()
    const recorded = async () => (await prisma.event.findMany({ where: { organizationId: solo.organizationId, type: 'security.sod_blocked' }, orderBy: { seq: 'asc' }, select: { data: true } })).map((e) => (e.data as { rule: string }).rule)

    // BR-SOD-01: a request's task that points at its requester
    const draft = await createDraft(solo.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ทราย', priceIncludesVat: true, lines: [{ description: 'ทราย', quantity: '1', uom: 'คิว', unitPrice: '9000.00' }] }, key())
    if (!draft.ok) throw new Error('draft failed')
    await submitRequest(solo.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
    const requestTask = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
    await prisma.approvalTask.update({ where: { id: requestTask.id }, data: { assigneeMemberId: solo.member.req_con! } })
    expect(await decideTask(solo.ctxOf('req_con', NOW), { taskId: requestTask.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-01' } } })

    // BR-SOD-06: a DOA version's task that points at the admin who submitted it
    const imported = await importDoaDraft(solo.ctxOf('admin', NOW), { yaml: version2(21) }, key())
    if (!imported.ok) throw new Error('import failed')
    const versionId = imported.data.versionIds[0]!
    await submitDoaVersion(solo.ctxOf('admin', NOW), { versionId, boundaryTableConfirmed: true }, key())
    const versionTask = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: versionId } } } })
    await prisma.approvalTask.update({ where: { id: versionTask.id }, data: { assigneeMemberId: solo.member.admin! } })
    expect(await decideTask(solo.ctxOf('admin', NOW), { taskId: versionTask.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-06' } } })

    // BR-SOD-08: a proposal that makes the proposer a VP
    const own = await proposeOrgChange(solo.ctxOf('admin2', NOW), { kind: 'POSITION_ASSIGN', payload: { positionCode: 'VP', departmentId: solo.department.SUP!, memberId: solo.member.admin2! }, effectiveFrom: '2026-10-25T01:00:00Z', reason: 'แต่งตั้ง' }, key())
    expect(own).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-08' } } })

    expect(await recorded()).toEqual(['BR-SOD-01', 'BR-SOD-06', 'BR-SOD-08'])
    // Each was blocked: nothing moved
    expect(await prisma.request.findUniqueOrThrow({ where: { id: draft.data.requestId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: versionId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
  })
})

describe('[FR-DOA-007/AC3] separation of duties is relaxed only by a new DOA version, approved by someone else', () => {
  it('a version that lets approvers receive goods goes to the CEO, takes a step-up, and leaves its history', async () => {
    const solo = await orgWithCeo()
    const relaxed = version2(22, (t) => t.replace('sodPolicy: { approverMayReceive: false, requesterMayReceive: true }', 'sodPolicy: { approverMayReceive: true, requesterMayReceive: true }'))
    const imported = await importDoaDraft(solo.ctxOf('admin', NOW), { yaml: relaxed }, key())
    if (!imported.ok) throw new Error('import failed')
    const versionId = imported.data.versionIds[0]!
    expect(await submitDoaVersion(solo.ctxOf('admin', NOW), { versionId, boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true, data: { assigneeMemberId: solo.member.ceo } })
    // The version in effect keeps its policy until the new one is approved and starts
    const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: solo.organizationId, versionNo: 1 } })
    expect(v1.sodPolicy).toMatchObject({ approverMayReceive: false })

    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: versionId } } } })
    await pinStepUp(solo.organizationId, solo.member.ceo!, 'DOA_VERSION', versionId)
    expect(await decideTask(solo.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE', boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PUBLISHED' } })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: versionId } })).toMatchObject({ status: 'PUBLISHED', submittedById: solo.member.admin, approvedById: solo.member.ceo, sodPolicy: { approverMayReceive: true } })
    // The history report (FR-DOA-011) reads these: who drafted, submitted and approved, with the step-up
    const history = await prisma.event.findMany({ where: { organizationId: solo.organizationId, aggregateId: { in: [versionId, task.id] } }, orderBy: { seq: 'asc' }, select: { type: true, actorMemberId: true, data: true } })
    expect(history.map((e) => [e.type, e.actorMemberId])).toEqual([
      ['doa_version.drafted', solo.member.admin],
      ['doa_version.submitted', solo.member.admin],
      ['approval_task.assigned', solo.member.admin],
      ['approval_task.decided', solo.member.ceo],
      ['doa_version.published', solo.member.ceo],
    ])
    expect(history.find((e) => e.type === 'approval_task.decided')!.data).toMatchObject({ stepUpGrantId: expect.any(String) })
  })

  it('refuses a version that would start at or before one approved for later (it must be withdrawn first)', async () => {
    const solo = await orgWithCeo()
    const publish = async (versionNo: number, edit: (t: string) => string = (t) => t) => {
      const imported = await importDoaDraft(solo.ctxOf('admin', NOW), { yaml: version2(versionNo, edit) }, key())
      if (!imported.ok) throw new Error('import failed')
      const versionId = imported.data.versionIds[0]!
      const submitted = await submitDoaVersion(solo.ctxOf('admin', NOW), { versionId, boundaryTableConfirmed: true }, key())
      return { versionId, submitted }
    }
    // Version 23 for 1 Nov waits for the CEO while version 24 for 20 Oct is submitted too
    const first = await publish(23)
    const second = await publish(24, (t) => t.replace('"2026-11-01T00:00:00+07:00"', '"2026-10-20T00:00:00+07:00"'))
    expect(second.submitted).toMatchObject({ ok: true })
    const approve = async (versionId: string) => {
      const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: versionId } } } })
      await pinStepUp(solo.organizationId, solo.member.ceo!, 'DOA_VERSION', versionId)
      return decideTask(solo.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE', boundaryTableConfirmed: true }, key())
    }
    expect(await approve(first.versionId)).toMatchObject({ ok: true })
    // 20 Oct is before the 1 Nov version that is now approved: the approval is refused, nothing changes
    expect(await approve(second.versionId)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'LATER_VERSION_SCHEDULED', versionNo: 23 } } })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: second.versionId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
    // And a new one for the same day is refused at submit
    const third = await publish(25)
    expect(third.submitted).toMatchObject({ ok: false, error: { details: { reason: 'LATER_VERSION_SCHEDULED' } } })
  })
})
