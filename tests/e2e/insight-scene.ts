import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { addBusinessMinutes, subtractBusinessMinutes } from '@/core/sla'
import { systemClock } from '@/lib/clock'
import { deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import type { StoredRole } from '@/server/authz/permissions'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { BUDGET_IMPORT_COLUMNS, buildBudgetImportTemplate, importBudget } from '@/server/services/budget/import'
import { grantRole } from '@/server/services/members/roles'
import { markNotificationsRead } from '@/server/services/notifications'
import { createDraft, submitRequest } from '@/server/services/requests'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/board*.spec.ts, audit*.spec.ts, kpi*.spec.ts and reports*.spec.ts against the e2e database only (unit
// i: S4-10, S4-11, S5-12, demo scene 9). Like the demo history (src/server/services/demo-history), everything goes
// through the services with the business clock set back, so tasks are past their SLA and decisions sit in the past on
// the channel they were made on. Every run makes its own requester and budget line (codes carry the project and a run
// id) in a department of its project — CON for desktop (its VP is vp_ops), IT for mobile (vp_sup) — so desktop and
// mobile never meet and no other spec's budget figures change; every notice the scene causes is marked read by its
// recipient, so no bell changes. Prints one JSON line last.
//   board <project>          a request of 38,500.00 before VAT waiting 18 business hours at the VP (past its 8-hour
//                            SLA, like Demo_History H12) and one of 6,000.00 the DM asked the requester about
//   decisions <project>      three requests of the DM approved 1, 2 and 3 business hours after they were sent, in LINE
//                            chat, in LIFF and on the web; and G-5 of the 60 days the KPI page opens with, counted from
//                            the events
//   settle <since ISO>       marks read, by each recipient, every notice made since then (reminders the test sent)
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the insight scene runs in the e2e database only')
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
/** The notices nobody has read before this run: the ones this run adds are the others */
const unreadBefore = new Set((await prisma.notification.findMany({ where: { organizationId, readAt: null }, select: { id: true } })).map((n) => n.id))
const memberCtx = (memberId: string, at: Date = now, channel: Ctx['channel'] = 'WEB'): Ctx => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel, now: at })
const memberByCode = (code: string) => prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode: code }, select: { id: true, displayNameTh: true } })
const thaiDay = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
const today = thaiDay(now)
const MINUTES = 60

