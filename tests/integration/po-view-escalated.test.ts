import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { getPurchaseOrderView, getVarianceView, listPurchaseOrders, type DocTrackEntryDto } from '@/server/queries/purchase-orders'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { postGoodsReceipt } from '@/server/services/receiving'
import { escalateTask, planTaskSla } from '@/server/services/sla'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// NEW-46 on a purchase order and a receiving variance (FR-INT-008 AC1, BR-SLA-04, src/server/queries/purchase-orders.ts):
// an escalated step waits for its first assignee and for the approver of the band above added as co-assignee, so "รอใคร"
// (PoWaitingDto.approvers) and the timeline's current entries name every open task of the step, oldest first — as a
// request's page does — and the decision, whoever of the two makes it, is stamped with the route's own DOA reference and
// the escalated flag. A PO escalates for real (PO-01 the COO → PO-02 the CEO); the demo DOA's variance rule (GRV-01) has
// no band above it, so its co-assignee and approval_task.escalated are written here as escalateTaskCommand writes them.
// Monday 5 Oct 2026, 10:00 Thai time.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const minutesAfter = (d: Date | string, minutes: number) => new Date(new Date(d).getTime() + minutes * 60_000)

let org: DoaOrg
let supplierId: string
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg()
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S-ESC', nameTh: 'ผู้ขายทดสอบ', taxId: '0999999000012' } })).id
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: new Date('2026-01-01T00:00:00Z') } })
})

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

const openTaskOf = (subjectId: string) => prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId } } } })
const waitingNow = (track: readonly DocTrackEntryDto[]) => track.filter((t) => t.state === 'current').map((t) => [t.what, t.actor?.id ?? null])
const stamps = (track: readonly DocTrackEntryDto[]) => track.filter((t) => t.what === 'APPROVED').map((t) => [t.actor?.id ?? null, t.doa?.ruleCode ?? null, t.escalated ?? false])

