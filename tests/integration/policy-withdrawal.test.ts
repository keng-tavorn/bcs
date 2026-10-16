import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { decideTask } from '@/server/services/approvals/decide'
import { activateDoaVersion } from '@/server/services/doa'
import { requestWithdrawal } from '@/server/services/policy-withdrawal'
import { activateWorkflowVersion } from '@/server/services/workflow'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { pinStepUp } from '../support/pin'

// S6-07 (FR-DOA-104 · BR-DOA-18 · FR-WF-103): withdrawing a version approved but not yet in effect, against Postgres, by
// one set of commands for DOA and workflow versions — asked by ORG_ADMIN with a reason, decided by the approver of
// DOA_CHANGE (the CEO of the §7.4 fixture) with the PIN, never by who asked; approved, the version is WITHDRAWN and the one
// before it runs on; rejected, it stays; a decision or a request after the effective time is refused, and a request
// still waiting then is cancelled by the activation job.

const NOW = new Date('2026-10-06T03:00:00Z')
const LATER = new Date('2026-10-06T04:00:00Z')
const NOV_1 = new Date('2026-10-31T17:00:00Z')
const DEC_1 = new Date('2026-11-30T17:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg({ fixtures: { org: 'fixtures/org-s6.yaml', versions: 'fixtures/doa-versions.yaml' } })
  for (const [code, role] of [
    ['admin', 'ORG_ADMIN'],
    ['admin2', 'ORG_ADMIN'],
    ['auditor', 'AUDITOR'],
  ] as const) {
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member[code]!, role, grantedAt: NOW } })
  }
})

/** A DOA version published by admin2 for `from`, a copy of version 1's rules; the version before it ends there */
async function publishedDoa(versionNo: number, from: Date) {
  const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 }, include: { rules: true } })
  const { id: _id, versionNo: _no, rules, createdAt: _c, updatedAt: _u, effectiveFrom: _f, effectiveTo: _t, ...rest } = v1
  await prisma.doaVersion.updateMany({ where: { organizationId: org.organizationId, status: 'PUBLISHED', effectiveTo: null }, data: { effectiveTo: from } })
  const v = await prisma.doaVersion.create({ data: { ...rest, escalationPolicy: rest.escalationPolicy as object, sodPolicy: rest.sodPolicy as object, versionNo, effectiveFrom: from, effectiveTo: null, status: 'PUBLISHED', submittedById: org.member.admin2!, publishedAt: NOW } as never })
  for (const r of rules) {
    await prisma.doaRule.create({ data: { organizationId: org.organizationId, doaVersionId: v.id, code: r.code, documentType: r.documentType, priority: r.priority, when: r.when as object, steps: r.steps as object } })
  }
  return v.id
}
const doaRow = (id: string) => prisma.doaVersion.findUniqueOrThrow({ where: { id } })
const openTask = (subjectId: string) => prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId, status: 'ACTIVE' } } } })
const ceoDecides = (taskId: string, decision: 'APPROVE' | 'REJECT', at = LATER) => decideTask(org.ctxOf('ceo', at), { taskId, decision, ...(decision === 'REJECT' ? { reason: 'ยังต้องใช้ฉบับนี้' } : {}) }, key())

