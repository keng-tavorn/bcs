import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { getPurchaseOrderView } from '@/server/queries/purchase-orders'
import { decideTask } from '@/server/services/approvals/decide'
import { proposeOrgChange } from '@/server/services/org-authority'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { postGoodsReceipt } from '@/server/services/receiving'
import { escalateTask, planTaskSla } from '@/server/services/sla'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'
import { stepUpForTask } from '../support/pin'

// The first decision on a step decides it, in every decide flow (spec §6.4 "ผู้รับร่วมอีกคนตัดสินแล้ว", BR-SLA-04,
// NEW-47, src/server/services/approvals/step-complete.ts): purchase orders (purchase-orders/decide.ts), receiving
// variances (receiving/variance-decide.ts) and policy (approvals/policy-decide.ts) cancel the step's other open task
// with approval_task.cancelled, why CO_ASSIGNEE_DECIDED, and a late decision on it is refused with who decided the step
// and when (FR-DOA-004 AC2). Purchase requests are covered in sla-jobs-escalation.test.ts. A purchase order escalates
// for real (PO-01 COO → PO-02 CEO); the demo DOA's variance (GRV-01) and policy rules have no amount band, so the SLA
// job finds no band above them (NO_NEXT_BAND, sla-jobs-subjects.test.ts) — for them the co-assignee's row, as
// escalateTaskCommand writes it, is made here. Monday 5 Oct 2026 10:00 Thai time.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let supplierId: string
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg()
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S-STEP', nameTh: 'ผู้ขายทดสอบ', taxId: '0999999000012' } })).id
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: new Date('2026-01-01T00:00:00Z') } })
})

const cancelledOf = (taskId: string) => prisma.event.findMany({ where: { type: 'approval_task.cancelled', aggregateId: taskId }, orderBy: { seq: 'asc' } })
const openTaskOf = (subjectId: string) => prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId } } } })

/** The row escalateTaskCommand writes for the approver of the next band: a second open task on the same step, escalated */
async function coAssignee(taskId: string, code: string, resolvedFrom: string) {
  const task = await prisma.approvalTask.update({ where: { id: taskId }, data: { escalatedAt: NOW } })
  return prisma.approvalTask.create({
    data: { organizationId: org.organizationId, stepId: task.stepId, assigneeMemberId: org.member[code]!, resolvedFrom, status: 'OPEN', assignedAt: NOW, dueAt: task.dueAt, overdueAt: NOW, escalatedAt: NOW },
  })
}

/** A PO of one line of `quantity` × `unitPrice`, sent for approval by proc_officer (its request approved first) */
async function submittedPo(quantity: string, unitPrice: string) {
  const flow = p2p(org, NOW)
  const request = await flow.approvedRequest(await flow.fundedLine(2_000_000n), [{ quantity, unitPrice }])
  const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ทดสอบ', address: 'ถนนทดสอบ' } })
  await prisma.request.update({ where: { id: request.id }, data: { deliverySiteId: site.id } })
  const proc = org.ctxOf('proc_officer', NOW)
  ok(await assignSupplier(proc, { requestLineIds: request.lines.map((l) => l.id), supplierId }, key()))
  const run = ok(await consolidateNow(proc, key()))
  const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id }, include: { lines: true } })
  ok(await submitPo(proc, { poId: po.id }, key()))
  return po
}

