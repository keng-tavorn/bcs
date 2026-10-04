import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { grantStepUp } from '@/server/auth/step-up'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { completeUpload, requestUpload } from '@/server/services/files'
import { assignSupplier } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { sendPurchaseOrder } from '@/server/services/purchase-orders/send'
import { createDraft, submitRequest } from '@/server/services/requests'
import { attachFile } from '@/server/services/requests/attachments'
import { E2E_DB, E2E_PIN } from '../support/e2e-env'
import { ATTACHMENT_NAME, ATTACHMENT_PDF } from './tasks-attachment'

// Run by the §9.4 budget tests of the LIFF pages (liff-requests.spec.ts, liff-tasks.spec.ts, liff-gr.spec.ts) against the
// e2e database only: documents of a realistic size for a page opened with a LIFF session, whose content the server writes
// into the HTML — a request of many lines, as a construction site asks for its materials. Every step goes through the
// services, as the workspace and LINE do; prints JSON on its last line.
//   draft <memberId> <lines> <tag>      a draft of <lines> lines, made in LIFF by that member of the demo organization (a
//                                       fresh requester of tests/e2e/liff-requests-scene.ts) on a construction budget line
//                                       with room for it, delivered to SITE-A
//   sent <memberId> <lines> <tag>       the same, sent for approval from LIFF
//   twin-request <org> <lines>          in a twin of tests/e2e/liff-tasks-scene.ts: a request of <lines> lines, 100,000.00
//                                       baht with VAT in all, sent by its requester of construction (req_con) — a task for
//                                       vp_ops at the stepUpThreshold (PR-02), as the scene's one-line request
//   twin-po <org> <lines>               in that twin: an urgent request of <lines> lines, 93,457.94 baht before VAT, with
//                                       its PDF, approved by vp_ops with the PIN, drafted into its own PO by procurement and
//                                       sent for approval; prints the code of the PO task's assignee (coo, …) so the test
//                                       opens it in their LINE app
//   sent-po <requestNumber> <lines> <tag>
//                                       the member who sent that request of the demo organization (a fresh requester of
//                                       tests/e2e/receiving-scene.ts) asks in LIFF for <lines> lines, 14,900.00 baht before
//                                       VAT in all (that scene's PO, within the DM's band: no PIN), urgent: approved by
//                                       whoever holds its task, drafted into its own PO by procurement (BR-CONS-02), approved
//                                       and e-mailed to the supplier — a PO the receivers of construction receive
//                                       (/liff/gr/<poId>)
// The amounts are whole satang written as text (BR-MONEY-01): no floating point anywhere.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the LIFF budget scene runs in the e2e database only')

const now = systemClock.now()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

function must<T>(label: string, r: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`${label} failed: ${JSON.stringify(r.error)}`)
  return r.data
}

/** What a construction site asks for, one line each: a description, a unit and a price before VAT (baht) */
const MATERIALS: ReadonlyArray<readonly [description: string, uom: string, unitPrice: string]> = [
  ['ไม้อัดยาง 10 มม. 4x8 ฟุต', 'แผ่น', '385.00'],
  ['ตะปูตอกไม้ 2 นิ้ว', 'กล่อง', '65.00'],
  ['ปูนซีเมนต์ปอร์ตแลนด์ 50 กก.', 'ถุง', '145.00'],
  ['เหล็กเส้นกลม SR24 ขนาด 9 มม.', 'เส้น', '98.00'],
  ['ทรายหยาบสำหรับงานคอนกรีต', 'คิว', '520.00'],
  ['สีรองพื้นปูนใหม่กันด่าง 5 แกลลอน', 'ถัง', '1250.00'],
  ['ท่อ PVC ชั้น 8.5 ขนาด 4 หุน', 'เส้น', '72.00'],
  ['สายไฟ VAF 2x1.5 ตร.มม.', 'ม้วน', '890.00'],
  ['ลวดผูกเหล็กเบอร์ 18', 'ม้วน', '115.00'],
  ['หินคลุกสำหรับรองพื้น', 'คิว', '480.00'],
]

/** A line of the list, numbered so that no two lines of a document read the same */
const materialLine = (i: number) => {
  const [description, uom, unitPrice] = MATERIALS[i % MATERIALS.length]!
  return { description: `${description} ชุดที่ ${i + 1}`, quantity: String(1 + (i % 9)), uom, unitPrice }
}

/** Satang as the services take money: baht and two decimals */
const baht = (satang: bigint) => `${satang / 100n}.${String(satang % 100n).padStart(2, '0')}`

