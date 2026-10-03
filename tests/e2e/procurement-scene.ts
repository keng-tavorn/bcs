import { randomUUID } from 'node:crypto'
import { EmailSendError, setEmailProvider } from '@/integrations/email-provider'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier } from '@/server/services/procurement'
import { completeUpload, requestUpload } from '@/server/services/files'
import { submitPo } from '@/server/services/purchase-orders'
import { sendPurchaseOrder } from '@/server/services/purchase-orders/send'
import { postGoodsReceipt, requestCloseShort } from '@/server/services/receiving'
import { createDraft, submitRequest } from '@/server/services/requests'
import { attachFile } from '@/server/services/requests/attachments'
import { E2E_DB } from '../support/e2e-env'
import { ATTACHMENT_PDF } from './tasks-attachment'

// Run by tests/e2e/procurement*.spec.ts, purchase-order*.spec.ts and tasks-po.spec.ts against the e2e database only
// (unit e: S4-03, S4-04, S4-06): approved requests, draft and approved POs, a bounced sending and a receiving variance,
// all made through the services with fresh idempotency keys, from today's date. Every scenario takes a tag (the
// Playwright project and a random part) so desktop and mobile, and two runs, never share a record. The requests of the
// PO scenarios are urgent: choosing their supplier drafts their own PO at once (BR-CONS-02), so a scenario never takes
// lines another test left in the pool and leaves none with a supplier there (a test that orders less than a request
// line takes the supplier off the rest itself). Files go through the presigned upload of the file service, as a
// browser sends them. Prints one line of JSON last.
//   pool <tag>      three approved requests of CON for the pool: two lines at SITE-A, one line at SITE-B, one urgent
//                   line at HQ-STORE; none has a supplier
//   demo <tag>      the request of demo scene 1 (req_con, plywood and nails, 42,000 before VAT) and one like H11
//                   (asst_con, PPE, 12,000), both at SITE-A with S1 suggested, approved (Demo_Script scene 7)
//   draft <tag>     two POs of one item approved by the COO at 1,000 and 1,050 baht, then a draft PO of the same item at
//                   1,200 (supplier S5, HQ-STORE): the price warning of FR-P2P-003 AC1
//   approved <tag>  an approved PO of S3 at HQ-STORE (sending, cancelling)
//   bounced <tag>   the same, sent once with a mail server that refused it (FR-P2P-005 AC2)
//   pending <tag>   a PO of S3 sent for approval, waiting for the COO; its request carries a PDF the approver opens
//   variance <tag>  a PO of S3 sent (the e-mail goes to a provider of this process), 6 of 10 received by receiver_con,
//                   the rest closed short by proc_officer: a variance waiting for the DM of CON (GRV-01)
//   damaged <tag>   a PO of S3 sent, all 10 delivered to receiver_con with 2 damaged pieces kept and a photo of them:
//                   a damaged-goods variance waiting for the DM of CON (GRV-01, BR-GR-05)
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the procurement scene runs in the e2e database only')

const now = systemClock.now()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }, what: string): T => {
  if (!r.ok) throw new Error(`${what} failed: ${JSON.stringify(r.error)}`)
  return r.data
}

/** A 1×1 PNG: the smallest picture the file service accepts as a photo (it checks the PNG head) */
const PHOTO_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const memberId = async (code: string) => (await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode: code }, select: { id: true } })).id
const ctxOf = async (code: string) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: await memberId(code) }, channel: 'WEB', now })
const supplierId = async (code: string) => (await prisma.supplier.findFirstOrThrow({ where: { organizationId: org.id, code }, select: { id: true } })).id
const siteId = async (code: string) => (await prisma.deliverySite.findFirstOrThrow({ where: { organizationId: org.id, code }, select: { id: true } })).id

/** Uploads bytes as the member `code` through the presigned flow of the file service, as a browser does (FR-PLT-004) */
async function upload(code: string, fileName: string, mimeType: string, bytes: Buffer): Promise<string> {
  const ctx = await ctxOf(code)
  const asked = ok(await requestUpload(ctx, { fileName, mimeType, sizeBytes: bytes.length }), 'upload')
  const put = await fetch(asked.uploadUrl, { method: 'PUT', body: new Uint8Array(bytes), headers: { 'Content-Type': mimeType } })
  if (!put.ok) throw new Error(`upload failed: ${put.status}`)
  return ok(await completeUpload(ctx, { ticket: asked.ticket }), 'upload recorded').fileId
}

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

