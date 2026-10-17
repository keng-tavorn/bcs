import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { createDraft } from '@/server/services/requests'
import { verificationToken } from '@/server/verification/token'

// P1-09 (§9.9 step 4): the records the design review of phase 1 opens, read from the e2e database after the @p1demo
// scenes played on it (scripts/design-review/p1-pages.spec.ts runs this with the run's e2eEnv). Never another database.
//   targets   one record per page that takes an id, and who opens it: prints one JSON line
//   drafts    two draft requests through the services: a marketing request over what its budget line has left (for the
//             over-budget panel and /budgets/overruns/[id]) and a plain one to edit; prints one JSON line
const database = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname
if (!database.startsWith('/bcs_e2e')) throw new Error('the design review reads an e2e database only')

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'SIMEC' }, select: { id: true } })
const organizationId = org.id
const now = systemClock.now()
const codeOf = (memberId: string | null | undefined) =>
  memberId ? prisma.member.findFirst({ where: { organizationId, id: memberId }, select: { employeeCode: true } }).then((m) => m?.employeeCode ?? null) : Promise.resolve(null)

/** The open task of each kind of subject, and who holds it (one per subject type) */
async function openTasks() {
  const tasks = await prisma.approvalTask.findMany({
    where: { organizationId, status: 'OPEN' },
    orderBy: { assignedAt: 'desc' },
    select: { id: true, assignee: { select: { employeeCode: true } }, step: { select: { kind: true, route: { select: { subjectType: true } } } } },
  })
  const byKind = new Map<string, { id: string; code: string | null }>()
  for (const t of tasks) {
    const kind = `${t.step.route.subjectType}${t.step.kind === 'REVIEW' ? '_REVIEW' : ''}`
    if (!byKind.has(kind)) byKind.set(kind, { id: t.id, code: t.assignee.employeeCode })
  }
  return Object.fromEntries(byKind)
}

async function targets() {
  const uat = await prisma.organization.findFirst({ where: { sandboxOfOrganizationId: organizationId }, select: { id: true } })
  const doa = await prisma.doaVersion.findMany({ where: { organizationId }, orderBy: { versionNo: 'desc' }, select: { id: true, status: true, versionNo: true } })
  const workflows = await prisma.workflowVersion.findMany({ where: { organizationId }, orderBy: { versionNo: 'desc' }, select: { id: true, status: true, versionNo: true } })
  const transfer = await prisma.budgetTransfer.findFirst({ where: { organizationId }, orderBy: { createdAt: 'desc' }, select: { id: true, submittedById: true } })
  const invoiceOf = (status: 'EXCEPTION' | 'DRAFT' | 'READY_FOR_PAYMENT') =>
    prisma.invoice.findFirst({ where: { organizationId, status }, orderBy: { createdAt: 'desc' }, select: { id: true, poId: true } })
  const [exception, draftInvoice, ready] = await Promise.all([invoiceOf('EXCEPTION'), invoiceOf('DRAFT'), invoiceOf('READY_FOR_PAYMENT')])
  const runs = await prisma.paymentRun.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } })
  // A sent PO with invoices and one still waiting for its goods (procurement's page, the change form and receiving)
  const poWithInvoices = exception?.poId ?? ready?.poId ?? null
  const sentPo = await prisma.purchaseOrder.findFirst({ where: { organizationId, status: 'SENT', goodsReceipts: { none: {} } }, orderBy: { sentAt: 'desc' }, select: { id: true } })
  const flagged = await prisma.requestFlag.findFirst({ where: { organizationId }, orderBy: { createdAt: 'desc' }, select: { requestId: true } })
  const flaggedRequest = flagged
    ? await prisma.request.findFirst({ where: { organizationId, id: flagged.requestId }, select: { id: true, requesterMemberId: true } })
    : null
  const supplier = await prisma.bankAccount.findFirst({ where: { organizationId, supplierId: { not: null }, supersededAt: null, closedAt: null }, select: { supplierId: true } })
  const verification = await prisma.documentVerification.findFirst({ where: { organizationId, supersededAt: null }, orderBy: { issuedAt: 'desc' }, select: { id: true } })
  const passkey = await prisma.memberPasskey.findFirst({ where: { organizationId, revokedAt: null }, select: { memberId: true } })
  const chat = await prisma.chatIntake.findFirst({ where: { organizationId, requestId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { requestId: true, memberId: true } })
  const chatRequest = chat?.requestId ? await prisma.request.findFirst({ where: { organizationId, id: chat.requestId }, select: { id: true, status: true } }) : null
  return {
    simec: organizationId,
    uat: uat?.id ?? null,
    doa: doa.map((d) => ({ id: d.id, status: d.status, versionNo: d.versionNo })),
    workflows: workflows.map((w) => ({ id: w.id, status: w.status, versionNo: w.versionNo })),
    transfer: transfer ? { id: transfer.id, by: await codeOf(transfer.submittedById) } : null,
    invoices: { exception: exception?.id ?? null, draft: draftInvoice?.id ?? null, ready: ready?.id ?? null },
    paymentRun: runs[0]?.id ?? null,
    poWithInvoices,
    sentPo: sentPo?.id ?? null,
    flaggedRequest: flaggedRequest ? { id: flaggedRequest.id, by: await codeOf(flaggedRequest.requesterMemberId) } : null,
    supplierWithAccount: supplier?.supplierId ?? null,
    verificationToken: verification ? verificationToken(verification.id) : null,
    passkeyHolder: await codeOf(passkey?.memberId),
    chatRequest: chatRequest ? { id: chatRequest.id, status: chatRequest.status, by: await codeOf(chat?.memberId) } : null,
    tasks: await openTasks(),
  }
}

