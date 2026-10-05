import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { subtractBusinessMinutes } from '@/core/sla'
import { systemClock } from '@/lib/clock'
import { deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { decideTask } from '@/server/services/approvals/decide'
import { BUDGET_IMPORT_COLUMNS, buildBudgetImportTemplate, importBudget } from '@/server/services/budget/import'
import { grantRole } from '@/server/services/members/roles'
import { markNotificationsRead } from '@/server/services/notifications'
import { createDraft, submitRequest } from '@/server/services/requests'
import { escalateTask, markTaskOverdue, planTaskSla } from '@/server/services/sla'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/request-view-coassign.spec.ts against the e2e database only (NEW-46, NEW-47, BR-SLA-04,
// FR-NOTI-003 AC2): a request whose step was escalated, made through the services with the business clock set back,
// as the demo history does — sent 18 business hours ago to the DM of the department, marked overdue at its due time and
// escalated at its escalateAt by the SLA job's own handlers, so the VP of the division (the approver of the band
// above) holds a second task on the step. Every run makes its own requester and budget line (codes carry the project
// and a run id) in a department of its project — CON for desktop (DM dm_con, VP vp_ops), IT for mobile (DM dm_it, VP
// vp_sup) — so desktop and mobile never meet and no other spec's budget figures change; every notice the scene causes
// — all about its own request, or to the members it made — is marked read by its recipient, so no bell changes, and
// no notice of another spec running at the same time is touched. Prints one JSON line last.
//   escalated <project>       the escalated request, waiting for the DM or the VP, whoever decides first
//   decide <project> <taskId> the VP approves on their own task now (the DM's task is cancelled with it)
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the co-assignee scene runs in the e2e database only')
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')

const now = systemClock.now()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const must = <T,>(what: string, r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`)
  return r.data
}
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true, timezone: true } })
const organizationId = org.id
const calendar = await forTenant(organizationId).$transaction((tx) => loadBusinessCalendar(tx, organizationId))
/** The members this run made: whatever they are told is this run's */
const madeHere: string[] = []
const memberCtx = (memberId: string, at: Date = now): Ctx => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now: at })
const memberByCode = (code: string) => prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode: code }, select: { id: true, displayNameTh: true } })
const thaiDay = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
const MINUTES = 60

/**
 * A member of the demo organization who signs in with SEED_DEV_PASSWORD; one who will hold a role gets the TOTP the
 * seed derives from SEED_TOTP_KEY, as every role holder of the seed has
 */
async function freshMember(code: string, nameTh: string, departmentCode: string, withRole = false) {
  const department = await prisma.department.findFirstOrThrow({ where: { organizationId, code: departmentCode }, select: { id: true } })
  const email = `${code}@demo.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: password! })
  const member = await prisma.member.create({ data: { organizationId, userId, email, displayNameTh: nameTh, employeeCode: code, status: 'ACTIVE', primaryDepartmentId: department.id } })
  if (withRole) await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey!, code), [])
  madeHere.push(member.id)
  return { id: member.id, code, email, name: nameTh }
}

/** A budget line of the department imported through the template by a budget admin of this run, as the import page does */
async function importedLine(departmentCode: string, code: string, nameTh: string, amount: string) {
  const budgetAdmin = await freshMember(`e2e-coadm-${code.toLowerCase()}`, 'ผู้ดูแลงบ ทดสอบการส่งต่อ', 'FIN', true)
  const admin = await memberByCode('admin')
  must('grant BUDGET_ADMIN', await grantRole(memberCtx(admin.id), { memberId: budgetAdmin.id, role: 'BUDGET_ADMIN' }, key()))
  const today = thaiDay(now)
  const year = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId, status: 'OPEN', startsOn: { lte: new Date(`${today}T00:00:00Z`) }, endsOn: { gte: new Date(`${today}T00:00:00Z`) } } })
  const labels = Object.fromEntries(BUDGET_IMPORT_COLUMNS.map((c) => [c, c])) as Record<(typeof BUDGET_IMPORT_COLUMNS)[number], string>
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(await buildBudgetImportTemplate(labels)).buffer as ArrayBuffer)
  workbook.getWorksheet('Budget')!.addRow([year.code, departmentCode, `CC-${departmentCode}`, code, nameTh, '', amount])
  const bytes = new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer).slice().buffer as ArrayBuffer
  must('import', await importBudget(memberCtx(budgetAdmin.id), { bytes, fileName: `${code}.xlsx` }, key()))
  return prisma.budgetLine.findFirstOrThrow({ where: { organizationId, fiscalYearId: year.id, code }, select: { id: true } })
}

