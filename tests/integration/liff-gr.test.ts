import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { postReceipt, previewReceipt } from '@/app/(workspace)/receiving/commands'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { completeUpload, getDownloadUrl, requestUpload } from '@/server/services/files'
import { assignSupplier } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { getReceivingView } from '@/server/services/receiving/view'
import { createDraft, submitRequest } from '../support/requests'
import type { ReceiptInput } from '@/ui/receiving/types'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S5-06 · /liff/gr/[poId] (FR-LINE-003 AC3, FR-P2P-006): the LIFF page's server actions (src/app/liff/gr/[poId]/actions.ts)
// take the member's context from the LIFF session — channel LIFF — and run the same code as the workspace's receiving
// page: the file service's presigned upload for the photos, the receipt's preview and gr.post through
// src/app/(workspace)/receiving/commands.ts. Here that path runs with a LIFF context against real Postgres and the local
// S3 server (RustFS): the photo is uploaded and checked, attached to the receipt, every Event says LIFF, and the service
// still decides who may receive (an outsider, an approver of the request) — a hidden button is never the guard.
// Monday 5 Oct 2026 10:00 Thai time.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const PLYWOOD = { description: 'ไม้อัด 10 มม.', quantity: '10', uom: 'แผ่น', unitPrice: '520.00' }
const NAILS = { description: 'ตะปู 2 นิ้ว', quantity: '1000', uom: 'ตัว', unitPrice: '1.20' }
const PPE = { description: 'ชุด PPE', quantity: '10', uom: 'ชุด', unitPrice: '850.00' }
/** The first bytes of a JPEG as a phone's canvas writes it (the server recognises the type by them) */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...Array.from({ length: 52 }, (_, i) => i), 0xff, 0xd9])

let org: DoaOrg
let supplierId: string
let siteId: string
const liff = (code: string) => org.ctxOf(code, NOW, 'LIFF')
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]

beforeAll(async () => {
  execSync('pnpm exec tsx scripts/storage-init.ts', { stdio: 'ignore' })
  org = await createDoaOrg()
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายวัสดุ', taxId: '0999999000012' } })).id
  siteId = (await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: 'SITE-A', nameTh: 'ไซต์งาน A' } })).id
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
})

async function approveAll(subjectId: string) {
  for (let i = 0; i < 5; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } } })
    if (!task) return
    ok(await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
  }
}

/** An urgent request of req_con drafted into its own PO, approved, and marked sent (the e-mail is S4-06's) */
async function sentPo(lines: ReadonlyArray<typeof PPE>) {
  const budgetLine = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, departmentId: org.department.CON! }, orderBy: { code: 'asc' } })
  const requester = org.ctxOf('req_con', NOW)
  const draft = ok(await createDraft(requester, { requestTypeCode: 'BUY_GOODS', title: 'วัสดุหน้างาน', urgency: 'URGENT', budgetLineId: budgetLine.id, deliverySiteId: siteId, lines: [...lines] }, key()))
  ok(await submitRequest(requester, { requestId: draft.requestId }, key()))
  await approveAll(draft.requestId)
  const requestLines = await prisma.requestLine.findMany({ where: { requestId: draft.requestId }, orderBy: { lineNo: 'asc' } })
  const assigned = ok(await assignSupplier(org.ctxOf('proc_officer', NOW), { requestLineIds: requestLines.map((l) => l.id), supplierId }, key()))
  const poId = assigned.purchaseOrderIds[0]!
  ok(await submitPo(org.ctxOf('proc_officer', NOW), { poId }, key()))
  await approveAll(poId)
  await prisma.purchaseOrder.update({ where: { id: poId }, data: { status: 'SENT', sentAt: NOW } })
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  return { poId, lineIds: po.lines.map((l) => l.id), requestId: draft.requestId }
}

/** A photo as the LIFF page sends it: a presigned PUT of the file service, then the server's own check */
async function uploadFromLiff(code: string, fileName: string): Promise<string> {
  const ctx = liff(code)
  const started = ok(await requestUpload(ctx, { fileName, mimeType: 'image/jpeg', sizeBytes: JPEG.length }))
  const put = await fetch(started.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array(JPEG) })
  expect(put.status).toBe(200)
  return ok(await completeUpload(ctx, { ticket: started.ticket }, { sender: null })).fileId
}

const receipt = (poId: string, lines: ReceiptInput['lines'], extra: Partial<ReceiptInput> = {}): ReceiptInput => ({ poId, deliveryNoteNo: '', notes: '', photoFileIds: [], lines, ...extra })
const line = (poLineId: string, received: string): ReceiptInput['lines'][number] => ({ poLineId, received, rejected: '', damaged: false, remark: '' })

