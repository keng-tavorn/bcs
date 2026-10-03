import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { totp } from '@/lib/totp'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { grantStepUp } from '@/server/auth/step-up'
import { decideTask } from '@/server/services/approvals/decide'
import { applyDueChange, proposeOrgChange } from '@/server/services/org-authority'
import { assignHolder, createCostCenter, createDepartment, endHolder, updateCostCenter, updateDepartment } from '@/server/services/org-structure'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// FR-ADM-002 (BR-DOA-17): departments, their names and cost centers change at once; the holders of positions without
// authority change at once; moving a department and the holders of positions the DOA names go through an
// ORG_AUTHORITY_CHANGE; when a holder change takes effect, open tasks follow, and a vacant position is reported.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const CEO_SECRET = 'S'.repeat(32)

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const ceo = await prisma.member.findUniqueOrThrow({ where: { id: org.member.ceo! } })
  const userId = await upsertUserWithPassword({ email: ceo.email, name: ceo.displayNameTh, password: 'ceo-password-123456' })
  await enableTotpWithSecret(userId, CEO_SECRET, [])
  await prisma.member.update({ where: { id: ceo.id }, data: { userId } })
})

const admin = () => org.ctxOf('admin', NOW)
const events = (aggregateId: string) => prisma.event.findMany({ where: { aggregateId }, orderBy: { occurredAt: 'asc' }, select: { type: true, data: true } })

/** The CEO approves the change's task with a step-up, as the governance approver */
async function ceoApproves(changeId: string) {
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: changeId } } } })
  expect(await grantStepUp({ organizationId: org.organizationId, memberId: org.member.ceo!, subjectType: 'ORG_AUTHORITY_CHANGE', subjectId: changeId, code: totp(CEO_SECRET) }, new Date())).toMatchObject({ ok: true })
  expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
}

const job = (at: string) => makeCtx({ organizationId: org.organizationId, actor: { type: 'SYSTEM', job: 'org-authority-apply' }, channel: 'SYSTEM', now: new Date(at) })

describe('[FR-ADM-002/AC1] departments and cost centers change at once; a department moves only through ORG_AUTHORITY_CHANGE', () => {
  it('creates and renames a department and manages a cost center, each with an event', async () => {
    const created = await createDepartment(admin(), { code: 'QA', nameTh: 'ฝ่ายประกันคุณภาพ', parentId: org.department.OPS!, kind: 'DEPARTMENT' }, key())
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    const departmentId = created.data.departmentId
    expect(await updateDepartment(admin(), { departmentId, nameTh: 'ฝ่ายควบคุมคุณภาพ', nameEn: 'Quality Control' }, key())).toMatchObject({ ok: true })
    expect(await prisma.department.findUniqueOrThrow({ where: { id: departmentId } })).toMatchObject({ code: 'QA', nameTh: 'ฝ่ายควบคุมคุณภาพ', parentId: org.department.OPS })
    expect((await events(departmentId)).map((e) => [e.type, e.data])).toEqual([
      ['department.created', { code: 'QA', parentId: org.department.OPS, via: 'ADMIN' }],
      ['department.updated', { code: 'QA', changed: ['nameTh', 'nameEn'] }],
    ])

    const cc = await createCostCenter(admin(), { code: 'CC-QA', nameTh: 'ศูนย์ต้นทุนคุณภาพ', departmentId }, key())
    if (!cc.ok) throw new Error(JSON.stringify(cc.error))
    expect(await updateCostCenter(admin(), { costCenterId: cc.data.costCenterId, nameTh: 'ศูนย์ต้นทุน QC', active: false }, key())).toMatchObject({ ok: true })
    expect(await prisma.costCenter.findUniqueOrThrow({ where: { id: cc.data.costCenterId } })).toMatchObject({ nameTh: 'ศูนย์ต้นทุน QC', active: false })
    expect((await events(cc.data.costCenterId)).map((e) => e.type)).toEqual(['cost_center.created', 'cost_center.updated'])
    expect(await createCostCenter(admin(), { code: 'CC-QA', nameTh: 'ซ้ำ', departmentId }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CODE_EXISTS' } } })
  })

  it('refuses a direct move to another parent and points to the authority change', async () => {
    expect(await updateDepartment(admin(), { departmentId: org.department.IT!, parentId: org.department.OPS! }, key())).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN', details: { reason: 'USE_ORG_AUTHORITY_CHANGE', kind: 'DEPARTMENT_REPARENT' } },
    })
    expect((await prisma.department.findUniqueOrThrow({ where: { id: org.department.IT! } })).parentId).toBe(org.department.SUP)
  })

  it('refuses a move that would make a cycle, and a second move while one waits', async () => {
    const move = (departmentId: string, newParentId: string) =>
      proposeOrgChange(admin(), { kind: 'DEPARTMENT_REPARENT', payload: { departmentId, newParentId }, effectiveFrom: '2026-10-20T01:00:00Z', reason: 'ปรับโครงสร้าง' }, key())
    // OPS under its own child CON, and the root under anything
    expect(await move(org.department.OPS!, org.department.CON!)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'CYCLE' } } })
    expect(await move(org.department.HQ!, org.department.IT!)).toMatchObject({ ok: false, error: { details: { reason: 'CYCLE' } } })
    expect(await move(org.department.IT!, org.department.SUP!)).toMatchObject({ ok: false, error: { details: { reason: 'NO_CHANGE' } } })
    const first = await move(org.department.IT!, org.department.OPS!)
    expect(first).toMatchObject({ ok: true })
    expect(await move(org.department.FIN!, org.department.OPS!)).toMatchObject({ ok: false, error: { details: { reason: 'REPARENT_WAITING' } } })
    // At the effective time the move applies and the tree changes
    if (!first.ok) return
    await ceoApproves(first.data.changeId)
    expect(await applyDueChange(job('2026-10-20T01:00:00Z'), { changeId: first.data.changeId }, key())).toMatchObject({ ok: true })
    expect((await prisma.department.findUniqueOrThrow({ where: { id: org.department.IT! } })).parentId).toBe(org.department.OPS)
  })

  it('only an organization admin edits the structure', async () => {
    expect(await createDepartment(org.ctxOf('dm_it', NOW), { code: 'XX', nameTh: 'ไม่ควรสร้าง', parentId: org.department.HQ!, kind: 'DEPARTMENT' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.department.count({ where: { organizationId: org.organizationId, code: 'XX' } })).toBe(0)
  })
})

