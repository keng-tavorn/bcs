import { randomUUID } from 'node:crypto'
import { TZDate } from '@date-fns/tz'
import ExcelJS from 'exceljs'
import { formatSatang } from '@/core/money/format'
import { systemClock } from '@/lib/clock'
import { deriveSeedTotpSecret } from '@/lib/totp'
import { setEmailProvider } from '@/integrations/email-provider'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import type { StoredRole } from '@/server/authz/permissions'
import { decideTask } from '@/server/services/approvals/decide'
import { BUDGET_IMPORT_COLUMNS, buildBudgetImportTemplate, importBudget } from '@/server/services/budget/import'
import { recordInvoice } from '@/server/services/invoices'
import { grantRole } from '@/server/services/members/roles'
import { markNotificationsRead } from '@/server/services/notifications'
import { assignSupplier } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { sendPurchaseOrder } from '@/server/services/purchase-orders/send'
import { createDraft, submitRequest } from '../support/requests'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/budgets*.spec.ts against the e2e database only (S3-08, S3-04, S3-07). Every run makes its own people
// and budget lines (codes with the project and a run id), so desktop and mobile never meet and no other spec's budget
// line, task count or bell changes: the budget lines belong to FIN, whose members no other spec sends requests from
// without naming their line, and every notice this scene causes is marked read for its recipient. Everything goes
// through the services with fresh idempotency keys. Prints one JSON line last.
//   dashboard <project>          a BUDGET_ADMIN, an EXECUTIVE and a requester; a line of 40,000.00 imported, one
//                                request of 18,500.00 approved and reserving, one of 18,000.00 on a sent PO with an
//                                invoice of 10,000.00 (committed 8,000.00, actual 10,000.00): 3,500.00 left, below 10 %
//   reserve <requester> <lineId> <amount>   one more request on the line, approved (it reserves); the line's figures
//   admin <project>              a BUDGET_ADMIN, a plain member of CON, and a line of 5,000.00 to grant
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the budgets scene runs in the e2e database only')
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
/** The notices nobody has read yet before this run: the ones this run adds are the others */
const unreadBefore = new Set((await prisma.notification.findMany({ where: { organizationId, readAt: null }, select: { id: true } })).map((n) => n.id))
const memberCtx = (memberId: string): Ctx => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now })
const memberByCode = (code: string) => prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode: code }, select: { id: true } })
const local = new TZDate(now.getTime(), org.timezone)
const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`

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

/** A budget line of FIN imported by the BUDGET_ADMIN through the template, as the import page does */
async function importedLine(budgetAdminId: string, code: string, nameTh: string, amount: string) {
  const year = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId, status: 'OPEN', startsOn: { lte: new Date(`${today}T00:00:00Z`) }, endsOn: { gte: new Date(`${today}T00:00:00Z`) } } })
  const labels = Object.fromEntries(BUDGET_IMPORT_COLUMNS.map((c) => [c, c])) as Record<(typeof BUDGET_IMPORT_COLUMNS)[number], string>
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(await buildBudgetImportTemplate(labels)).buffer as ArrayBuffer)
  workbook.getWorksheet('Budget')!.addRow([year.code, 'FIN', 'CC-FIN', code, nameTh, '', amount])
  const bytes = new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer).slice().buffer as ArrayBuffer
  must('import', await importBudget(memberCtx(budgetAdminId), { bytes, fileName: `${code}.xlsx` }, key()))
  const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId, fiscalYearId: year.id, code }, select: { id: true, code: true, nameTh: true, fiscalYearId: true } })
  return { ...line, fiscalYear: { code: year.code, endsOn: year.endsOn.toISOString().slice(0, 10) } }
}

/** Whoever holds the open task of a request or PO decides it (the approver, or the delegate acting for them) */
async function approveOpenTask(subjectId: string) {
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId } } }, select: { id: true, assigneeMemberId: true } })
  must('decide', await decideTask(memberCtx(task.assigneeMemberId), { taskId: task.id, decision: 'APPROVE' }, key()))
}

async function approvedRequest(requesterId: string, budgetLineId: string, title: string, line: { description: string; quantity: string; uom: string; unitPrice: string }, extra: { urgency?: 'URGENT'; deliverySiteId?: string } = {}) {
  const draft = must('draft', await createDraft(memberCtx(requesterId), { requestTypeCode: 'BUY_GOODS', title, budgetLineId, lines: [line], ...extra }, key()))
  const sent = must('submit', await submitRequest(memberCtx(requesterId), { requestId: draft.requestId }, key()))
  await approveOpenTask(draft.requestId)
  return { id: draft.requestId, number: sent.number }
}

/** What the ledger holds in each bucket of these lines, as the screens show money */
async function ledgerFigures(lineIds: readonly string[]) {
  const entries = await prisma.budgetLedgerEntry.findMany({ where: { organizationId, budgetLineId: { in: [...lineIds] } }, select: { fromBucket: true, toBucket: true, amountSatang: true } })
  const bucket = (b: string) => entries.reduce((sum, e) => sum + (e.toBucket === b ? e.amountSatang : 0n) - (e.fromBucket === b ? e.amountSatang : 0n), 0n)
  const planned = entries.filter((e) => e.fromBucket === 'OUTSIDE').reduce((sum, e) => sum + e.amountSatang, 0n)
  return {
    planned: formatSatang(planned),
    available: formatSatang(bucket('AVAILABLE')),
    reserved: formatSatang(bucket('RESERVED')),
    committed: formatSatang(bucket('COMMITTED')),
    actual: formatSatang(bucket('ACTUAL')),
  }
}

/** Every notice this run caused for someone else is marked read through their own service call: no bell changes */
async function leaveBellsAsTheyWere(own: readonly string[]) {
  const unread = await prisma.notification.findMany({ where: { organizationId, readAt: null, recipientMemberId: { notIn: [...own] } }, select: { id: true, recipientMemberId: true } })
  const byRecipient = new Map<string, string[]>()
  for (const n of unread.filter((x) => !unreadBefore.has(x.id))) byRecipient.set(n.recipientMemberId, [...(byRecipient.get(n.recipientMemberId) ?? []), n.id])
  for (const [recipient, ids] of byRecipient) must('mark read', await markNotificationsRead(memberCtx(recipient), { notificationIds: ids }, key()))
}

const [command, ...args] = process.argv.slice(2)
const project = args[0] === 'mobile' ? 'm' : 'd'
const run = randomUUID().slice(0, 6)

if (command === 'dashboard') {
  const budgetAdmin = await freshMember(`e2e-budadm-${project}${run}`, 'ผู้ดูแลงบ ทดสอบหน้างบ', 'FIN', ['BUDGET_ADMIN'])
  const viewer = await freshMember(`e2e-budexe-${project}${run}`, 'ผู้บริหาร ทดสอบหน้างบ', 'HQ', ['EXECUTIVE'])
  const requester = await freshMember(`e2e-budreq-${project}${run}`, 'ผู้ขอ ทดสอบหน้างบ', 'FIN', [])
  const line = await importedLine(budgetAdmin.id, `FIN-E2EJ-${project.toUpperCase()}${run.toUpperCase()}`, `งบทดสอบหน้างบประมาณ ${run}`, '40000')
  // Reserved: approved and waiting in the pool without a supplier, so no consolidation round takes it
  const reserved = await approvedRequest(requester.id, line.id, `กระดาษและแฟ้มสำหรับทดสอบงบ ${run}`, { description: 'กระดาษ A4', quantity: '10', uom: 'รีม', unitPrice: '1850.00' })
  // Committed and actual: an urgent request is drafted onto a PO of its own as soon as it gets its supplier (BR-CONS-02)
  const site = await prisma.deliverySite.findFirstOrThrow({ where: { organizationId, code: 'HQ-STORE' }, select: { id: true } })
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId, code: 'S3' }, select: { id: true } })
  const ordered = await approvedRequest(requester.id, line.id, `หมึกพิมพ์สำหรับทดสอบงบ ${run}`, { description: 'หมึกพิมพ์', quantity: '6', uom: 'ตลับ', unitPrice: '3000.00' }, { urgency: 'URGENT', deliverySiteId: site.id })
  const proc = memberCtx((await memberByCode('proc_officer')).id)
  const requestLines = await prisma.requestLine.findMany({ where: { requestId: ordered.id }, select: { id: true } })
  const assigned = must('assign supplier', await assignSupplier(proc, { requestLineIds: requestLines.map((l) => l.id), supplierId: supplier.id }, key()))
  const poId = assigned.purchaseOrderIds[0]
  if (!poId || assigned.purchaseOrderIds.length !== 1) throw new Error(`the urgent request made ${assigned.purchaseOrderIds.length} POs`)
  must('submit PO', await submitPo(proc, { poId }, key()))
  await approveOpenTask(poId)
  // The PO goes nowhere: the scene's mail is dropped
  setEmailProvider({ send: async () => ({ messageId: 'e2e-budgets' }) })
  try {
    must('send PO', await sendPurchaseOrder(proc, { poId }, key()))
  } finally {
    setEmailProvider(null)
  }
  const invoiceNo = `E2E-${run.toUpperCase()}-1`
  must('invoice', await recordInvoice(memberCtx((await memberByCode('fin_officer')).id), { poId, invoiceNo, invoiceDate: today, net: '10000.00', vat: '700.00' }, key()))
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { id: true, number: true } })
  await leaveBellsAsTheyWere([budgetAdmin.id, viewer.id, requester.id])

  const lines = await prisma.budgetLine.findMany({ where: { organizationId, fiscalYearId: line.fiscalYearId }, select: { id: true, department: { select: { code: true } } } })
  console.log(
    JSON.stringify({
      viewer: { code: viewer.code, email: viewer.email },
      budgetAdmin: { code: budgetAdmin.code, email: budgetAdmin.email },
      requester: { code: requester.code, email: requester.email },
      line: { id: line.id, code: line.code, name: line.nameTh },
      fiscalYear: line.fiscalYear,
      reserved,
      ordered,
      po,
      invoiceNo,
      figures: {
        line: await ledgerFigures([line.id]),
        fin: await ledgerFigures(lines.filter((l) => l.department.code === 'FIN').map((l) => l.id)),
        total: await ledgerFigures(lines.map((l) => l.id)),
      },
    }),
  )
} else if (command === 'reserve') {
  const [requesterCode, lineId, amount] = args
  const requester = await memberByCode(requesterCode!)
  const request = await approvedRequest(requester.id, lineId!, `ของเพิ่มระหว่างดูหน้างบ ${run}`, { description: 'ของเพิ่ม', quantity: '1', uom: 'ชิ้น', unitPrice: amount! })
  await leaveBellsAsTheyWere([requester.id])
  console.log(JSON.stringify({ request, line: await ledgerFigures([lineId!]) }))
} else if (command === 'admin') {
  const budgetAdmin = await freshMember(`e2e-budadm-${project}${run}`, 'ผู้ดูแลงบ ทดสอบนำเข้า', 'FIN', ['BUDGET_ADMIN'])
  const member = await freshMember(`e2e-budmem-${project}${run}`, `สมาชิกทดสอบสิทธิ์งบ ${run}`, 'CON', [])
  const line = await importedLine(budgetAdmin.id, `FIN-E2EJ-G${project.toUpperCase()}${run.toUpperCase()}`, `งบทดสอบสิทธิ์ใช้งบ ${run}`, '5000')
  await leaveBellsAsTheyWere([budgetAdmin.id, member.id])
  console.log(
    JSON.stringify({
      run: `${project.toUpperCase()}${run.toUpperCase()}`,
      budgetAdmin: { code: budgetAdmin.code, email: budgetAdmin.email, name: budgetAdmin.name },
      member: { code: member.code, email: member.email, name: member.name },
      line: { id: line.id, code: line.code, name: line.nameTh },
      fiscalYear: line.fiscalYear,
      today,
    }),
  )
} else {
  throw new Error(`unknown command ${command}: dashboard <project> | reserve <requester> <lineId> <amount> | admin <project>`)
}
await prisma.$disconnect()