/** A member of the demo organization who signs in with SEED_DEV_PASSWORD, and with TOTP when they hold a role */
async function freshMember(code: string, nameTh: string, departmentCode: string, roles: readonly StoredRole[]) {
  const department = await prisma.department.findFirstOrThrow({ where: { organizationId, code: departmentCode }, select: { id: true } })
  const email = `${code}@demo.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: password! })
  const member = await prisma.member.create({ data: { organizationId, userId, email, displayNameTh: nameTh, employeeCode: code, status: 'ACTIVE', primaryDepartmentId: department.id } })
  if (roles.length) await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey!, code), [])
  const admin = await memberByCode('admin')
  for (const role of roles) must(`grant ${role}`, await grantRole(memberCtx(admin.id), { memberId: member.id, role }, key()))
  return { id: member.id, code, email, name: nameTh }
}

/** A budget line of the department imported through the template by a budget admin of this run, as the import page does */
async function importedLine(departmentCode: string, code: string, nameTh: string, amount: string) {
  const budgetAdmin = await freshMember(`e2e-insadm-${code.toLowerCase()}`, 'ผู้ดูแลงบ ทดสอบหน้าติดตาม', 'FIN', ['BUDGET_ADMIN'])
  const year = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId, status: 'OPEN', startsOn: { lte: new Date(`${today}T00:00:00Z`) }, endsOn: { gte: new Date(`${today}T00:00:00Z`) } } })
  const labels = Object.fromEntries(BUDGET_IMPORT_COLUMNS.map((c) => [c, c])) as Record<(typeof BUDGET_IMPORT_COLUMNS)[number], string>
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(await buildBudgetImportTemplate(labels)).buffer as ArrayBuffer)
  workbook.getWorksheet('Budget')!.addRow([year.code, departmentCode, `CC-${departmentCode}`, code, nameTh, '', amount])
  const bytes = new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer).slice().buffer as ArrayBuffer
  must('import', await importBudget(memberCtx(budgetAdmin.id), { bytes, fileName: `${code}.xlsx` }, key()))
  return prisma.budgetLine.findFirstOrThrow({ where: { organizationId, fiscalYearId: year.id, code }, select: { id: true, code: true } })
}

/** A request of `requesterId` sent at `at`, with its open task and who holds it */
async function sentAt(requesterId: string, budgetLineId: string, title: string, netBaht: string, at: Date) {
  const draft = must('draft', await createDraft(memberCtx(requesterId, subtractBusinessMinutes(at, 5, calendar)), { requestTypeCode: 'BUY_GOODS', title, budgetLineId, lines: [{ description: title, quantity: '1', uom: 'งาน', unitPrice: netBaht }] }, key()))
  const sent = must('submit', await submitRequest(memberCtx(requesterId, at), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } }, select: { id: true, assignee: { select: { id: true, employeeCode: true, displayNameTh: true } } } })
  return { id: draft.requestId, number: sent.number, title, taskId: task.id, approver: { id: task.assignee.id, code: task.assignee.employeeCode ?? '', name: task.assignee.displayNameTh } }
}

/** Every notice this run caused is marked read by its recipient: no bell changes */
async function leaveBellsAsTheyWere() {
  const unread = await prisma.notification.findMany({ where: { organizationId, readAt: null }, select: { id: true, recipientMemberId: true } })
  const byRecipient = new Map<string, string[]>()
  for (const n of unread.filter((x) => !unreadBefore.has(x.id))) byRecipient.set(n.recipientMemberId, [...(byRecipient.get(n.recipientMemberId) ?? []), n.id])
  for (const [recipient, ids] of byRecipient) must('mark read', await markNotificationsRead(memberCtx(recipient), { notificationIds: ids }, key()))
}

/** G-5 of the days from `from` to `to` (Thai days), counted from the decision events as §11.4 defines it */
async function lineShare(from: string, to: string) {
  const end = new Date(new Date(`${to}T00:00:00+07:00`).getTime() + 24 * 60 * MINUTES * 1000)
  const decided = await prisma.event.findMany({ where: { organizationId, type: 'approval_task.decided', occurredAt: { gte: new Date(`${from}T00:00:00+07:00`), lt: end } }, select: { channel: true, data: true } })
  const mobile = (c: string) => c === 'LINE_CHAT' || c === 'LIFF'
  const requests = decided.filter((d) => (d.data as { subjectType?: string }).subjectType === 'REQUEST')
  return { all: { numerator: decided.filter((d) => mobile(d.channel)).length, denominator: decided.length }, pr: { numerator: requests.filter((d) => mobile(d.channel)).length, denominator: requests.length } }
}

const [command, ...args] = process.argv.slice(2)
const mobile = args[0] === 'mobile'
const project = mobile ? 'm' : 'd'
const run = randomUUID().slice(0, 6)
const dept = mobile ? { code: 'IT', vp: 'vp_sup', dm: 'dm_it', item: 'อุปกรณ์เครือข่ายไซต์งาน' } : { code: 'CON', vp: 'vp_ops', dm: 'dm_con', item: 'ไม้แบบหล่อคอนกรีต' }
const departmentRow = () => prisma.department.findFirstOrThrow({ where: { organizationId, code: dept.code }, select: { id: true, nameTh: true } })

if (command === 'board') {
  const requester = await freshMember(`e2e-insreq-${project}${run}`, `ผู้ขอ ทดสอบกระดาน ${run}`, dept.code, [])
  const line = await importedLine(dept.code, `${dept.code}-E2EI-B${project.toUpperCase()}${run.toUpperCase()}`, `งบทดสอบกระดานค้าง ${run}`, '200000')
  // Waiting 18 business hours at the VP, past its 8-hour SLA (Demo_History H12)
  const overdue = await sentAt(requester.id, line.id, `${dept.item} ${run}`, '38500.00', subtractBusinessMinutes(now, 18 * MINUTES, calendar))
  // The DM asked the requester about this one an hour after it came: it waits for the requester
  const askedAt = subtractBusinessMinutes(now, 2 * MINUTES, calendar)
  const waiting = await sentAt(requester.id, line.id, `น้ำมันเครื่องจักร ${run}`, '6000.00', subtractBusinessMinutes(askedAt, MINUTES, calendar))
  must('ask', await requestInfo(memberCtx(waiting.approver.id, askedAt), { taskId: waiting.taskId, question: 'ขอใบเสนอราคาเพิ่มอีก 1 ราย' }, key()))
  await leaveBellsAsTheyWere()
  const department = await departmentRow()
  const vpDepartment = await prisma.member.findUniqueOrThrow({ where: { id: overdue.approver.id }, select: { primaryDepartment: { select: { id: true, nameTh: true } } } })
  console.log(
    JSON.stringify({
      run,
      requester: { code: requester.code, email: requester.email, name: requester.name },
      department: { id: department.id, name: department.nameTh },
      overdue: { id: overdue.id, number: overdue.number, title: overdue.title, approver: overdue.approver, approverDepartment: vpDepartment.primaryDepartment },
      waiting: { id: waiting.id, number: waiting.number, title: waiting.title, approver: waiting.approver },
    }),
  )
} else if (command === 'decisions') {
  const requester = await freshMember(`e2e-insdec-${project}${run}`, `ผู้ขอ ทดสอบตัวชี้วัด ${run}`, dept.code, [])
  const line = await importedLine(dept.code, `${dept.code}-E2EI-K${project.toUpperCase()}${run.toUpperCase()}`, `งบทดสอบตัวชี้วัด ${run}`, '100000')
  const start = subtractBusinessMinutes(now, 16 * MINUTES, calendar)
  const plan = [
    { title: `ทรายและหิน ${run}`, net: '5000.00', channel: 'LINE_CHAT' as const, hours: 1 },
    { title: `สีกันสนิม ${run}`, net: '7000.00', channel: 'LIFF' as const, hours: 2 },
    { title: `เครื่องมือช่าง ${run}`, net: '8000.00', channel: 'WEB' as const, hours: 3 },
  ]
  const requests = []
  for (const [i, p] of plan.entries()) {
    const r = await sentAt(requester.id, line.id, p.title, p.net, addBusinessMinutes(start, i * 30, calendar))
    must('decide', await decideTask(memberCtx(r.approver.id, addBusinessMinutes(addBusinessMinutes(start, i * 30, calendar), p.hours * MINUTES, calendar), p.channel), { taskId: r.taskId, decision: 'APPROVE' }, key()))
    requests.push({ id: r.id, number: r.number, title: r.title, taskId: r.taskId, channel: p.channel, approver: r.approver })
  }
  await leaveBellsAsTheyWere()
  const from = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.parse(`${today}T00:00:00Z`) - 59 * 24 * 60 * MINUTES * 1000))
  const version = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: requests[0]!.id }, select: { ruleCode: true, doaVersionId: true, doaVersion: { select: { code: true, versionNo: true } } } })
  console.log(
    JSON.stringify({
      run,
      requester: { code: requester.code, email: requester.email, name: requester.name },
      requests,
      doa: { versionId: version.doaVersionId, code: version.doaVersion.code, versionNo: version.doaVersion.versionNo, ruleCode: version.ruleCode },
      kpi: { from, to: today, ...(await lineShare(from, today)) },
    }),
  )
} else if (command === 'settle') {
  const since = new Date(args[0] ?? '')
  if (Number.isNaN(since.getTime())) throw new Error('settle needs the ISO time the test started')
  const unread = await prisma.notification.findMany({ where: { organizationId, readAt: null, createdAt: { gte: since } }, select: { id: true, recipientMemberId: true } })
  const byRecipient = new Map<string, string[]>()
  for (const n of unread) byRecipient.set(n.recipientMemberId, [...(byRecipient.get(n.recipientMemberId) ?? []), n.id])
  for (const [recipient, ids] of byRecipient) must('mark read', await markNotificationsRead(memberCtx(recipient), { notificationIds: ids }, key()))
  console.log(JSON.stringify({ settled: unread.length }))
} else {
  throw new Error(`unknown command ${command}: board <project> | decisions <project> | settle <since ISO>`)
}
await prisma.$disconnect()