describe('[FR-ADM-002/AC2] holders of positions without authority change at once; positions the DOA names do not', () => {
  it('assigns the holder of a position no DOA names at once; the slot keeps one current holder', async () => {
    // PROC_MGR is held by dm_proc and named by no DOA version
    expect(await assignHolder(admin(), { positionCode: 'PROC_MGR', departmentId: org.department.HQ!, memberId: org.member.proc_officer! }, key())).toMatchObject({ ok: true })
    const current = await prisma.positionAssignment.findMany({ where: { organizationId: org.organizationId, position: { code: 'PROC_MGR' }, validTo: null } })
    expect(current.map((h) => h.memberId)).toEqual([org.member.proc_officer])
    const types = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: { in: ['position.assigned', 'position.unassigned'] }, actorMemberId: org.member.admin }, select: { type: true, data: true } })
    expect(types.map((e) => e.type).sort()).toEqual(['position.assigned', 'position.unassigned'])
    expect(types.find((e) => e.type === 'position.assigned')!.data).toMatchObject({ positionCode: 'PROC_MGR', memberId: org.member.proc_officer, via: 'ADMIN' })
    // An organization-wide position sits in the root department
    expect(await assignHolder(admin(), { positionCode: 'PROC_MGR', departmentId: org.department.IT!, memberId: org.member.dm_proc! }, key())).toMatchObject({ ok: false, error: { details: { reason: 'ORG_POSITION' } } })
  })

  it('refuses positions the DOA in effect names, both to assign and to end', async () => {
    expect(await assignHolder(admin(), { positionCode: 'DM', departmentId: org.department.IT!, memberId: org.member.fin_officer! }, key())).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN', details: { reason: 'USE_ORG_AUTHORITY_CHANGE', kind: 'POSITION_ASSIGN' } },
    })
    expect(await endHolder(admin(), { positionCode: 'CEO', departmentId: org.department.HQ! }, key())).toMatchObject({ ok: false, error: { details: { reason: 'USE_ORG_AUTHORITY_CHANGE', kind: 'POSITION_END' } } })
    expect(await prisma.positionAssignment.count({ where: { departmentId: org.department.IT!, position: { code: 'DM' }, validTo: null, memberId: org.member.dm_it } })).toBe(1)
  })

  it('refuses a position that open approval tasks came from, though no DOA in effect names it', async () => {
    const position = await prisma.position.create({ data: { organizationId: org.organizationId, code: 'SITE_LEAD', nameTh: 'หัวหน้าหน้างาน', scope: 'DEPARTMENT' } })
    await prisma.positionAssignment.create({ data: { organizationId: org.organizationId, positionId: position.id, departmentId: org.department.CON!, memberId: org.member.asst_con!, validFrom: NOW } })
    const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ถุงมือ', priceIncludesVat: true, lines: [{ description: 'ถุงมือ', quantity: '1', uom: 'กล่อง', unitPrice: '300.00' }] }, key())
    if (!draft.ok) throw new Error('draft failed')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
    // A task an earlier DOA version gave the SITE_LEAD of CON (BR-DOA-13 keeps it on that route)
    await prisma.approvalTask.update({ where: { id: task.id }, data: { resolvedFrom: 'POSITION:SITE_LEAD@CON', assigneeMemberId: org.member.asst_con! } })
    expect(await assignHolder(admin(), { positionCode: 'SITE_LEAD', departmentId: org.department.CON!, memberId: org.member.receiver_con! }, key())).toMatchObject({ ok: false, error: { details: { reason: 'USE_ORG_AUTHORITY_CHANGE' } } })
  })
})

