import { randomUUID } from 'node:crypto'
import { TZDate } from '@date-fns/tz'
import ExcelJS from 'exceljs'
import { formatSatang } from '@/core/money/format'
import { systemClock } from '@/lib/clock'
import { deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import type { StoredRole } from '@/server/authz/permissions'
import { BUDGET_IMPORT_COLUMNS, buildBudgetImportTemplate, importBudget } from '@/server/services/budget/import'
import { createBudgetTransfer } from '@/server/services/budget/transfers'
import { grantRole } from '@/server/services/members/roles'
import { markNotificationsRead } from '@/server/services/notifications'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/budget-transfer.spec.ts against the e2e database only (S6-15 · FR-BUD-103). The DEMO organization's
// DOA has no BUDGET_TRANSFER rule, and this scene never adds one (other specs count on the DOA's version numbers): it
// makes a BUDGET_ADMIN of its own, two FIN lines imported through the template (codes with the project and a run id, so
// desktop and mobile never meet), and one DRAFT transfer between them — a draft reserves nothing and starts no route.
// Every notice it causes is marked read for its recipient. Everything goes through the services with fresh
// idempotency keys. Prints one JSON line last.
//   setup <project>      the BUDGET_ADMIN, the lines (5,000.00 and 1,000.00) and a draft TRANSFER of 300.00 between them
//   figures <lineId>     what the ledger holds for the line, as the screens show money (no reservation after a refusal)
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the budget transfer scene runs in the e2e database only')
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
const unreadBefore = new Set((await prisma.notification.findMany({ where: { organizationId, readAt: null }, select: { id: true } })).map((n) => n.id))
const memberCtx = (memberId: string): Ctx => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now })
const local = new TZDate(now.getTime(), org.timezone)
const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`

async function freshMember(code: string, nameTh: string, departmentCode: string, roles: readonly StoredRole[]) {
  const department = await prisma.department.findFirstOrThrow({ where: { organizationId, code: departmentCode }, select: { id: true } })
  const email = `${code}@demo.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: password! })
  const member = await prisma.member.create({ data: { organizationId, userId, email, displayNameTh: nameTh, employeeCode: code, status: 'ACTIVE', primaryDepartmentId: department.id } })
  if (roles.length) await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey!, code), [])
  const admin = await prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode: 'admin' }, select: { id: true } })
  for (const role of roles) must(`grant ${role}`, await grantRole(memberCtx(admin.id), { memberId: member.id, role }, key()))
  return { id: member.id, code, email, name: nameTh }
}

/** Budget lines of FIN imported by the BUDGET_ADMIN through the template in one file, as the import page does */
async function importedLines(budgetAdminId: string, rows: ReadonlyArray<{ code: string; nameTh: string; amount: string }>) {
  const year = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId, status: 'OPEN', startsOn: { lte: new Date(`${today}T00:00:00Z`) }, endsOn: { gte: new Date(`${today}T00:00:00Z`) } } })
  const labels = Object.fromEntries(BUDGET_IMPORT_COLUMNS.map((c) => [c, c])) as Record<(typeof BUDGET_IMPORT_COLUMNS)[number], string>
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(await buildBudgetImportTemplate(labels)).buffer as ArrayBuffer)
  for (const r of rows) workbook.getWorksheet('Budget')!.addRow([year.code, 'FIN', 'CC-FIN', r.code, r.nameTh, '', r.amount])
  const bytes = new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer).slice().buffer as ArrayBuffer
  must('import', await importBudget(memberCtx(budgetAdminId), { bytes, fileName: `${rows[0]!.code}.xlsx` }, key()))
  return Promise.all(rows.map((r) => prisma.budgetLine.findFirstOrThrow({ where: { organizationId, fiscalYearId: year.id, code: r.code }, select: { id: true, code: true, nameTh: true } })))
}

/** What the ledger holds for a line, as the screens show money */
async function figures(lineId: string) {
  const entries = await prisma.budgetLedgerEntry.findMany({ where: { organizationId, budgetLineId: lineId }, select: { fromBucket: true, toBucket: true, amountSatang: true } })
  const bucket = (b: string) => entries.reduce((sum, e) => sum + (e.toBucket === b ? e.amountSatang : 0n) - (e.fromBucket === b ? e.amountSatang : 0n), 0n)
  return { available: formatSatang(bucket('AVAILABLE')), reserved: formatSatang(bucket('RESERVED')) }
}

async function leaveBellsAsTheyWere(own: readonly string[]) {
  const unread = await prisma.notification.findMany({ where: { organizationId, readAt: null, recipientMemberId: { notIn: [...own] } }, select: { id: true, recipientMemberId: true } })
  const byRecipient = new Map<string, string[]>()
  for (const n of unread.filter((x) => !unreadBefore.has(x.id))) byRecipient.set(n.recipientMemberId, [...(byRecipient.get(n.recipientMemberId) ?? []), n.id])
  for (const [recipient, ids] of byRecipient) must('mark read', await markNotificationsRead(memberCtx(recipient), { notificationIds: ids }, key()))
}

const [command, ...args] = process.argv.slice(2)

if (command === 'setup') {
  const project = args[0] === 'mobile' ? 'M' : 'D'
  const run = randomUUID().slice(0, 6).toUpperCase()
  const budgetAdmin = await freshMember(`e2e-btadm-${project.toLowerCase()}${run.toLowerCase()}`, `ผู้ดูแลงบ ทดสอบโอนงบ ${run}`, 'FIN', ['BUDGET_ADMIN'])
  const [from, to] = await importedLines(budgetAdmin.id, [
    { code: `FIN-E2EBT-A${project}${run}`, nameTh: `งบทดสอบโอนออก ${run}`, amount: '5000' },
    { code: `FIN-E2EBT-B${project}${run}`, nameTh: `งบทดสอบโอนเข้า ${run}`, amount: '1000' },
  ])
  const draft = must('draft', await createBudgetTransfer(memberCtx(budgetAdmin.id), { kind: 'TRANSFER', fromBudgetLineId: from!.id, toBudgetLineId: to!.id, amount: '300.00', reason: `ย้ายงบทดสอบ ${run}` }, key()))
  await leaveBellsAsTheyWere([budgetAdmin.id])
  console.log(JSON.stringify({ budgetAdmin: { code: budgetAdmin.code, email: budgetAdmin.email }, from, to, transferId: draft.transferId, reason: `ย้ายงบทดสอบ ${run}` }))
} else if (command === 'figures') {
  console.log(JSON.stringify(await figures(args[0]!)))
} else {
  throw new Error(`unknown command ${command}: setup <project> | figures <lineId>`)
}
await prisma.$disconnect()
