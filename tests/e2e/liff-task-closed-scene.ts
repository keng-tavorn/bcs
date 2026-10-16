import { randomUUID } from 'node:crypto'
import { subtractBusinessMinutes } from '@/core/sla'
import { systemClock } from '@/lib/clock'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { decideTask } from '@/server/services/approvals/decide'
import { createDraft, submitRequest } from '../support/requests'
import { escalateTask, markTaskOverdue, planTaskSla } from '@/server/services/sla'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/liff-task-closed.spec.ts against the e2e database only (FR-DOA-004 AC2, BR-SLA-04, NEW-46), in a twin
// of the demo organization that tests/e2e/liff-tasks-scene.ts made for that spec (`twin`: its DM of construction and the
// VP of the operations division linked to LINE), so nothing here touches a record another spec reads. A request whose
// step was escalated, made through the services with the business clock set back as tests/e2e/coassign-scene.ts does in
// the demo organization: sent 18 business hours ago to the DM, marked overdue at its due time and escalated at its
// escalateAt by the SLA job's own handlers, so the VP of the division (the approver of the band above) holds a second
// task on the step. Prints one JSON line last.
//   escalated <org>          a request of 6,000.00 baht with VAT by the construction requester (PR-01: the DM of
//                            construction), escalated: the VP of the operations division joins its step
//   decide <org> <taskId>    the task's assignee approves it now, on the web (the step's other task is cancelled with it)
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the LIFF closed-task scene runs in the e2e database only')

const now = systemClock.now()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const must = <T,>(what: string, r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`)
  return r.data
}
const MINUTES = 60
/** The request's title and its one line (the Thai words stay off the command line) */
const TITLE = 'ไม้แบบสำหรับงานหล่อเสา'

/** The twin and its member with this demo code (req_con, dm_con, vp_ops, …): the twin's codes end with `_<code>` */
async function memberOf(orgCode: string, code: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true } })
  const member = await prisma.member.findFirst({ where: { organizationId: org.id, employeeCode: { endsWith: `_${code}` } }, select: { id: true } })
  if (!member) throw new Error(`the twin ${orgCode} has no ${code}`)
  return { organizationId: org.id, id: member.id }
}

const memberCtx = (organizationId: string, memberId: string, at: Date = now): Ctx => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now: at })

/** A task and its assignee's names as a page shows them: the Thai one, and the English one when the member has it (else null) */
const assigneeOf = async (taskId: string) => {
  const task = await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId }, select: { id: true, assignee: { select: { displayNameTh: true, displayNameEn: true } } } })
  return { taskId: task.id, name: task.assignee.displayNameTh, nameEn: task.assignee.displayNameEn || null }
}

async function escalated(orgCode: string) {
  const requester = await memberOf(orgCode, 'req_con')
  const { organizationId } = requester
  const calendar = await forTenant(organizationId).$transaction((tx) => loadBusinessCalendar(tx, organizationId))
  const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId, code: 'CON-CAPEX-2569' }, select: { id: true } })
  // Sent 18 business hours ago: due 8 hours after that (PR-01) and escalated 8 more after its due time (escalationPolicy)
  const sentAt = subtractBusinessMinutes(now, 18 * MINUTES, calendar)
  const draft = must(
    'draft',
    await createDraft(
      memberCtx(organizationId, requester.id, subtractBusinessMinutes(sentAt, 5, calendar)),
      { requestTypeCode: 'BUY_GOODS', title: TITLE, priceIncludesVat: true, budgetLineId: line.id, lines: [{ description: TITLE, quantity: '1', uom: 'ชุด', unitPrice: '6000.00' }] },
      key(),
    ),
  )
  const sent = must('submit', await submitRequest(memberCtx(organizationId, requester.id, sentAt), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } }, select: { id: true } })
  // The SLA job's own handlers at the times it would wake: overdue at dueAt, the band above added at escalateAt
  const plan = await planTaskSla(organizationId, task.id, sentAt)
  if (!plan.dueAt || !plan.escalateAt) throw new Error(`no timers for the task: ${JSON.stringify(plan)}`)
  const overdue = await markTaskOverdue(organizationId, task.id, new Date(plan.dueAt))
  if (!overdue.done) throw new Error(`overdue: ${JSON.stringify(overdue)}`)
  const up = await escalateTask(organizationId, task.id, new Date(plan.escalateAt))
  if (!up.done || !up.coAssigneeTaskId) throw new Error(`escalate: ${JSON.stringify(up)}`)
  const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: draft.requestId }, select: { ruleCode: true, doaVersion: { select: { code: true, versionNo: true } } } })
  return {
    request: { id: draft.requestId, number: sent.number, title: TITLE },
    first: await assigneeOf(task.id),
    coAssignee: await assigneeOf(up.coAssigneeTaskId),
    doaRef: `${route.doaVersion.code} ฉบับ ${route.doaVersion.versionNo} ข้อ ${route.ruleCode}`,
  }
}

async function decide(orgCode: string, taskId: string) {
  const { organizationId } = await memberOf(orgCode, 'admin')
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { id: taskId, organizationId, status: 'OPEN' }, select: { assigneeMemberId: true } })
  return { decided: must('decide', await decideTask(memberCtx(organizationId, task.assigneeMemberId), { taskId, decision: 'APPROVE' }, key())) }
}

const [command, ...args] = process.argv.slice(2)
let result: unknown
switch (command) {
  case 'escalated':
    result = await escalated(args[0]!)
    break
  case 'decide':
    result = await decide(args[0]!, args[1]!)
    break
  default:
    throw new Error(`unknown LIFF closed-task scene command ${command ?? '(none)'}: escalated <org> | decide <org> <taskId>`)
}
console.log(JSON.stringify(result))
await prisma.$disconnect()