/**
 * Every notice this run caused is marked read by its recipient, so no bell changes: the scene's notices are all about
 * its own request (assigned, overdue, escalated, approved), and the members it made are its own. Notices of any other
 * spec — running at the same time, for the same approvers — are left as they are.
 */
async function leaveBellsAsTheyWere(requestId: string) {
  const unread = await prisma.notification.findMany({
    where: { organizationId, readAt: null, OR: [{ subjectId: requestId }, { recipientMemberId: { in: madeHere } }] },
    select: { id: true, recipientMemberId: true },
  })
  const byRecipient = new Map<string, string[]>()
  for (const n of unread) byRecipient.set(n.recipientMemberId, [...(byRecipient.get(n.recipientMemberId) ?? []), n.id])
  for (const [recipient, ids] of byRecipient) must('mark read', await markNotificationsRead(memberCtx(recipient), { notificationIds: ids }, key()))
}

const [command, ...args] = process.argv.slice(2)
const mobile = args[0] === 'mobile'
const project = mobile ? 'm' : 'd'
const run = randomUUID().slice(0, 6)
const dept = mobile ? { code: 'IT', item: 'สายแลนสำหรับไซต์งาน' } : { code: 'CON', item: 'เหล็กเส้นสำหรับงานฐานราก' }

if (command === 'escalated') {
  const requester = await freshMember(`e2e-coreq-${project}${run}`, `ผู้ขอ ทดสอบการส่งต่อ ${run}`, dept.code)
  const line = await importedLine(dept.code, `${dept.code}-E2EC-${project.toUpperCase()}${run.toUpperCase()}`, `งบทดสอบการส่งต่อ ${run}`, '100000')
  // Sent 18 business hours ago: due 8 hours after that and escalated 8 more after its due time (escalationPolicy)
  const sentAt = subtractBusinessMinutes(now, 18 * MINUTES, calendar)
  const title = `${dept.item} ${run}`
  const draft = must('draft', await createDraft(memberCtx(requester.id, subtractBusinessMinutes(sentAt, 5, calendar)), { requestTypeCode: 'BUY_GOODS', title, budgetLineId: line.id, lines: [{ description: dept.item, quantity: '1', uom: 'งาน', unitPrice: '6000.00' }] }, key()))
  const sent = must('submit', await submitRequest(memberCtx(requester.id, sentAt), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } }, select: { id: true, assignee: { select: { id: true, displayNameTh: true } } } })
  // The SLA job's own handlers at the times it would wake: overdue at dueAt, the band above added at escalateAt
  const plan = await planTaskSla(organizationId, task.id, sentAt)
  if (!plan.dueAt || !plan.escalateAt) throw new Error(`no timers for the task: ${JSON.stringify(plan)}`)
  const overdue = await markTaskOverdue(organizationId, task.id, new Date(plan.dueAt))
  if (!overdue.done) throw new Error(`overdue: ${JSON.stringify(overdue)}`)
  const escalated = await escalateTask(organizationId, task.id, new Date(plan.escalateAt))
  if (!escalated.done || !escalated.coAssigneeTaskId) throw new Error(`escalate: ${JSON.stringify(escalated)}`)
  const co = await prisma.approvalTask.findUniqueOrThrow({ where: { id: escalated.coAssigneeTaskId }, select: { id: true, assignee: { select: { id: true, displayNameTh: true } } } })
  const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: draft.requestId }, select: { ruleCode: true, doaVersion: { select: { code: true, versionNo: true } } } })
  await leaveBellsAsTheyWere(draft.requestId)
  console.log(
    JSON.stringify({
      run,
      requester: { code: requester.code, email: requester.email, name: requester.name },
      request: { id: draft.requestId, number: sent.number, title },
      first: { taskId: task.id, name: task.assignee.displayNameTh },
      coAssignee: { taskId: co.id, name: co.assignee.displayNameTh },
      doaRef: `${route.doaVersion.code} ฉบับ ${route.doaVersion.versionNo} ข้อ ${route.ruleCode}`,
      escalatedAt: plan.escalateAt,
    }),
  )
} else if (command === 'decide') {
  const taskId = args[1] ?? ''
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { id: taskId, organizationId }, select: { assigneeMemberId: true, step: { select: { route: { select: { subjectId: true } } } } } })
  const decided = must('decide', await decideTask(memberCtx(task.assigneeMemberId), { taskId, decision: 'APPROVE' }, key()))
  await leaveBellsAsTheyWere(task.step.route.subjectId)
  console.log(JSON.stringify({ decided }))
} else {
  throw new Error(`unknown command ${command}: escalated <project> | decide <project> <taskId>`)
}
await prisma.$disconnect()