/** <count> lines whose unit prices add up to `totalSatang` exactly, one of each: the last line takes the remainder */
function linesSummingTo(count: number, totalSatang: bigint) {
  const each = totalSatang / BigInt(count)
  return Array.from({ length: count }, (_, i) => {
    const [description, uom] = MATERIALS[i % MATERIALS.length]!
    const price = i === count - 1 ? totalSatang - each * BigInt(count - 1) : each
    return { description: `${description} ชุดที่ ${i + 1}`, quantity: '1', uom, unitPrice: baht(price) }
  })
}

function countOf(value: string | undefined): number {
  const count = Number(value)
  if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error('the scene needs a number of lines from 1 to 200')
  return count
}

function tagOf(value: string | undefined): string {
  if (!value || !/^[a-z0-9-]{3,40}$/.test(value)) throw new Error('the scene needs a tag of lower-case letters, digits and -')
  return value
}

/** A member of the demo organization (a fresh requester of the LIFF requests scene), acting in LIFF */
async function demoMember(memberId: string | undefined) {
  if (!memberId || !/^[0-9a-f-]{36}$/.test(memberId)) throw new Error('the scene needs a member id')
  const member = await prisma.member.findUniqueOrThrow({ where: { id: memberId }, select: { id: true, organizationId: true } })
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: member.organizationId }, select: { code: true } })
  if (org.code !== 'DEMO') throw new Error('the member is not of the demo organization')
  return makeCtx({ organizationId: member.organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'LIFF', now })
}

/** A construction budget line of the organization with at least `netSatang` left: the capex line first */
async function conLineWithRoom(organizationId: string, netSatang: bigint) {
  for (const code of ['CON-CAPEX-2569', 'CON-OPEX-2569']) {
    const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId, code }, select: { id: true } })
    const balance = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: line.id }, select: { availableSatang: true } })
    if (balance.availableSatang >= netSatang) return line
  }
  throw new Error('no construction budget line has room left for the scene')
}

const netOf = (lines: ReadonlyArray<{ quantity: string; unitPrice: string }>) => lines.reduce((sum, l) => sum + BigInt(l.quantity) * BigInt(l.unitPrice.replace('.', '')), 0n)

/** A draft of `count` lines of the member, made in LIFF: its id and title */
async function demoDraft(ctx: Ctx, count: number, tag: string) {
  const lines = Array.from({ length: count }, (_, i) => materialLine(i))
  const [line, site] = await Promise.all([
    conLineWithRoom(ctx.organizationId, netOf(lines)),
    prisma.deliverySite.findFirstOrThrow({ where: { organizationId: ctx.organizationId, code: 'SITE-A' }, select: { id: true } }),
  ])
  const title = `วัสดุงานโครงสร้างไซต์ A ${count} รายการ ${tag}`
  const draft = must('draft', await createDraft(ctx, { requestTypeCode: 'BUY_GOODS', priceIncludesVat: false, title, budgetLineId: line.id, deliverySiteId: site.id, lines }, key()))
  return { requestId: draft.requestId, title }
}

/** The twin's member with this demo code (vp_ops, req_con, proc_officer, …), as tests/e2e/liff-tasks-scene.ts finds them */
async function twinMember(orgCode: string | undefined, code: string) {
  if (!orgCode || !/^ZE2E-LT-[0-9A-F]{6}$/.test(orgCode)) throw new Error('the scene needs the code of a twin of the LIFF tasks scene')
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true } })
  const member = await prisma.member.findFirst({ where: { organizationId: org.id, employeeCode: { endsWith: `_${code}` } }, select: { id: true } })
  if (!member) throw new Error(`the twin ${orgCode} has no ${code}`)
  return { id: member.id, organizationId: org.id, ctx: makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now }) }
}

const openTaskOf = (subjectType: 'REQUEST' | 'PURCHASE_ORDER', subjectId: string) =>
  prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType, subjectId } } }, select: { id: true, assigneeMemberId: true } })

/** The demo code of a twin member (the employee code is lt<run>_<code>) */
async function codeOfMember(memberId: string) {
  const member = await prisma.member.findUniqueOrThrow({ where: { id: memberId }, select: { employeeCode: true } })
  return (member.employeeCode ?? '').replace(/^lt[0-9a-f]+_/, '')
}

