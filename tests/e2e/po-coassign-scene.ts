import { randomUUID } from 'node:crypto'
import { subtractBusinessMinutes } from '@/core/sla'
import { systemClock } from '@/lib/clock'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { decideTask } from '@/server/services/approvals/decide'
import { markNotificationsRead } from '@/server/services/notifications'
import { assignSupplier } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { createDraft, submitRequest } from '@/server/services/requests'
import { escalateTask, markTaskOverdue, planTaskSla } from '@/server/services/sla'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/po-view-coassign.spec.ts against the e2e database only (NEW-46 on purchase orders, FR-INT-008 AC1,
// BR-SLA-04, FR-NOTI-003 AC2): a purchase order whose approval step was escalated, made through the services with the
// business clock set back, as tests/e2e/coassign-scene.ts does for a request — an urgent request of CON approved by its
// DM, its supplier chosen so its PO is drafted at once (BR-CONS-02), the PO sent for approval 18 business hours ago to the
// COO (PO-01), marked overdue at its due time and escalated at its escalateAt by the SLA job's own handlers, so the CEO
// (the approver of PO-02, the band above) holds a second task on the step. 10 pieces at 100 baht on the capital budget
// of CON, or its operating budget when the capital one has no room, as tests/e2e/procurement-scene.ts spends them; each
// project and run orders its own item. Every notice the scene causes — all about its own request and PO — is marked read
// by its recipient, so no bell changes. Prints one JSON line last.
//   escalated <project>                   the escalated PO, waiting for the COO or the CEO, whoever decides first
//   decide <project> <taskId> <requestId> the CEO approves on their own task now (the COO's task is cancelled with it)
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the PO co-assignee scene runs in the e2e database only')

const now = systemClock.now()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const must = <T,>(what: string, r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`)
  return r.data
}
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const organizationId = org.id
const calendar = await forTenant(organizationId).$transaction((tx) => loadBusinessCalendar(tx, organizationId))
const memberId = async (code: string) => (await prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode: code }, select: { id: true } })).id
const ctxOf = async (code: string, at: Date): Promise<Ctx> => makeCtx({ organizationId, actor: { type: 'USER', memberId: await memberId(code) }, channel: 'WEB', now: at })
const idOf = async (model: 'supplier' | 'deliverySite', code: string) =>
  model === 'supplier'
    ? (await prisma.supplier.findFirstOrThrow({ where: { organizationId, code }, select: { id: true } })).id
    : (await prisma.deliverySite.findFirstOrThrow({ where: { organizationId, code }, select: { id: true } })).id

/** The budget line `preferred` when it has `netBaht` left, else `fallback` (other specs spend the same lines) */
async function budgetLine(preferred: string, fallback: string, netBaht: bigint): Promise<string> {
  for (const code of [preferred, fallback]) {
    const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId, code }, select: { id: true } })
    const balance = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: line.id }, select: { availableSatang: true } })
    if (balance.availableSatang >= netBaht * 100n) return line.id
  }
  throw new Error(`no budget left on ${preferred} or ${fallback}`)
}

/** Every unread notice about the scene's request and PO is read by its recipient: no bell changes */
async function leaveBellsAsTheyWere(subjectIds: readonly string[]) {
  const unread = await prisma.notification.findMany({ where: { organizationId, readAt: null, subjectId: { in: [...subjectIds] } }, select: { id: true, recipientMemberId: true } })
  const byRecipient = new Map<string, string[]>()
  for (const n of unread) byRecipient.set(n.recipientMemberId, [...(byRecipient.get(n.recipientMemberId) ?? []), n.id])
  for (const [recipient, ids] of byRecipient) {
    must('mark read', await markNotificationsRead(makeCtx({ organizationId, actor: { type: 'USER', memberId: recipient }, channel: 'WEB', now }), { notificationIds: ids }, key()))
  }
}

const [command, ...args] = process.argv.slice(2)
const project = args[0] === 'mobile' ? 'm' : 'd'
const run = randomUUID().slice(0, 6)

if (command === 'escalated') {
  // Sent for approval 18 business hours ago: due 8 hours after that (PO-01) and escalated 8 more after its due time
  const sentAt = subtractBusinessMinutes(now, 18 * 60, calendar)
  const at = (minutesBefore: number) => subtractBusinessMinutes(sentAt, minutesBefore, calendar)
  const item = `ถุงมือผ้าเคลือบยาง (${project}${run})`
  const draft = must(
    'draft',
    await createDraft(
      await ctxOf('req_con', at(40)),
      {
        requestTypeCode: 'BUY_GOODS',
        title: `อุปกรณ์ป้องกันมือ (${project}${run})`,
        budgetLineId: await budgetLine('CON-CAPEX-2569', 'CON-OPEX-2569', 1_000n),
        deliverySiteId: await idOf('deliverySite', 'HQ-STORE'),
        urgency: 'URGENT',
        lines: [{ description: item, quantity: '10', uom: 'คู่', unitPrice: '100.00' }],
      },
      key(),
    ),
  )
  const request = must('submit request', await submitRequest(await ctxOf('req_con', at(35)), { requestId: draft.requestId }, key()))
  const requestTask = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } }, select: { id: true, assignee: { select: { employeeCode: true } } } })
  must('approve request', await decideTask(await ctxOf(requestTask.assignee.employeeCode!, at(20)), { taskId: requestTask.id, decision: 'APPROVE' }, key()))
  const lines = await prisma.requestLine.findMany({ where: { requestId: draft.requestId }, select: { id: true } })
  // Urgent: choosing the supplier drafts its own PO at once (BR-CONS-02)
  const assigned = must('assign supplier', await assignSupplier(await ctxOf('proc_officer', at(10)), { requestLineIds: lines.map((l) => l.id), supplierId: await idOf('supplier', 'S3') }, key()))
  const [poId] = assigned.purchaseOrderIds
  if (!poId || assigned.purchaseOrderIds.length !== 1) throw new Error(`expected one draft of an urgent request, got ${JSON.stringify(assigned)}`)
  const submitted = must('submit PO', await submitPo(await ctxOf('proc_officer', sentAt), { poId }, key()))

  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: poId } } }, select: { id: true, assignee: { select: { displayNameTh: true } } } })
  // The SLA job's own handlers at the times it would wake: overdue at dueAt, the band above added at escalateAt
  const plan = await planTaskSla(organizationId, task.id, sentAt)
  if (!plan.dueAt || !plan.escalateAt) throw new Error(`no timers for the task: ${JSON.stringify(plan)}`)
  const overdue = await markTaskOverdue(organizationId, task.id, new Date(plan.dueAt))
  if (!overdue.done) throw new Error(`overdue: ${JSON.stringify(overdue)}`)
  const escalated = await escalateTask(organizationId, task.id, new Date(plan.escalateAt))
  if (!escalated.done || !escalated.coAssigneeTaskId) throw new Error(`escalate: ${JSON.stringify(escalated)}`)
  const co = await prisma.approvalTask.findUniqueOrThrow({ where: { id: escalated.coAssigneeTaskId }, select: { id: true, assignee: { select: { displayNameTh: true } } } })
  const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'PURCHASE_ORDER', subjectId: poId }, select: { ruleCode: true, doaVersion: { select: { code: true, versionNo: true } } } })
  await leaveBellsAsTheyWere([draft.requestId, poId])
  console.log(
    JSON.stringify({
      run,
      request: { id: draft.requestId, number: request.number },
      po: { id: poId, number: submitted.number },
      first: { taskId: task.id, name: task.assignee.displayNameTh },
      coAssignee: { taskId: co.id, name: co.assignee.displayNameTh },
      doaRef: `${route.doaVersion.code} ฉบับ ${route.doaVersion.versionNo} ข้อ ${route.ruleCode}`,
    }),
  )
} else if (command === 'decide') {
  const [, taskId = '', requestId = ''] = args
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { id: taskId, organizationId }, select: { assigneeMemberId: true, step: { select: { route: { select: { subjectId: true } } } } } })
  const decided = must('decide', await decideTask(makeCtx({ organizationId, actor: { type: 'USER', memberId: task.assigneeMemberId }, channel: 'WEB', now }), { taskId, decision: 'APPROVE' }, key()))
  await leaveBellsAsTheyWere([task.step.route.subjectId, ...(requestId ? [requestId] : [])])
  console.log(JSON.stringify({ decided }))
} else {
  throw new Error(`unknown command ${command}: escalated <project> | decide <project> <taskId> <requestId>`)
}
await prisma.$disconnect()