describe('[FR-ADM-002/AC3] when a holder change takes effect, open tasks follow the new holder; a vacant position is reported', () => {
  it('moves the open task of the DM of FIN to the replacement at the effective time', async () => {
    const draft = await createDraft(org.ctxOf('fin_officer', NOW), { requestTypeCode: 'BUY_GOODS', title: 'แฟ้ม', priceIncludesVat: true, lines: [{ description: 'แฟ้ม', quantity: '1', uom: 'แพ็ก', unitPrice: '800.00' }] }, key())
    if (!draft.ok) throw new Error('draft failed')
    await submitRequest(org.ctxOf('fin_officer', NOW), { requestId: draft.data.requestId }, key())
    const waiting = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
    expect(waiting.assigneeMemberId).toBe(org.member.dm_fin)

    const effective = '2026-10-07T02:00:00Z'
    const proposed = await proposeOrgChange(admin(), { kind: 'POSITION_END', payload: { positionCode: 'DM', departmentId: org.department.FIN!, replacementMemberId: org.member.auditor! }, effectiveFrom: effective, reason: 'ย้ายไปบริษัทในเครือ' }, key())
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error))
    await ceoApproves(proposed.data.changeId)
    expect(await applyDueChange(job(effective), { changeId: proposed.data.changeId }, key())).toMatchObject({ ok: true })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: 'REASSIGNED' })
    expect(await prisma.approvalTask.findFirstOrThrow({ where: { reassignedFromTaskId: waiting.id } })).toMatchObject({ status: 'OPEN', assigneeMemberId: org.member.auditor, resolvedFrom: 'POSITION:DM@FIN' })
  })

  it('ending the DM of IT without a replacement needs the vacancy acknowledged, and the admins are told when it applies', async () => {
    const end = (acknowledgedWarnings: string[] = []) =>
      proposeOrgChange(admin(), { kind: 'POSITION_END', payload: { positionCode: 'DM', departmentId: org.department.IT! }, effectiveFrom: '2026-10-08T02:00:00Z', reason: 'ลาออก', acknowledgedWarnings }, key())
    const silent = await end()
    expect(silent).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'WARNINGS_NOT_ACKNOWLEDGED' } } })
    const warnings = silent.ok ? [] : ((silent.error.details as { warnings: string[] }).warnings ?? [])
    expect(warnings).toEqual(['POSITION_VACANT:DM@IT'])
    const proposed = await end(warnings)
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error))
    await ceoApproves(proposed.data.changeId)
    expect(await applyDueChange(job('2026-10-08T02:00:00Z'), { changeId: proposed.data.changeId }, key())).toMatchObject({ ok: true })
    expect(await prisma.positionAssignment.count({ where: { departmentId: org.department.IT!, position: { code: 'DM' }, validTo: null } })).toBe(0)
    const notice = await prisma.notification.findFirstOrThrow({ where: { recipientMemberId: org.member.admin, templateKey: 'position.vacant', subjectId: proposed.data.changeId } })
    expect(notice.data).toMatchObject({ positionCode: 'DM', departmentId: org.department.IT, openTasks: 0 })
  })
})