/** Uploads a file as the member through the presigned flow (FR-PLT-004): its id once the server read it back */
async function upload(ctx: Ctx, fileName: string, mimeType: string, bytes: Buffer): Promise<string> {
  const started = must('upload', await requestUpload(ctx, { fileName, mimeType, sizeBytes: bytes.length }))
  const put = await fetch(started.uploadUrl, { method: 'PUT', body: new Uint8Array(bytes), headers: { 'Content-Type': mimeType } })
  if (!put.ok) throw new Error(`upload failed: ${put.status}`)
  return must('upload recorded', await completeUpload(ctx, { ticket: started.ticket })).fileId
}

/**
 * The twin's request of `count` lines, 100,000.00 baht with VAT in all, sent by req_con: the open task's id. Urgent, its
 * prices are before VAT (93,457.94, as the PO of the tasks scene: a request whose prices include VAT waits in the pool,
 * TODO(NEW-50) of src/server/services/procurement/consolidate.ts) and it carries its PDF
 */
async function twinRequest(orgCode: string | undefined, count: number, urgent: boolean) {
  const requester = await twinMember(orgCode, 'req_con')
  const [budgetLine, site] = await Promise.all([
    prisma.budgetLine.findFirstOrThrow({ where: { organizationId: requester.organizationId, code: 'CON-CAPEX-2569' }, select: { id: true } }),
    prisma.deliverySite.findFirstOrThrow({ where: { organizationId: requester.organizationId, code: 'SITE-A' }, select: { id: true } }),
  ])
  const draft = must(
    'draft',
    await createDraft(
      requester.ctx,
      {
        requestTypeCode: 'BUY_GOODS',
        title: `วัสดุงานโครงสร้างไซต์ A ${count} รายการ`,
        priceIncludesVat: !urgent,
        ...(urgent ? { urgency: 'URGENT' as const } : {}),
        budgetLineId: budgetLine.id,
        deliverySiteId: site.id,
        lines: linesSummingTo(count, urgent ? 9_345_794n : 10_000_000n),
      },
      key(),
    ),
  )
  if (urgent) {
    const fileId = await upload(requester.ctx, ATTACHMENT_NAME, 'application/pdf', ATTACHMENT_PDF)
    must('attach', await attachFile(requester.ctx, { requestId: draft.requestId, fileId, kind: 'JUSTIFICATION' }, key()))
  }
  const sent = must('submit', await submitRequest(requester.ctx, { requestId: draft.requestId }, key()))
  return { requestId: draft.requestId, number: sent.number, task: await openTaskOf('REQUEST', draft.requestId) }
}

/** The demo organization's member who sent the request of this number, acting in LIFF */
async function requesterOf(number: string | undefined) {
  if (!number || !/^[\w-]{3,40}$/.test(number)) throw new Error('the scene needs a request number')
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
  const request = await prisma.request.findFirstOrThrow({ where: { organizationId: org.id, number }, select: { requesterMemberId: true } })
  return demoMember(request.requesterMemberId)
}

/** A seeded member of the organization (proc_officer, …), acting on the web */
async function seededMember(organizationId: string, employeeCode: string) {
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode }, select: { id: true } })
  return makeCtx({ organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now })
}

/** Every open task of the document, approved by whoever holds it: within the DM's band, no PIN is asked */
async function approveOpen(organizationId: string, subjectId: string) {
  for (let round = 0; round < 5; round++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } }, select: { id: true, assigneeMemberId: true } })
    if (!task) return
    if (!task.assigneeMemberId) throw new Error('an open task has no assignee')
    const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: task.assigneeMemberId }, channel: 'WEB', now })
    must('approve', await decideTask(ctx, { taskId: task.id, decision: 'APPROVE' }, key()))
  }
  throw new Error('the document still waits after five approvals')
}

/** The assignee decides the task with the PIN step-up, as the decision page asks it (FR-AUTH-005 AC2) */
async function approveWithPin(organizationId: string, task: { id: string; assigneeMemberId: string | null }, subjectType: 'REQUEST' | 'PURCHASE_ORDER', subjectId: string) {
  if (!task.assigneeMemberId) throw new Error('the task has no assignee')
  const granted = await grantStepUp({ organizationId, memberId: task.assigneeMemberId, subjectType, subjectId, method: 'PIN', pin: E2E_PIN, channel: 'WEB' }, new Date(), { sender: null })
  if (!granted.ok) throw new Error(`the PIN step-up was refused: ${granted.reason}`)
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: task.assigneeMemberId }, channel: 'WEB', now })
  must('approve', await decideTask(ctx, { taskId: task.id, decision: 'APPROVE' }, key()))
}