interface RequestSpec {
  readonly requester: string
  readonly title: string
  readonly site: string
  readonly suggested?: string
  readonly urgent?: boolean
  readonly budget: { readonly id: string }
  readonly lines: ReadonlyArray<{ readonly description: string; readonly quantity: string; readonly uom: string; readonly unitPrice: string; readonly categoryCode?: string }>
  /** A PDF the requester attaches to the draft before sending it, by this name */
  readonly attach?: string
}

async function approvedRequest(spec: RequestSpec) {
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
  if (spec.attach) {
    const fileId = await upload(spec.requester, spec.attach, 'application/pdf', ATTACHMENT_PDF)
    ok(await attachFile(ctx, { requestId: draft.requestId, fileId, kind: 'JUSTIFICATION' }, key()), 'attach')
  }
  const sent = ok(await submitRequest(ctx, { requestId: draft.requestId }, key()), 'submit')
  await approveAll(draft.requestId)
  const request = await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId }, select: { status: true, lines: { orderBy: { lineNo: 'asc' }, select: { id: true } } } })
  if (request.status !== 'APPROVED') throw new Error(`request ${sent.number} is ${request.status}`)
  return { id: draft.requestId, number: sent.number, title: spec.title, lineIds: request.lines.map((l) => l.id) }
}

/** The draft PO of the lines of an urgent request: choosing their supplier drafts them at once, alone (BR-CONS-02) */
async function draftPo(requestLineIds: string[], supplier: string): Promise<string> {
  const assigned = ok(await assignSupplier(await ctxOf('proc_officer'), { requestLineIds, supplierId: await supplierId(supplier) }, key()), 'assign')
  const [poId] = assigned.purchaseOrderIds
  if (!poId || assigned.purchaseOrderIds.length !== 1) throw new Error(`expected one draft of an urgent request, got ${JSON.stringify(assigned)}`)
  return poId
}

async function sentForApproval(requestLineIds: string[], supplier: string) {
  const poId = await draftPo(requestLineIds, supplier)
  const submitted = ok(await submitPo(await ctxOf('proc_officer'), { poId }, key()), 'submit PO')
  return { poId, number: submitted.number }
}

/** A small urgent request of CON on its capital line (the operating line is the demo scenes'), delivered to HQ-STORE */
async function smallRequest(tag: string, description: string, quantity = '10', unitPrice = '100.00', categoryCode?: string, attach?: string) {
  return approvedRequest({
    requester: 'req_con',
    title: `วัสดุสำนักงานไซต์ (${tag})`,
    site: 'HQ-STORE',
    urgent: true,
    budget: await budgetLine('CON-CAPEX-2569', 'CON-OPEX-2569', 50_000n),
    lines: [{ description, quantity, uom: 'ชิ้น', unitPrice, ...(categoryCode ? { categoryCode } : {}) }],
    ...(attach ? { attach } : {}),
  })
}

async function approvedPo(tag: string, description: string, unitPrice = '100.00', categoryCode?: string, supplier = 'S3') {
  const request = await smallRequest(tag, description, '10', unitPrice, categoryCode)
  const po = await sentForApproval(request.lineIds, supplier)
  await approveAll(po.poId)
  return { ...po, request }
}