describe('[FR-LINE-003/AC3] a photo taken in LIFF is attached to the goods receipt', () => {
  it('uploads the photo through the presigned address, previews and posts the receipt on channel LIFF; the photo belongs to the GR and the PO is partly received', async () => {
    const po = await sentPo([PLYWOOD, NAILS, PPE])
    const photo = await uploadFromLiff('receiver_con', 'site-delivery.jpg')
    expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: photo } })).toMatchObject({ status: 'AVAILABLE', mimeType: 'image/jpeg', sizeBytes: JPEG.length, uploadedById: org.member.receiver_con })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: photo, type: 'file.uploaded' } })).toMatchObject({ channel: 'LIFF', actorMemberId: org.member.receiver_con })

    const lines = [line(po.lineIds[0]!, '6'), line(po.lineIds[2]!, '10')]
    const preview = await previewReceipt(liff('receiver_con'), { poId: po.poId, photoFileIds: [photo], lines }, randomUUID())
    expect(preview).toMatchObject({ ok: true, preview: { poStatusAfter: 'PARTIALLY_RECEIVED', linesOutstandingAfter: 2 } })

    const posted = await postReceipt(liff('receiver_con'), receipt(po.poId, lines, { deliveryNoteNo: 'DN-2569-0815', photoFileIds: [photo] }), randomUUID())
    expect(posted).toMatchObject({ ok: true, poStatus: 'PARTIALLY_RECEIVED', varianceCount: 0, pendingApproval: 0 })
    const gr = await prisma.goodsReceipt.findFirstOrThrow({ where: { poId: po.poId } })
    expect(gr).toMatchObject({ receiverMemberId: org.member.receiver_con, deliveryNoteNo: 'DN-2569-0815', status: 'POSTED' })
    expect(await prisma.fileLink.findMany({ where: { fileId: photo }, select: { subjectType: true, subjectId: true, kind: true } })).toEqual([{ subjectType: 'GoodsReceipt', subjectId: gr.id, kind: 'PHOTO' }])
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: gr.id, type: 'gr.posted' } })).toMatchObject({ channel: 'LIFF', actorMemberId: org.member.receiver_con, data: { poStatus: 'PARTIALLY_RECEIVED' } })

    // The page shows the receipt with its photo; the photo opens for those who may see the receipt, not for an outsider
    const view = ok(await getReceivingView(liff('receiver_con'), po.poId))
    expect(view.po.status).toBe('PARTIALLY_RECEIVED')
    expect(view.po.receipts[0]).toMatchObject({ number: gr.number, photos: [{ fileId: photo, fileName: 'site-delivery.jpg' }] })
    expect(ok(await getDownloadUrl(liff('receiver_con'), { fileId: photo })).url).toMatch(/X-Amz-Expires=\d+/)
    expect(await getDownloadUrl(liff('dm_it'), { fileId: photo })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('takes only a picture the receiver uploaded and nothing attached elsewhere: a photo of someone else is refused', async () => {
    const po = await sentPo([PPE])
    const theirs = await uploadFromLiff('req_con', 'not-mine.jpg')
    const posted = await postReceipt(liff('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '2')], { photoFileIds: [theirs] }), randomUUID())
    expect(posted).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'photoFileIds', reason: 'FILE' })
    expect(await prisma.goodsReceipt.count({ where: { poId: po.poId } })).toBe(0)
  })
})

describe('[FR-P2P-006/AC3] in LIFF the service decides who may receive', () => {
  it('refuses a member without gr.post for the PO, and an approver of the request by separation of duties — recorded on channel LIFF', async () => {
    const po = await sentPo([PPE])
    // An outsider: the DM of IT holds no gr.post for the construction department's goods
    expect(await getReceivingView(liff('dm_it'), po.poId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await postReceipt(liff('dm_it'), receipt(po.poId, [line(po.lineIds[0]!, '1')]), randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    // Whoever approved the request may not receive it, even as a RECEIVER of the department (BR-SOD-02, GC-SOD-02)
    const decided = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'APPROVED', step: { route: { subjectId: po.requestId } } } })
    const approver = codeOf(decided.decidedByMemberId!)
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: decided.decidedByMemberId!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
    expect(ok(await getReceivingView(liff(approver), po.poId))).toMatchObject({ decision: { kind: 'SOD', rule: 'BR-SOD-02' }, receivable: false })
    const posted = await postReceipt(liff(approver), receipt(po.poId, [line(po.lineIds[0]!, '1')]), randomUUID())
    expect(posted).toMatchObject({ ok: false, code: 'SOD_VIOLATION', rule: 'BR-SOD-02' })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'security.sod_blocked', aggregateId: po.poId, data: { path: ['action'], equals: 'gr.post' } } })).toMatchObject({
      channel: 'LIFF',
      data: { rule: 'BR-SOD-02', actorMemberId: decided.decidedByMemberId },
    })
    expect(await prisma.goodsReceipt.count({ where: { poId: po.poId } })).toBe(0)
  })
})