/** A draft request of a member through the services, as the request form saves one */
async function draftOf(code: string, title: string, unitPrice: string, budgetLineId?: string) {
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode: code }, select: { id: true } })
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now })
  const r = await createDraft(ctx, { requestTypeCode: 'BUY_GOODS', title, budgetLineId, lines: [{ description: title, quantity: '1', uom: 'งาน', unitPrice }] }, { idempotencyKey: randomUUID(), sender: null })
  if (!r.ok) throw new Error(`draft of ${code}: ${JSON.stringify(r.error)}`)
  return r.data.requestId
}

async function drafts(overCode: string, editCode: string) {
  // The open line of the requester's department with the least left this fiscal year: the draft asks 5,000.00 more
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode: overCode }, select: { primaryDepartmentId: true } })
  const lines = await prisma.budgetLine.findMany({
    where: { organizationId, departmentId: member.primaryDepartmentId ?? undefined, status: 'OPEN', fiscalYear: { status: 'OPEN', startsOn: { lte: now }, endsOn: { gte: now } } },
    select: { id: true, code: true, balance: { select: { availableSatang: true } } },
  })
  const line = lines.filter((l) => l.balance).sort((a, b) => (a.balance!.availableSatang < b.balance!.availableSatang ? -1 : 1))[0]
  if (!line) throw new Error(`no open budget line for ${overCode}'s department`)
  const over = line.balance!.availableSatang + 500_000n
  const price = `${over / 100n}.${String(over % 100n).padStart(2, '0')}`
  const overRequest = await draftOf(overCode, 'ค่าจัดบูธงานแสดงสินค้า (ตรวจดีไซน์)', price, line.id)
  const editRequest = await draftOf(editCode, 'อุปกรณ์ความปลอดภัยหน้างาน (ตรวจดีไซน์)', '12500.00')
  return { over: { id: overRequest, line: line.code }, edit: { id: editRequest } }
}

const [command, ...args] = process.argv.slice(2)
const out =
  command === 'targets'
    ? await targets()
    : command === 'drafts' && args[0] && args[1]
      ? await drafts(args[0], args[1])
      : (() => {
          throw new Error('usage: targets | drafts <over-budget requester> <requester of the draft to edit>')
        })()
console.log(JSON.stringify(out))
await prisma.$disconnect()
