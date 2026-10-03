import { randomInt, randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { recordInvoice } from '@/server/services/invoices'
import { markNotificationsRead } from '@/server/services/notifications'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { closePurchaseOrder, submitPo } from '@/server/services/purchase-orders'
import { sendPurchaseOrder } from '@/server/services/purchase-orders/send'
import { postGoodsReceipt } from '@/server/services/receiving'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createSupplier, updateSupplier } from '@/server/services/suppliers'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/finance*.spec.ts against the e2e database only (unit g: S4-08, S4-17, S4-09): sent, received and
// closed POs for the finance screens, and invoices recorded for the export screen — everything through the services
// with fresh idempotency keys, from today's date, the POs e-mailed to their supplier (Mailpit). Every scenario takes a
// tag (the Playwright project and a random part) so desktop and mobile, and two runs, never share a record. Prints what
// the spec needs as one line of JSON last.
//   demo <tag>            demo scene 7 then 8 (Demo_Script): the request of scene 1 (req_con, plywood and nails, 42,000
//                         before VAT) and one like H11 (asst_con, PPE, 12,000) on one PO of S1 at SITE-A (54,000),
//                         approved by the COO and e-mailed; receiver_con then takes 12 of the 20 sheets and all the PPE
//   received <tag>        a PO of S3 for 10 items at 1,000 (urgent: drafted at once, BR-CONS-02), sent and received in full
//   closed <tag>          a PO of S3 for 2 items at 500, received and closed by procurement before any invoice: it keeps
//                         the 1,000 received and not invoiced (BR-BUD-06)
//   sent <tag>            a PO of S1 for 2 items at 10,000, sent, nothing received (the e-Tax files of the spec)
//   export <tag>          a new supplier without an Express vendor code (procurement adds it after the registry check)
//                         and S3, a sent PO of each, and FINANCE's invoice on each — one kept out of the Express file;
//                         and a third PO of S3, sent, whose invoice comes later (the `invoice` scenario)
//   invoice <poId> <no>   FINANCE records invoice <no> on the PO: 1,000 before VAT and 70 VAT, dated today
//   vendor-code <id> <tag> procurement fills the Express vendor code of supplier <id>
//   close <poId>          procurement closes the PO
// The approvers, receivers and requesters open what the scene sent them (notification.mark_read as each of them), so
// no bell of another spec counts this scene's notifications (tests/e2e/notifications.spec.ts counts vp_ops' and
// vp_sup's). Requests stay below the VP's band except demo scene 1's, as the Demo_Script has it.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the finance scene runs in the e2e database only')