const [scenario, rawTag] = process.argv.slice(2)
const tag = rawTag ?? 'e2e'
let out: unknown
switch (scenario) {
  case 'pool': {
    const budget = await budgetLine('CON-CAPEX-2569', 'CON-OPEX-2569', 20_000n)
    const a = await approvedRequest({
      requester: 'req_con',
      title: `ไม้แบบหล่อคอนกรีต (${tag})`,
      site: 'SITE-A',
      suggested: 'S1',
      budget,
      lines: [
        { description: 'ไม้แบบ 1 นิ้ว', quantity: '20', uom: 'แผ่น', unitPrice: '150.00' },
        { description: 'น้ำมันทาแบบ', quantity: '4', uom: 'ถัง', unitPrice: '250.00' },
      ],
    })
    const b = await approvedRequest({ requester: 'req_con2', title: `ทรายหยาบ (${tag})`, site: 'SITE-B', budget, lines: [{ description: 'ทรายหยาบ', quantity: '3', uom: 'คิว', unitPrice: '600.00' }] })
    const c = await approvedRequest({
      requester: 'req_con',
      title: `ถุงมือกันบาด (${tag})`,
      site: 'HQ-STORE',
      urgent: true,
      budget,
      lines: [{ description: 'ถุงมือกันบาด', quantity: '10', uom: 'คู่', unitPrice: '120.00' }],
    })
    out = { a, b, c }
    break
  }
  case 'demo': {
    // Demo_Script scene 1 and Demo_History H11: the operating budget of CON when it still has room for both
    const budget = await budgetLine('CON-OPEX-2569', 'CON-CAPEX-2569', 54_000n)
    const scene1 = await approvedRequest({
      requester: 'req_con',
      title: 'ไม้อัดและตะปู',
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
      title: 'อุปกรณ์ความปลอดภัย PPE',
      site: 'SITE-A',
      suggested: 'S1',
      budget,
      lines: [{ description: 'หมวกนิรภัยและเสื้อสะท้อนแสง', quantity: '40', uom: 'ชุด', unitPrice: '300.00' }],
    })
    out = { scene1, h11, budgetLine: budget.code }
    break
  }
  case 'draft': {
    const item = `สายไฟ THW 2.5 ตร.มม. (${tag})`
    const first = await approvedPo(tag, item, '1000.00', 'ELEC', 'S5')
    const second = await approvedPo(tag, item, '1050.00', 'ELEC', 'S5')
    const request = await smallRequest(tag, item, '10', '1200.00', 'ELEC')
    const poId = await draftPo(request.lineIds, 'S5')
    out = { poId, request, previous: [second.number, first.number], item }
    break
  }
  case 'approved': {
    out = await approvedPo(tag, `ตลับเมตร 5 เมตร (${tag})`)
    break
  }
  case 'bounced': {
    const po = await approvedPo(tag, `ระดับน้ำอะลูมิเนียม (${tag})`)
    setEmailProvider({
      async send() {
        throw new EmailSendError(true, 'SMTP_550')
      },
    })
    const sent = ok(await sendPurchaseOrder(await ctxOf('proc_officer'), { poId: po.poId }, key()), 'send')
    if (sent.bounce !== 'SMTP_550') throw new Error(`the sending did not bounce: ${JSON.stringify(sent)}`)
    out = po
    break
  }
  case 'pending': {
    const file = `justification-${tag}.pdf`
    const request = await smallRequest(tag, `เทปพันเกลียว (${tag})`, '10', '100.00', undefined, file)
    out = { ...(await sentForApproval(request.lineIds, 'S3')), request, file }
    break
  }
  case 'variance': {
    const po = await approvedPo(tag, `ไม้อัด 10 มม. (${tag})`)
    setEmailProvider({ send: async () => ({ messageId: randomUUID() }) })
    ok(await sendPurchaseOrder(await ctxOf('proc_officer'), { poId: po.poId }, key()), 'send')
    const line = await prisma.poLine.findFirstOrThrow({ where: { poId: po.poId }, select: { id: true, description: true } })
    ok(await postGoodsReceipt(await ctxOf('receiver_con'), { poId: po.poId, deliveryNoteNo: `DN-${tag}`, lines: [{ poLineId: line.id, received: '6' }] }, key()), 'receive')
    const [varianceId] = ok(await requestCloseShort(await ctxOf('proc_officer'), { poId: po.poId, reason: 'ผู้ขายแจ้งว่าไม่มีของส่วนที่เหลือ' }, key()), 'close short').varianceIds
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'VARIANCE', subjectId: varianceId! } } }, select: { id: true, assignee: { select: { employeeCode: true } }, principal: { select: { employeeCode: true } } } })
    out = { ...po, varianceId, taskId: task.id, description: line.description, approver: task.principal?.employeeCode ?? task.assignee.employeeCode }
    break
  }
  case 'damaged': {
    const po = await approvedPo(tag, `กระเบื้องยาง (${tag})`)
    setEmailProvider({ send: async () => ({ messageId: randomUUID() }) })
    ok(await sendPurchaseOrder(await ctxOf('proc_officer'), { poId: po.poId }, key()), 'send')
    const line = await prisma.poLine.findFirstOrThrow({ where: { poId: po.poId }, select: { id: true, description: true } })
    const photo = `damaged-${tag}.png`
    const photoId = await upload('receiver_con', photo, 'image/png', PHOTO_PNG)
    const gr = ok(
      await postGoodsReceipt(
        await ctxOf('receiver_con'),
        { poId: po.poId, deliveryNoteNo: `DN-${tag}`, photoFileIds: [photoId], lines: [{ poLineId: line.id, received: '10', rejected: '2', damagedDisposition: 'ACCEPT_DAMAGED' }] },
        key(),
      ),
      'receive',
    )
    const [varianceId] = gr.varianceIds
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'VARIANCE', subjectId: varianceId! } } }, select: { id: true, assignee: { select: { employeeCode: true } }, principal: { select: { employeeCode: true } } } })
    out = { ...po, varianceId, taskId: task.id, description: line.description, photo, approver: task.principal?.employeeCode ?? task.assignee.employeeCode }
    break
  }
  default:
    throw new Error(`unknown scenario ${scenario}`)
}
await prisma.$disconnect()
console.log(JSON.stringify(out))