describe('[FR-DOA-104/AC1] [FR-DOA-104/AC2] [FR-DOA-104/AC3] a DOA version not yet in effect is withdrawn on a DOA_CHANGE route of its own', () => {
  let v2: string
  it('asked with a reason it waits for the CEO; who asked cannot decide; approved with the PIN it is WITHDRAWN and version 1 runs on', async () => {
    v2 = await publishedDoa(2, NOV_1)
    const asked = ok(await requestWithdrawal(org.ctxOf('admin', NOW), 'DOA_VERSION', { versionId: v2, reason: 'พบช่วงวงเงินผิด' }, key()))
    expect(asked.assigneeMemberId).toBe(org.member.ceo)
    expect(await doaRow(v2)).toMatchObject({ status: 'PUBLISHED', withdrawalRequestedById: org.member.admin, withdrawalReason: 'พบช่วงวงเงินผิด' })
    expect(await prisma.approvalRoute.findUniqueOrThrow({ where: { id: asked.routeId } })).toMatchObject({ subjectType: 'DOA_VERSION', ruleCode: 'DOA-CHG-01', routeNo: 1 })
    // Asked twice, or by a member who may not send a version: refused
    expect(await requestWithdrawal(org.ctxOf('admin2', NOW), 'DOA_VERSION', { versionId: v2, reason: 'ซ้ำ' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'WITHDRAWAL_PENDING' } } })
    expect(await requestWithdrawal(org.ctxOf('req_con', NOW), 'DOA_VERSION', { versionId: v2, reason: 'ไม่มีสิทธิ์' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })

    // Who asked never decides it (BR-SOD-06): the task moved to them is refused
    const task = await openTask(v2)
    await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: org.member.admin! } })
    await pinStepUp(org.organizationId, org.member.admin!, 'DOA_VERSION', v2)
    expect(await decideTask(org.ctxOf('admin', LATER), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION' } })
    await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: org.member.ceo! } })

    expect(await ceoDecides(task.id, 'APPROVE')).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    await pinStepUp(org.organizationId, org.member.ceo!, 'DOA_VERSION', v2)
    expect(ok(await ceoDecides(task.id, 'APPROVE'))).toMatchObject({ documentStatus: 'WITHDRAWN' })
    expect(await doaRow(v2)).toMatchObject({ status: 'WITHDRAWN', withdrawnAt: LATER })
    const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
    expect(v1).toMatchObject({ status: 'PUBLISHED', effectiveTo: null })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'doa_version.withdrawn', aggregateId: v2 } })).toMatchObject({ data: { versionNo: 2, previousVersionId: v1.id, effectiveTo: null } })
    // ORG_ADMIN, AUDITOR, its submitter (admin2) and who asked (admin) are told
    const told = await prisma.notification.findMany({ where: { templateKey: 'policy.withdrawn', subjectId: v2 }, select: { recipientMemberId: true } })
    expect(new Set(told.map((n) => n.recipientMemberId))).toEqual(new Set([org.member.admin, org.member.admin2, org.member.auditor]))
    // The activation job does nothing with a withdrawn version
    expect(await activateDoaVersion(org.organizationId, v2, NOV_1)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('rejected, it stays PUBLISHED and may be asked again; who asked is told', async () => {
    const v3 = await publishedDoa(3, DEC_1)
    ok(await requestWithdrawal(org.ctxOf('admin2', NOW), 'DOA_VERSION', { versionId: v3, reason: 'ทบทวนอีกครั้ง' }, key()))
    await pinStepUp(org.organizationId, org.member.ceo!, 'DOA_VERSION', v3)
    expect(ok(await ceoDecides((await openTask(v3)).id, 'REJECT'))).toMatchObject({ documentStatus: 'PUBLISHED' })
    expect(await doaRow(v3)).toMatchObject({ status: 'PUBLISHED', withdrawalRequestedAt: null, withdrawalRequestedById: null })
    expect(await prisma.notification.count({ where: { templateKey: 'policy.withdrawal_rejected', subjectId: v3, recipientMemberId: org.member.admin2 } })).toBe(1)

    // Asked again; the decision comes after it took effect: refused; the activation job then cancels the request
    ok(await requestWithdrawal(org.ctxOf('admin2', NOW), 'DOA_VERSION', { versionId: v3, reason: 'ขอถอนอีกครั้ง' }, key()))
    const task = await openTask(v3)
    await pinStepUp(org.organizationId, org.member.ceo!, 'DOA_VERSION', v3)
    expect(await ceoDecides(task.id, 'APPROVE', DEC_1)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'ALREADY_EFFECTIVE' } } })
    ok(await activateDoaVersion(org.organizationId, v3, DEC_1))
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'CANCELLED' })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.cancelled', aggregateId: task.id } })).toMatchObject({ data: { why: 'ALREADY_EFFECTIVE' } })
    expect(await prisma.event.count({ where: { type: 'doa_version.withdrawal_cancelled', aggregateId: v3 } })).toBe(1)
    expect(await doaRow(v3)).toMatchObject({ status: 'PUBLISHED', withdrawalRequestedAt: null })
    // In effect now: a new request is refused
    expect(await requestWithdrawal(org.ctxOf('admin2', DEC_1), 'DOA_VERSION', { versionId: v3, reason: 'ช้าไป' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'ALREADY_EFFECTIVE' } } })
  })
})

describe('[FR-WF-103/AC3] a workflow version is withdrawn with the same commands', () => {
  it('asked, approved by the CEO with the PIN: WITHDRAWN, version 1 runs on and the activation job skips it', async () => {
    const w1 = await prisma.workflowVersion.create({ data: { organizationId: org.organizationId, code: 'WF-T', versionNo: 1, status: 'PUBLISHED', effectiveFrom: new Date('2026-09-30T17:00:00Z'), effectiveTo: NOV_1, publishedAt: NOW } })
    const w2 = await prisma.workflowVersion.create({ data: { organizationId: org.organizationId, code: 'WF-T', versionNo: 2, status: 'PUBLISHED', effectiveFrom: NOV_1, publishedAt: NOW, submittedById: org.member.admin2! } })
    ok(await requestWithdrawal(org.ctxOf('admin', NOW), 'WORKFLOW_VERSION', { versionId: w2.id, reason: 'ผู้ตรวจใหม่ยังไม่พร้อม' }, key()))
    const task = await openTask(w2.id)
    await pinStepUp(org.organizationId, org.member.ceo!, 'WORKFLOW_VERSION', w2.id)
    expect(ok(await ceoDecides(task.id, 'APPROVE'))).toMatchObject({ documentStatus: 'WITHDRAWN' })
    expect(await prisma.workflowVersion.findUniqueOrThrow({ where: { id: w2.id } })).toMatchObject({ status: 'WITHDRAWN', withdrawnAt: LATER })
    expect(await prisma.workflowVersion.findUniqueOrThrow({ where: { id: w1.id } })).toMatchObject({ status: 'PUBLISHED', effectiveTo: null })
    expect(await prisma.notification.count({ where: { templateKey: 'policy.withdrawn', subjectId: w2.id } })).toBe(3)
    expect(await activateWorkflowVersion(org.organizationId, w2.id, NOV_1)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})