const [command, ...args] = process.argv.slice(2)
let result: unknown
switch (command) {
  case 'draft': {
    const ctx = await demoMember(args[0])
    result = await demoDraft(ctx, countOf(args[1]), tagOf(args[2]))
    break
  }
  case 'sent': {
    const ctx = await demoMember(args[0])
    const draft = await demoDraft(ctx, countOf(args[1]), tagOf(args[2]))
    const sent = must('submit', await submitRequest(ctx, { requestId: draft.requestId }, key()))
    result = { requestId: draft.requestId, number: sent.number, title: draft.title }
    break
  }
  case 'twin-request': {
    const made = await twinRequest(args[0], countOf(args[1]), false)
    result = { requestId: made.requestId, number: made.number, taskId: made.task.id }
    break
  }
  case 'twin-po': {
    const made = await twinRequest(args[0], countOf(args[1]), true)
    const procurement = await twinMember(args[0], 'proc_officer')
    await approveWithPin(procurement.organizationId, made.task, 'REQUEST', made.requestId)
    const requestLines = await prisma.requestLine.findMany({ where: { requestId: made.requestId }, orderBy: { lineNo: 'asc' }, select: { id: true } })
    const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId: procurement.organizationId, code: 'S1' }, select: { id: true } })
    const assigned = must('assign supplier', await assignSupplier(procurement.ctx, { requestLineIds: requestLines.map((l) => l.id), supplierId: supplier.id }, key()))
    const poId = assigned.purchaseOrderIds[0]
    if (!poId) throw new Error('the urgent request made no draft PO')
    must('submit PO', await submitPo(procurement.ctx, { poId }, key()))
    const [po, task] = await Promise.all([prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { number: true } }), openTaskOf('PURCHASE_ORDER', poId)])
    if (!task.assigneeMemberId) throw new Error('the PO task has no assignee')
    result = { poId, number: po.number, taskId: task.id, assignee: await codeOfMember(task.assigneeMemberId) }
    break
  }
  case 'sent-po': {
    const ctx = await requesterOf(args[0])
    const count = countOf(args[1])
    const title = `วัสดุงานโครงสร้างไซต์ A ${count} รายการ ${tagOf(args[2])}`
    const procurement = await seededMember(ctx.organizationId, 'proc_officer')
    const [budgetLine, site, supplier] = await Promise.all([
      prisma.budgetLine.findFirstOrThrow({ where: { organizationId: ctx.organizationId, code: 'CON-OPEX-2569' }, select: { id: true } }),
      prisma.deliverySite.findFirstOrThrow({ where: { organizationId: ctx.organizationId, code: 'SITE-A' }, select: { id: true } }),
      prisma.supplier.findFirstOrThrow({ where: { organizationId: ctx.organizationId, code: 'S1' }, select: { id: true } }),
    ])
    const lines = linesSummingTo(count, 1_490_000n)
    const draft = must(
      'draft',
      await createDraft(ctx, { requestTypeCode: 'BUY_GOODS', title, urgency: 'URGENT', priceIncludesVat: false, budgetLineId: budgetLine.id, deliverySiteId: site.id, lines }, key()),
    )
    must('submit', await submitRequest(ctx, { requestId: draft.requestId }, key()))
    await approveOpen(ctx.organizationId, draft.requestId)
    const requestLines = await prisma.requestLine.findMany({ where: { requestId: draft.requestId }, orderBy: { lineNo: 'asc' }, select: { id: true } })
    const assigned = must('assign supplier', await assignSupplier(procurement, { requestLineIds: requestLines.map((l) => l.id), supplierId: supplier.id }, key()))
    const poId = assigned.purchaseOrderIds[0]
    if (!poId) throw new Error('the urgent request made no draft PO')
    must('submit PO', await submitPo(procurement, { poId }, key()))
    await approveOpen(ctx.organizationId, poId)
    const mailed = must('send PO', await sendPurchaseOrder(procurement, { poId }, key()))
    if (!mailed.sent) throw new Error(`the PO e-mail bounced: ${mailed.bounce}`)
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { number: true, status: true, _count: { select: { lines: true } } } })
    if (po.status !== 'SENT') throw new Error(`the PO is ${po.status}, not SENT`)
    if (po._count.lines !== count) throw new Error(`the PO has ${po._count.lines} lines, not ${count}`)
    result = { poId, number: po.number }
    break
  }
  default:
    throw new Error(`unknown LIFF budget scene command ${command ?? '(none)'}`)
}
console.log(JSON.stringify(result))
await prisma.$disconnect()