describe('[FR-INT-008/AC1] an escalated step of a PO or a variance: "waiting for" and the timeline name everyone who may decide it (BR-SLA-04, NEW-46)', () => {
  it('a PO waits for the COO and the CEO who joined at escalateAt, oldest first; the CEO’s approval is stamped PO-01 with the flag', async () => {
    const m = org.member
    const po = await submittedPo('1', '50000.00')
    const task = await openTaskOf(po.id)
    expect(task.assigneeMemberId).toBe(m.coo)
    const plan = await planTaskSla(org.organizationId, task.id, NOW)
    const escalated = await escalateTask(org.organizationId, task.id, new Date(plan.escalateAt!))
    expect(escalated).toMatchObject({ done: true, outcome: 'CO_ASSIGNED' })
    const ceoTaskId = escalated.coAssigneeTaskId!

    const looked = minutesAfter(plan.escalateAt!, 10)
    const before = (await getPurchaseOrderView(org.ctxOf('proc_officer', looked), po.id))!
    // "รอใคร": the COO first (the step's own approver, overdue by now), then the CEO who joined at escalateAt
    expect(before.waiting).toMatchObject({ kind: 'APPROVER', assignee: { id: m.coo }, role: { kind: 'POSITION', positionCode: 'COO' }, overdue: true })
    const waiting = before.waiting as Extract<typeof before.waiting, { kind: 'APPROVER' }>
    expect(waiting.approvers.map((a) => [a.taskId, a.assignee.id])).toEqual([
      [task.id, m.coo],
      [ceoTaskId, m.ceo],
    ])
    expect(waiting.approvers[1]).toMatchObject({ role: { kind: 'POSITION', positionCode: 'CEO' }, onBehalfOf: null, since: new Date(plan.escalateAt!), dueAt: task.dueAt, overdue: true, waitingMinutes: 10 })
    // One current entry per approver in the timeline, the same two in the same order
    expect(waitingNow(before.track)).toEqual([
      ['WAIT_APPROVAL', m.coo],
      ['WAIT_APPROVAL', m.ceo],
    ])
    expect(new Set(before.track.map((t) => t.key)).size).toBe(before.track.length)
    // The list of POs says the same
    const row = (await listPurchaseOrders(org.ctxOf('proc_officer', looked), { status: 'PENDING_APPROVAL' })).rows.find((r) => r.id === po.id)!
    expect(row.waiting.kind === 'APPROVER' ? row.waiting.approvers.map((a) => a.assignee.id) : null).toEqual([m.coo, m.ceo])

    // The co-assignee decides: the stamp names the CEO, under the route's own rule, with the escalated flag
    const decidedAt = minutesAfter(plan.escalateAt!, 30)
    expect(await decideTask(org.ctxOf('ceo', decidedAt), { taskId: ceoTaskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    const after = (await getPurchaseOrderView(org.ctxOf('proc_officer', minutesAfter(decidedAt, 10)), po.id))!
    expect(stamps(after.track)).toEqual([[m.ceo, 'PO-01', true]])
    // Waiting to go out since the approval (§9.9 principle 4): the CEO approved half an hour after the escalation, when
    // the business day had closed, so ten minutes later no business time has passed yet
    expect(after.waiting).toEqual({ kind: 'SEND', bounced: false, waitingMinutes: 0 })
    expect(waitingNow(after.track)).toEqual([['WAIT_SEND', null]])
  })

  it('a step that was not escalated waits for its one approver, and its stamp has no flag', async () => {
    const m = org.member
    const po = await submittedPo('1', '30000.00')
    const task = await openTaskOf(po.id)
    const view = (await getPurchaseOrderView(org.ctxOf('proc_officer', NOW), po.id))!
    expect(view.waiting.kind === 'APPROVER' ? view.waiting.approvers.map((a) => [a.taskId, a.assignee.id]) : null).toEqual([[task.id, m.coo]])
    expect(waitingNow(view.track)).toEqual([['WAIT_APPROVAL', m.coo]])
    expect(await decideTask(org.ctxOf('coo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    expect(stamps((await getPurchaseOrderView(org.ctxOf('proc_officer', NOW), po.id))!.track)).toEqual([[m.coo, 'PO-01', false]])
  })

  it('a variance waits for the DM and the co-assignee alike; the DM’s approval is stamped GRV-01 with the flag', async () => {
    const m = org.member
    const po = await submittedPo('10', '1100.00')
    await p2p(org, NOW).approveAll(po.id)
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
    const gr = ok(await postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId: po.id, lines: [{ poLineId: po.lines[0]!.id, received: '11', excessDisposition: 'ACCEPT_EXCESS' }] }, key()))
    const varianceId = gr.varianceIds[0]!
    const task = await prisma.approvalTask.update({ where: { id: (await openTaskOf(varianceId)).id }, data: { escalatedAt: minutesAfter(NOW, 60) }, include: { step: { include: { route: true } } } })
    expect(task.assigneeMemberId).toBe(m.dm_con)
    // The co-assignee and the event, as escalateTaskCommand writes them for a step escalated with the band above
    const joined = minutesAfter(NOW, 60)
    const co = await prisma.approvalTask.create({
      data: { organizationId: org.organizationId, stepId: task.stepId, assigneeMemberId: m.vp_ops!, resolvedFrom: 'POSITION:VP@OPS', status: 'OPEN', assignedAt: joined, dueAt: task.dueAt, overdueAt: joined, escalatedAt: joined },
    })
    const route = task.step.route
    await forTenant(org.organizationId).$transaction((tx) =>
      appendEvents(tx, systemCtx(org.organizationId, joined, 'approval-task-sla'), [
        {
          type: 'approval_task.escalated',
          aggregateType: 'ApprovalTask',
          aggregateId: task.id,
          doaVersionId: route.doaVersionId,
          doaRuleCode: route.ruleCode,
          data: {
            subjectType: 'VARIANCE',
            subjectId: varianceId,
            stepId: task.stepId,
            outcome: 'CO_ASSIGNED',
            reason: null,
            coAssigneeTaskId: co.id,
            coAssigneeMemberId: m.vp_ops,
            coAssigneePrincipalMemberId: null,
            resolvedFrom: 'POSITION:VP@OPS',
            doaVersionId: route.doaVersionId,
            doaRuleCode: route.ruleCode,
            nextRuleCode: null,
          },
        },
      ]),
    )

    const before = (await getVarianceView(org.ctxOf('dm_con', minutesAfter(joined, 5)), varianceId))!
    expect(waitingNow(before.track)).toEqual([
      ['WAIT_APPROVAL', m.dm_con],
      ['WAIT_APPROVAL', m.vp_ops],
    ])
    expect(before.track.filter((t) => t.state === 'current').map((t) => t.at)).toEqual([task.assignedAt, joined])
    expect(before.route!.steps[0]).toMatchObject({ escalation: 'CO_ASSIGNED', open: [{ taskId: task.id }, { taskId: co.id }] })

    expect(await decideTask(org.ctxOf('dm_con', minutesAfter(joined, 10)), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    const after = (await getVarianceView(org.ctxOf('dm_con', minutesAfter(joined, 20)), varianceId))!
    expect(stamps(after.track)).toEqual([[m.dm_con, 'GRV-01', true]])
    expect(waitingNow(after.track)).toEqual([])
  })
})
