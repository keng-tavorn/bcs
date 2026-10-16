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

// Run by tests/e2e/budget-split.spec.ts against the e2e database only (S6-17 · FR-BUD-102). Each run makes its own
// requester in a department of its project — CON for desktop, IT for mobile — and two budget lines of that department
// (codes carry the project and a run id, imported through the template by a budget admin of this run, as the import
// page does), so the requester may use both; and a draft on the first budget line with two lines: 1 × 1,000.01 (whose
// halves round to 500.01 each, 0.01 above the line) and 1 × 2,000.00. `cleanup` cancels the request (giving back what
// it reserved and closing the approver's task) and marks every notice about it read, so no inbox or bell of another
// spec changes. Prints one JSON line last.
//   setup <project>        the requester, the budget lines and the draft
//   cleanup <requestId>    the request cancelled, the notices read
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the budget split scene runs in the e2e database only')
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
const thaiDay = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

async function freshMember(code: string, nameTh: string, departmentCode: string, withRole = false) {
  const department = await prisma.department.findFirstOrThrow({ where: { organizationId, code: departmentCode }, select: { id: true } })
  const email = `${code}@demo.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: password! })
  const member = await prisma.member.create({ data: { organizationId, userId, email, displayNameTh: nameTh, employeeCode: code, status: 'ACTIVE', primaryDepartmentId: department.id } })
  if (withRole) await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey!, code), [])
  return { id: member.id, code, email, name: nameTh }
}

/** Budget lines of the department imported in one template by a budget admin of this run */
async function importedLines(run: string, departmentCode: string, rows: ReadonlyArray<{ code: string; nameTh: string; amount: string }>) {
  const budgetAdmin = await freshMember(`e2e-bsadm-${run}`, 'ผู้ดูแลงบ ทดสอบแบ่งงบ', 'FIN', true)
  const admin = await prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode: 'admin' }, select: { id: true } })
  must('grant BUDGET_ADMIN', await grantRole(memberCtx(admin.id), { memberId: budgetAdmin.id, role: 'BUDGET_ADMIN' }, key()))
  const today = thaiDay(now)
  const year = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId, status: 'OPEN', startsOn: { lte: new Date(`${today}T00:00:00Z`) }, endsOn: { gte: new Date(`${today}T00:00:00Z`) } } })
  const labels = Object.fromEntries(BUDGET_IMPORT_COLUMNS.map((c) => [c, c])) as Record<(typeof BUDGET_IMPORT_COLUMNS)[number], string>
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(await buildBudgetImportTemplate(labels)).buffer as ArrayBuffer)
  for (const r of rows) workbook.getWorksheet('Budget')!.addRow([year.code, departmentCode, `CC-${departmentCode}`, r.code, r.nameTh, '', r.amount])
  const bytes = new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer).slice().buffer as ArrayBuffer
  must('import', await importBudget(memberCtx(budgetAdmin.id), { bytes, fileName: `split-${run}.xlsx` }, key()))
  return Promise.all(rows.map((r) => prisma.budgetLine.findFirstOrThrow({ where: { organizationId, fiscalYearId: year.id, code: r.code }, select: { id: true, code: true, nameTh: true } })))
}

const [command, ...args] = process.argv.slice(2)

if (command === 'setup') {
  const mobile = args[0] === 'mobile'
  const project = mobile ? 'm' : 'd'
  const dept = mobile ? 'IT' : 'CON'
  const run = `${project}${randomUUID().slice(0, 6)}`
  const tag = run.toUpperCase()
  const requester = await freshMember(`e2e-bsreq-${run}`, `ผู้ขอ ทดสอบแบ่งงบ ${run}`, dept)
  const [first, second] = await importedLines(run, dept, [
    { code: `${dept}-E2EBS-A${tag}`, nameTh: `งบอุปกรณ์ทดสอบแบ่งงบ ${run}`, amount: '50000' },
    { code: `${dept}-E2EBS-B${tag}`, nameTh: `งบบริการทดสอบแบ่งงบ ${run}`, amount: '50000' },
  ])
  const title = `อุปกรณ์สำนักงานแบ่งงบ ${run}`
  const draft = must(
    'draft',
    await createDraft(memberCtx(requester.id), {
      requestTypeCode: 'BUY_GOODS',
      title,
      budgetLineId: first!.id,
      lines: [
        { description: 'เครื่องพิมพ์สำนักงาน', quantity: '1', uom: 'เครื่อง', unitPrice: '1000.01' },
        { description: 'ค่าติดตั้งเครือข่าย', quantity: '1', uom: 'งาน', unitPrice: '2000.00' },
      ],
    }, key()),
  )
  console.log(JSON.stringify({ requester: { code: requester.code, email: requester.email, name: requester.name }, first, second, request: { id: draft.requestId, title } }))
} else if (command === 'cleanup') {
  const requestId = args[0]!
  const request = await prisma.request.findFirst({ where: { organizationId, id: requestId }, select: { status: true, requesterMemberId: true } })
  if (request && !['CANCELLED', 'REJECTED', 'COMPLETED'].includes(request.status)) {
    must('cancel', await cancelRequest(memberCtx(request.requesterMemberId), { requestId, reason: 'จบการทดสอบแบ่งงบ' }, key()))
  }
  const unread = await prisma.notification.findMany({ where: { organizationId, readAt: null, subjectId: requestId }, select: { id: true, recipientMemberId: true } })
  const byRecipient = new Map<string, string[]>()
  for (const n of unread) byRecipient.set(n.recipientMemberId, [...(byRecipient.get(n.recipientMemberId) ?? []), n.id])
  for (const [recipient, ids] of byRecipient) must('mark read', await markNotificationsRead(memberCtx(recipient), { notificationIds: ids }, key()))
  console.log(JSON.stringify({ cleaned: true }))
} else {
  throw new Error(`unknown command ${command}: setup <project> | cleanup <requestId>`)
}
await prisma.$disconnect()