const startedAt = new Date()
const now = systemClock.now()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
function ok<T>(r: { ok: true; data: T } | { ok: false; error: unknown }, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${JSON.stringify(r.error)}`)
  return r.data
}

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const memberId = async (code: string) => (await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode: code }, select: { id: true } })).id
const ctxOf = async (code: string) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: await memberId(code) }, channel: 'WEB', now })
const supplierId = async (code: string) => (await prisma.supplier.findFirstOrThrow({ where: { organizationId: org.id, code }, select: { id: true } })).id
const siteId = async (code: string) => (await prisma.deliverySite.findFirstOrThrow({ where: { organizationId: org.id, code }, select: { id: true } })).id
/** Today in Thai time, as an invoice date */
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

/** The budget line `preferred` when it has `netBaht` left, else `fallback` (other specs spend the same lines) */
async function budgetLine(preferred: string, fallback: string, netBaht: bigint): Promise<{ id: string; code: string }> {
  for (const code of [preferred, fallback]) {
    const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.id, code }, select: { id: true, code: true } })
    const balance = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: line.id }, select: { availableSatang: true } })
    if (balance.availableSatang >= netBaht * 100n) return line
  }
  throw new Error(`no budget left on ${preferred} or ${fallback}`)
}

/** Decides every open task of a document with its assignee until none is left */
async function approveAll(subjectId: string) {
  for (let i = 0; i < 5; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } }, select: { id: true, assignee: { select: { employeeCode: true } } } })
    if (!task) return
    ok(await decideTask(await ctxOf(task.assignee.employeeCode!), { taskId: task.id, decision: 'APPROVE' }, key()), 'approve')
  }
}

type LineSpec = { readonly description: string; readonly quantity: string; readonly uom: string; readonly unitPrice: string }

async function approvedRequest(spec: { requester: string; title: string; site: string; urgent?: boolean; suggested?: string; budget: { id: string }; lines: readonly LineSpec[] }) {
  const ctx = await ctxOf(spec.requester)
  const draft = ok(
    await createDraft(
      ctx,
      {
        requestTypeCode: 'BUY_GOODS',
        title: spec.title,
        budgetLineId: spec.budget.id,
        deliverySiteId: await siteId(spec.site),
        ...(spec.suggested ? { suggestedSupplierId: await supplierId(spec.suggested) } : {}),
        urgency: spec.urgent ? 'URGENT' : 'NORMAL',
        lines: spec.lines.map((l) => ({ ...l })),
      },
      key(),
    ),
    'draft',
  )
  const sent = ok(await submitRequest(ctx, { requestId: draft.requestId }, key()), 'submit')
  await approveAll(draft.requestId)
  const request = await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId }, select: { status: true, lines: { orderBy: { lineNo: 'asc' }, select: { id: true } } } })
  if (request.status !== 'APPROVED') throw new Error(`request ${sent.number} is ${request.status}`)
  return { id: draft.requestId, number: sent.number, lineIds: request.lines.map((l) => l.id) }
}

/** Sends the drafted PO for approval, has it approved and e-mails it to the supplier */
async function approveAndSend(poId: string) {
  const submitted = ok(await submitPo(await ctxOf('proc_officer'), { poId }, key()), 'submit PO')
  await approveAll(poId)
  const mailed = ok(await sendPurchaseOrder(await ctxOf('proc_officer'), { poId }, key()), 'send PO')
  if (!mailed.sent) throw new Error(`the PO e-mail bounced: ${mailed.bounce}`)
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { status: true, lines: { orderBy: { lineNo: 'asc' }, select: { id: true, description: true } } } })
  if (po.status !== 'SENT') throw new Error(`the PO is ${po.status}, not SENT`)
  return { poId, number: submitted.number, lines: po.lines }
}

/** An urgent request of req_con on its own PO of `supplier` at once (BR-CONS-02), approved and sent */
async function sentUrgentPo(tag: string, supplier: string, item: string, quantity: string, unitPrice: string) {
  const net = BigInt(quantity) * BigInt(unitPrice.split('.')[0]!)
  const request = await approvedRequest({
    requester: 'req_con',
    title: `${item} (${tag})`,
    site: 'HQ-STORE',
    urgent: true,
    budget: await budgetLine('CON-CAPEX-2569', 'CON-OPEX-2569', net + 1n),
    lines: [{ description: `${item} (${tag})`, quantity, uom: 'ชิ้น', unitPrice }],
  })
  const assigned = ok(await assignSupplier(await ctxOf('proc_officer'), { requestLineIds: request.lineIds, supplierId: await supplierId(supplier) }, key()), 'assign')
  const [poId] = assigned.purchaseOrderIds
  if (!poId || assigned.purchaseOrderIds.length !== 1) throw new Error(`expected one draft of an urgent request, got ${JSON.stringify(assigned)}`)
  return { ...(await approveAndSend(poId)), request: request.number }
}

const receive = async (poId: string, lines: Array<{ poLineId: string; received: string }>, note: string) =>
  ok(await postGoodsReceipt(await ctxOf('receiver_con'), { poId, deliveryNoteNo: note, lines }, key()), 'receive')

const invoice = async (poId: string, invoiceNo: string, net: string, vat: string) =>
  ok(await recordInvoice(await ctxOf('fin_officer'), { poId, invoiceNo, invoiceDate: today, net, vat }, key()), 'invoice')

const [scenario, arg1, arg2] = process.argv.slice(2)
const tag = (scenario === 'vendor-code' || scenario === 'invoice' ? arg2 : arg1) ?? 'e2e'
let out: unknown
switch (scenario) {
  case 'demo': {
    // Demo_Script scene 7: scene 1's request and one like H11, both at SITE-A with S1 suggested, on one PO of S1
    const budget = await budgetLine('CON-OPEX-2569', 'CON-CAPEX-2569', 54_000n)
    const scene1 = await approvedRequest({
      requester: 'req_con',
      title: `ไม้อัดและตะปู (${tag})`,
      site: 'SITE-A',
      suggested: 'S1',
      budget,
      lines: [
        { description: 'ไม้อัด 4 มม.', quantity: '20', uom: 'แผ่น', unitPrice: '1500.00' },
        { description: 'ตะปูตอกไม้ 2 นิ้ว', quantity: '120', uom: 'กล่อง', unitPrice: '100.00' },
      ],
    })
    const h11 = await approvedRequest({
      requester: 'asst_con',
      title: `อุปกรณ์ความปลอดภัย PPE (${tag})`,
      site: 'SITE-A',
      suggested: 'S1',
      budget,
      lines: [{ description: 'หมวกนิรภัยและเสื้อสะท้อนแสง', quantity: '40', uom: 'ชุด', unitPrice: '300.00' }],
    })
    const lineIds = [...scene1.lineIds, ...h11.lineIds]
    ok(await assignSupplier(await ctxOf('proc_officer'), { requestLineIds: lineIds, supplierId: await supplierId('S1') }, key()), 'assign')
    // "รวมเป็นร่าง PO ตอนนี้" (FR-P2P-002 AC3): the two requests make one draft (same supplier, site and kind)
    const round = ok(await consolidateNow(await ctxOf('proc_officer'), key()), 'consolidate')
    const draft = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...round.purchaseOrderIds] }, lines: { some: { sources: { some: { requestLineId: { in: lineIds } } } } } }, select: { id: true } })
    const po = await approveAndSend(draft.id)
    if (po.lines.length !== 3) throw new Error(`the demo PO has ${po.lines.length} lines, not 3`)
    // Demo_Script scene 8: 12 of the 20 sheets of plywood and all the PPE came
    const [plywood, , ppe] = po.lines
    await receive(
      po.poId,
      [
        { poLineId: plywood!.id, received: '12' },
        { poLineId: ppe!.id, received: '40' },
      ],
      `DN-${tag}`,
    )
    out = { poId: po.poId, number: po.number, requests: [scene1.number, h11.number], budgetLine: budget.code, today }
    break
  }
  case 'received': {
    const po = await sentUrgentPo(tag, 'S3', 'ชุดเครื่องมือช่าง', '10', '1000.00')
    await receive(po.poId, [{ poLineId: po.lines[0]!.id, received: '10' }], `DN-${tag}`)
    out = { ...po, today }
    break
  }
  case 'closed': {
    const po = await sentUrgentPo(tag, 'S3', 'ถังน้ำยาทำความสะอาด', '2', '500.00')
    await receive(po.poId, [{ poLineId: po.lines[0]!.id, received: '2' }], `DN-${tag}`)
    ok(await closePurchaseOrder(await ctxOf('proc_officer'), { poId: po.poId }, key()), 'close')
    out = { ...po, today }
    break
  }
  case 'sent': {
    out = { ...(await sentUrgentPo(tag, 'S1', 'แบบหล่อเหล็ก', '2', '9000.00')), today }
    break
  }
  case 'export': {
    // A supplier the registry knows, at a branch of its own, with no Express vendor code yet (BR-EXP-04)
    const code = `FIN-${randomUUID().slice(0, 6).toUpperCase()}`
    const branchCode = String(randomInt(10000, 99999))
    const nameTh = `บริษัท เครื่องมือช่างทดสอบ จำกัด ${code.slice(-4)}`
    const created = ok(
      await createSupplier(await ctxOf('proc_officer'), { code, nameTh, taxId: '0999999000098', branchCode, isVatRegistered: true, email: `${code.toLowerCase()}@supplier.demo.local`, category: 'เครื่องมือช่าง', registry: { check: 'LOOKUP' } }, key()),
      'supplier',
    )
    const held = await sentUrgentPo(tag, code, 'สว่านไฟฟ้า', '1', '2000.00')
    const ready = await sentUrgentPo(tag, 'S3', 'ไม้กวาดและถังขยะ', '1', '1000.00')
    const late = await sentUrgentPo(tag, 'S3', 'ถุงมือผ้า', '1', '1000.00')
    const heldInvoiceNo = `EXH-${tag}`
    const readyInvoiceNo = `EXR-${tag}`
    await invoice(held.poId, heldInvoiceNo, '2000.00', '140.00')
    await invoice(ready.poId, readyInvoiceNo, '1000.00', '70.00')
    out = { supplier: { id: created.supplierId, code, nameTh }, held: { ...held, invoiceNo: heldInvoiceNo }, ready: { ...ready, invoiceNo: readyInvoiceNo }, late: { poId: late.poId, number: late.number }, today }
    break
  }
  case 'invoice': {
    out = await invoice(arg1!, arg2!, '1000.00', '70.00')
    break
  }
  case 'vendor-code': {
    const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId: org.id, id: arg1 }, select: { id: true, version: true } })
    const code = `V-${tag.toUpperCase()}`.slice(0, 40)
    ok(await updateSupplier(await ctxOf('proc_officer'), { supplierId: supplier.id, expectedVersion: supplier.version, expressVendorCode: code }, key()), 'vendor code')
    out = { code }
    break
  }
  case 'close': {
    out = ok(await closePurchaseOrder(await ctxOf('proc_officer'), { poId: arg1! }, key()), 'close')
    break
  }
  default:
    throw new Error(`unknown scenario ${scenario}`)
}

// Everyone this scene notified opens what it sent them (only notifications made since the scene started)
const unread = await prisma.notification.findMany({ where: { organizationId: org.id, readAt: null, createdAt: { gte: startedAt } }, select: { id: true, recipientMemberId: true } })
const byRecipient = new Map<string, string[]>()
for (const n of unread) byRecipient.set(n.recipientMemberId, [...(byRecipient.get(n.recipientMemberId) ?? []), n.id])
for (const [recipient, ids] of byRecipient) {
  const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: recipient }, channel: 'WEB', now })
  for (let i = 0; i < ids.length; i += 100) ok(await markNotificationsRead(ctx, { notificationIds: ids.slice(i, i + 100) }, key()), 'mark read')
}

await prisma.$disconnect()
console.log(JSON.stringify(out))
