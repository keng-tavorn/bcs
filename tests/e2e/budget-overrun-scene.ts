import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { systemClock } from '@/lib/clock'
import { deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { BUDGET_IMPORT_COLUMNS, buildBudgetImportTemplate, importBudget } from '@/server/services/budget/import'
import { grantRole } from '@/server/services/members/roles'
import { markNotificationsRead } from '@/server/services/notifications'
import { cancelRequest, createDraft } from '../support/requests'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/budget-overrun.spec.ts against the e2e database only (S6-16 · FR-BUD-101). The DEMO organization's
// DOA has no OVER_BUDGET rule (the integration tests prove the button stays away without it): for the time of one test
// this scene adds one rule to the DOA version in effect — its one step copied from the first step of the version's
// lowest PURCHASE_REQUEST rule, so the department's own approver decides — and `cleanup` takes it out again; it never
// publishes a version (other specs count on the DOA's version numbers). Each run makes its own requester and budget line
// (codes carry the project and a run id) in a department of its project — CON for desktop, IT for mobile — and a draft
// request of 6,000.00 on a line of 5,000.00, so it is 1,000.00 short. `cleanup` cancels the request (closing the
// approver's task) and marks every notice about it read, so no inbox or bell of another spec changes. Prints one JSON
// line last.
//   setup <project>               the rule, the requester, the line and the draft
//   task <overrunId|requestId>    the open task of an overrun or a request, and its assignee
//   cleanup <ruleId> <requestId>  the rule out, the request cancelled, the notices read
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the over-budget scene runs in the e2e database only')
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
const memberCtx = (memberId: string): Ctx => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now })
const memberByCode = (code: string) => prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode: code }, select: { id: true } })
const thaiDay = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