describe('[FR-NOTI-003/AC2] every decide flow ends its step for the other open task: whoever decides first decides (BR-SLA-04, NEW-47)', () => {
  it('a purchase order: the COO decides before the CEO who joined at escalateAt; the CEO’s task is cancelled with its link and refused', async () => {
    const po = await submittedPo('1', '50000.00')
    const task = await openTaskOf(po.id)
    expect(task.assigneeMemberId).toBe(org.member.coo)
    const plan = await planTaskSla(org.organizationId, task.id, NOW)
    const escalated = await escalateTask(org.organizationId, task.id, new Date(plan.escalateAt!))
    expect(escalated).toMatchObject({ done: true, outcome: 'CO_ASSIGNED' })
    const ceoTask = await prisma.approvalTask.findUniqueOrThrow({ where: { id: escalated.coAssigneeTaskId! } })
    expect(ceoTask.assigneeMemberId).toBe(org.member.ceo)
    // The PO's route names both who may decide its step, flagged as escalated (NEW-46 on the PO page, BR-SLA-04)
    const before = await getPurchaseOrderView(org.ctxOf('proc_officer', NOW), po.id)
    expect(before!.route!.steps).toMatchObject([
      {
        stepNo: 1,
        approver: { id: org.member.coo },
        open: [
          { taskId: task.id, approver: { id: org.member.coo } },
          { taskId: ceoTask.id, approver: { id: org.member.ceo } },
        ],
        escalation: 'CO_ASSIGNED',
      },
    ])
    const decidedAt = new Date(new Date(plan.escalateAt!).getTime() + 60_000)
    expect(await decideTask(org.ctxOf('coo', decidedAt), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: ceoTask.id } })).toMatchObject({ status: 'CANCELLED', decidedAt: null, version: ceoTask.version + 1 })
    expect((await cancelledOf(ceoTask.id)).map((e) => e.data)).toEqual([{ subjectId: po.id, why: 'CO_ASSIGNEE_DECIDED' }])
    expect((await prisma.actionToken.findMany({ where: { taskId: ceoTask.id } })).map((t) => t.revokedAt)).toEqual([decidedAt])
    const late = new Date(decidedAt.getTime() + 60_000)
    expect(await decideTask(org.ctxOf('ceo', late), { taskId: ceoTask.id, decision: 'REJECT', reason: 'ราคาสูงเกินไป' }, key())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: 'ผู้ใช้ coo', time: decidedAt.toISOString() } },
    })
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).toMatchObject({ status: 'APPROVED' })
    // …and once decided, the COO who decided, with the flag and nobody left waiting
    const after = await getPurchaseOrderView(org.ctxOf('proc_officer', late), po.id)
    expect(after!.route!.steps).toMatchObject([{ stepNo: 1, approver: { id: org.member.coo }, decision: 'APPROVE', open: [], escalation: 'CO_ASSIGNED' }])
  })

  it('a receiving variance: the DM approves the excess, the other open task of the step is cancelled and refused', async () => {
    const po = await submittedPo('10', '1100.00')
    await p2p(org, NOW).approveAll(po.id)
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
    const gr = ok(await postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId: po.id, lines: [{ poLineId: po.lines[0]!.id, received: '11', excessDisposition: 'ACCEPT_EXCESS' }] }, key()))
    const varianceId = gr.varianceIds[0]!
    const task = await openTaskOf(varianceId)
    expect(task.assigneeMemberId).toBe(org.member.dm_con)
    const other = await coAssignee(task.id, 'vp_ops', 'POSITION:VP@OPS')
    expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ status: 'CANCELLED', version: other.version + 1 })
    expect((await cancelledOf(other.id)).map((e) => e.data)).toEqual([{ subjectId: varianceId, why: 'CO_ASSIGNEE_DECIDED' }])
    expect(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: other.id, decision: 'REJECT', reason: 'ไม่รับของเกิน' }, key())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: 'ผู้ใช้ dm_con', time: NOW.toISOString() } },
    })
    expect(await prisma.variance.findUniqueOrThrow({ where: { id: varianceId } })).toMatchObject({ status: 'APPROVED' })
  })

  it('an authority change: the CEO approves with the PIN, the other open task of the step is cancelled and refused', async () => {
    const proposed = ok(
      await proposeOrgChange(
        org.ctxOf('admin', NOW),
        { kind: 'POSITION_ASSIGN', payload: { positionCode: 'VP', departmentId: org.department.SUP!, memberId: org.member.dm_fin! }, effectiveFrom: '2026-10-20T01:00:00Z', reason: 'แต่งตั้งตามคำสั่งบริษัท' },
        key(),
      ),
    )
    const task = await openTaskOf(proposed.changeId)
    expect(task.assigneeMemberId).toBe(org.member.ceo)
    const other = await coAssignee(task.id, 'coo', 'POSITION:COO@HQ')
    await stepUpForTask(task.id, org.member.ceo!)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ status: 'CANCELLED', version: other.version + 1 })
    expect((await cancelledOf(other.id)).map((e) => e.data)).toEqual([{ subjectId: proposed.changeId, why: 'CO_ASSIGNEE_DECIDED' }])
    // Refused before any step-up is asked: the task is closed
    expect(await decideTask(org.ctxOf('coo', NOW), { taskId: other.id, decision: 'REJECT', reason: 'ยังไม่ถึงเวลา' }, key())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: 'ผู้ใช้ ceo', time: NOW.toISOString() } },
    })
    expect(await prisma.orgAuthorityChange.findUniqueOrThrow({ where: { id: proposed.changeId } })).toMatchObject({ status: 'SCHEDULED' })
  })

  it('a decision with no other task on its step cancels nothing (one task per step, as most steps are)', async () => {
    const po = await submittedPo('1', '30000.00')
    const task = await openTaskOf(po.id)
    expect(await decideTask(org.ctxOf('coo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    expect(await prisma.event.count({ where: { type: 'approval_task.cancelled', data: { path: ['subjectId'], equals: po.id } } })).toBe(0)
    expect(await prisma.approvalStep.findUniqueOrThrow({ where: { id: task.stepId } })).toMatchObject({ status: 'DONE' })
  })
})