async function freshMember(code: string, nameTh: string, departmentCode: string, withRole = false) {
  const department = await prisma.department.findFirstOrThrow({ where: { organizationId, code: departmentCode }, select: { id: true } })
  const email = `${code}@demo.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: password! })
  const member = await prisma.member.create({ data: { organizationId, userId, email, displayNameTh: nameTh, employeeCode: code, status: 'ACTIVE', primaryDepartmentId: department.id } })
  if (withRole) await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey!, code), [])
  return { id: member.id, code, email, name: nameTh }
}

/** A budget line of the department imported through the template by a budget admin of this run, as the import page does */
async function importedLine(departmentCode: string, code: string, nameTh: string, amount: string) {
  const budgetAdmin = await freshMember(`e2e-obadm-${code.toLowerCase()}`, 'ผู้ดูแลงบ ทดสอบเกินงบ', 'FIN', true)
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
  return prisma.budgetLine.findFirstOrThrow({ where: { organizationId, fiscalYearId: year.id, code }, select: { id: true, code: true, nameTh: true } })
}

/** The DOA version in effect now, as the route resolves it */
async function versionInEffect() {
  return prisma.doaVersion.findFirstOrThrow({
    where: { organizationId, status: { in: ['PUBLISHED', 'SUPERSEDED'] }, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    orderBy: { effectiveFrom: 'desc' },
    select: { id: true, rules: { where: { documentType: 'PURCHASE_REQUEST' }, orderBy: { priority: 'asc' }, select: { code: true, when: true, steps: true, priority: true } } },
  })
}

/** The open task of an overrun's or a request's route, and who holds it */
async function openTask(subjectId: string) {
  const task = await prisma.approvalTask.findFirstOrThrow({
    where: { organizationId, status: 'OPEN', step: { route: { subjectId } } },
    select: { id: true, assignee: { select: { employeeCode: true, email: true, displayNameTh: true, user: { select: { twoFactorEnabled: true } } } } },
  })
  return { taskId: task.id, code: task.assignee.employeeCode, email: task.assignee.email, name: task.assignee.displayNameTh, totp: task.assignee.user?.twoFactorEnabled === true }
}

const [command, ...args] = process.argv.slice(2)

if (command === 'setup') {
  const mobile = args[0] === 'mobile'
  const project = mobile ? 'm' : 'd'
  const dept = mobile ? 'IT' : 'CON'
  const run = randomUUID().slice(0, 6)
  // The rule: one step like the first step of the lowest purchase-request rule, for any shortfall
  const version = await versionInEffect()
  const lowest = version.rules.find((r) => {
    const amount = (r.when as { amount?: { gt?: string; gte?: string } }).amount
    return !amount || ((amount.gt ?? amount.gte ?? '0') === '0')
  }) ?? version.rules[0]
  if (!lowest) throw new Error('the DOA in effect has no purchase-request rule to copy a step from')
  const steps = lowest.steps as unknown[]
  const rule = await prisma.doaRule.create({
    data: { organizationId, doaVersionId: version.id, code: `OB-E2E-${project.toUpperCase()}${run.toUpperCase()}`, documentType: 'OVER_BUDGET', priority: 1, when: {}, steps: [steps[0]] as object[], descriptionTh: 'ขออนุมัติเกินงบ (ทดสอบ e2e)' },
  })
  const requester = await freshMember(`e2e-obreq-${project}${run}`, `ผู้ขอ ทดสอบเกินงบ ${run}`, dept)
  const line = await importedLine(dept, `${dept}-E2EOB-${project.toUpperCase()}${run.toUpperCase()}`, `งบทดสอบเกินงบ ${run}`, '5000')
  const title = `ค่าจัดงานเปิดตัว ${run}`
  const draft = must('draft', await createDraft(memberCtx(requester.id), { requestTypeCode: 'BUY_GOODS', title, budgetLineId: line.id, lines: [{ description: 'ค่าจัดงานเปิดตัว', quantity: '1', uom: 'งาน', unitPrice: '6000.00' }] }, key()))
  console.log(JSON.stringify({ ruleId: rule.id, requester: { code: requester.code, email: requester.email, name: requester.name }, line, request: { id: draft.requestId, title }, reason: `งานเปิดตัวต้องจัดในเดือนนี้ ${run}` }))
} else if (command === 'task') {
  console.log(JSON.stringify(await openTask(args[0]!)))
} else if (command === 'overrun') {
  const o = await prisma.budgetOverrun.findFirstOrThrow({ where: { organizationId, requestId: args[0]! }, orderBy: { submittedAt: 'desc' }, select: { id: true, number: true, status: true } })
  console.log(JSON.stringify(o))
} else if (command === 'cleanup') {
  const [ruleId, requestId] = args
  await prisma.doaRule.deleteMany({ where: { organizationId, id: ruleId!, documentType: 'OVER_BUDGET' } })
  const request = await prisma.request.findFirst({ where: { organizationId, id: requestId! }, select: { status: true, requesterMemberId: true } })
  if (request && !['CANCELLED', 'REJECTED', 'COMPLETED'].includes(request.status)) {
    must('cancel', await cancelRequest(memberCtx(request.requesterMemberId), { requestId: requestId!, reason: 'จบการทดสอบเกินงบ' }, key()))
  }
  const overruns = (await prisma.budgetOverrun.findMany({ where: { organizationId, requestId: requestId! }, select: { id: true } })).map((o) => o.id)
  const unread = await prisma.notification.findMany({ where: { organizationId, readAt: null, subjectId: { in: [requestId!, ...overruns] } }, select: { id: true, recipientMemberId: true } })
  const byRecipient = new Map<string, string[]>()
  for (const n of unread) byRecipient.set(n.recipientMemberId, [...(byRecipient.get(n.recipientMemberId) ?? []), n.id])
  for (const [recipient, ids] of byRecipient) must('mark read', await markNotificationsRead(memberCtx(recipient), { notificationIds: ids }, key()))
  console.log(JSON.stringify({ cleaned: true }))
} else {
  throw new Error(`unknown command ${command}: setup <project> | task <subjectId> | overrun <requestId> | cleanup <ruleId> <requestId>`)
}
await prisma.$disconnect()
