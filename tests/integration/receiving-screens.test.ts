import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { closeShort, postReceipt, previewReceipt } from '@/app/(workspace)/receiving/commands'
import { fund } from '@/core/budget'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { decideTask } from '@/server/services/approvals/decide'
import { createDelegation, revokeDelegation } from '@/server/services/delegations'
import { getDownloadUrl } from '@/server/services/files'
import { assignSupplier } from '@/server/services/procurement'
import { closePurchaseOrder, submitPo } from '@/server/services/purchase-orders'
import { getReceivingView, listReceivable } from '@/server/services/receiving/view'
import { createDraft, submitRequest } from '@/server/services/requests'
import { receivingErrorKey, type ReceivingFailure } from '@/ui/receiving/outcome'
import type { ReceiptInput } from '@/ui/receiving/types'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S4-07, the screen side of receiving (FR-P2P-006, FR-P2P-007, FR-P2P-010 AC2 AC3, FR-DOA-007 AC2): the list of POs a
// member may receive, the receiving page's view (who may see it, amounts only for po.view, the close-short plan), the
// preview of what a receipt will do (accepted, tolerance, excess and damaged choices with the GR_VARIANCE approver named),
// and the commands behind the page's buttons (src/app/(workspace)/receiving/commands.ts) — each refusing whoever the
// service refuses, separation of duties in plain words. Goods are never counted twice: what a close-short gave up takes
// no more goods as ordered, a close-short approved after more goods came gives up only what is still missing (NEW-32),
// and damaged goods waiting to be kept are neither given up nor received over. Real Postgres (BCS_TEST_DB), an
// organization from the §7.4 fixtures. Monday 5 Oct 2026 10:00 Thai time.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let supplierId: string
let siteId: string
const ctx = (code: string) => org.ctxOf(code, NOW)
const codeOf = (o: DoaOrg, memberId: string) => Object.entries(o.member).find(([, id]) => id === memberId)![0]

const PLYWOOD = { description: 'ไม้อัด 10 มม.', quantity: '10', uom: 'แผ่น', unitPrice: '520.00' }
const NAILS = { description: 'ตะปู 2 นิ้ว', quantity: '1000', uom: 'ตัว', unitPrice: '1.20' }
const PPE = { description: 'ชุด PPE', quantity: '10', uom: 'ชุด', unitPrice: '850.00' }
const CEMENT = { description: 'ปูนซีเมนต์', quantity: '10', uom: 'ถุง', unitPrice: '1100.00' }
const SAND = { description: 'ทรายหยาบ', quantity: '10', uom: 'คิว', unitPrice: '100.00' }

beforeAll(async () => {
  org = await createDoaOrg()
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายวัสดุ', taxId: '0999999000012' } })).id
  siteId = (await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: 'SITE-A', nameTh: 'ไซต์งาน A' } })).id
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: NOW } })
  // A RECEIVER of another department: gr.post covers only the IT department's requests
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'RECEIVER', scopeDepartmentId: org.department.IT!, grantedAt: NOW } })
})

async function fundedLine(o: DoaOrg, satang = 100_000_000n): Promise<string> {
  const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: o.organizationId, code: 'FY2569' } })
  const cc = await prisma.costCenter.findFirstOrThrow({ where: { organizationId: o.organizationId, code: 'CC-CON' } })
  const line = await prisma.budgetLine.create({ data: { organizationId: o.organizationId, fiscalYearId: fy.id, departmentId: o.department.CON!, costCenterId: cc.id, code: `CON-${randomUUID().slice(0, 8)}`, nameTh: 'งบทดสอบ', plannedSatang: 0n } })
  await prisma.budgetLineBalance.create({ data: { organizationId: o.organizationId, budgetLineId: line.id } })
  const seedCtx = systemCtx(o.organizationId, NOW, 'seed')
  const importId = randomUUID()
  await forTenant(o.organizationId).$transaction(async (tx) => {
    const r = await applyBudget(tx, seedCtx, [{ budgetLineId: line.id, document: { type: 'IMPORT', id: importId }, run: (s) => fund(s, satang, importId) }])
    if (!r.ok) throw new Error('fund failed')
    await appendEvents(tx, seedCtx, r.events)
  })
  return line.id
}

async function approveAll(o: DoaOrg, subjectId: string) {
  for (let i = 0; i < 5; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } } })
    if (!task) return
    ok(await decideTask(o.ctxOf(codeOf(o, task.assigneeMemberId), NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
  }
}

/** An urgent request of `requester` drafted into its own PO at once, approved and sent (S4-06 e-mails it; here it is marked SENT) */
async function sentPo(lines: ReadonlyArray<typeof PLYWOOD>, options: { o?: DoaOrg; requester?: string; site?: string; supplier?: string; budgetSatang?: bigint } = {}) {
  const o = options.o ?? org
  const budgetLineId = await fundedLine(o, options.budgetSatang)
  const requesterCtx = o.ctxOf(options.requester ?? 'req_con', NOW)
  const draft = ok(await createDraft(requesterCtx, { requestTypeCode: 'BUY_GOODS', title: 'วัสดุหน้างาน', urgency: 'URGENT', budgetLineId, deliverySiteId: options.site ?? siteId, lines: [...lines] }, key()))
  ok(await submitRequest(requesterCtx, { requestId: draft.requestId }, key()))
  await approveAll(o, draft.requestId)
  const requestLines = await prisma.requestLine.findMany({ where: { requestId: draft.requestId }, orderBy: { lineNo: 'asc' } })
  const assigned = ok(await assignSupplier(o.ctxOf('proc_officer', NOW), { requestLineIds: requestLines.map((l) => l.id), supplierId: options.supplier ?? supplierId }, key()))
  const poId = assigned.purchaseOrderIds[0]!
  ok(await submitPo(o.ctxOf('proc_officer', NOW), { poId }, key()))
  await approveAll(o, poId)
  await prisma.purchaseOrder.update({ where: { id: poId }, data: { status: 'SENT', sentAt: NOW } })
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  return { poId, number: po.number!, lineIds: po.lines.map((l) => l.id), requestId: draft.requestId, budgetLineId }
}

const photoOf = async (o: DoaOrg, code: string, mimeType = 'image/jpeg', fileName = 'delivery.jpg') =>
  (await prisma.fileObject.create({ data: { organizationId: o.organizationId, storageKey: `test/${randomUUID()}`, fileName, mimeType, sizeBytes: 1, status: 'AVAILABLE', uploadedById: o.member[code]! } })).id

const receipt = (poId: string, lines: ReceiptInput['lines'], extra: Partial<ReceiptInput> = {}): ReceiptInput => ({ poId, deliveryNoteNo: '', notes: '', photoFileIds: [], lines, ...extra })
const line = (poLineId: string, received: string, extra: Partial<ReceiptInput['lines'][number]> = {}): ReceiptInput['lines'][number] => ({ poLineId, received, rejected: '', damaged: false, remark: '', ...extra })
const failureOf = (outcome: { ok: boolean }) => outcome as ReceivingFailure
/** A check of what a receipt will do, with its own idempotency key as the form sends it */
const check = (code: string, input: unknown, o: DoaOrg = org) => previewReceipt(o.ctxOf(code, NOW), input, randomUUID())
const poLine = (id: string) => prisma.poLine.findUniqueOrThrow({ where: { id } })
const poStatus = async (poId: string) => (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status
const balanceOf = (budgetLineId: string) => prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId }, select: { availableSatang: true, committedSatang: true } })
const varianceOf = async (poId: string, disposition: 'CLOSE_SHORT' | 'ACCEPT_DAMAGED', poLineId?: string) =>
  prisma.variance.findFirstOrThrow({ where: { poId, disposition, ...(poLineId ? { poLineId } : {}) }, orderBy: { createdAt: 'desc' } })

describe('[FR-P2P-006/AC1] the receiver lists what waits for goods and records quantities, the delivery note and photos', () => {
  it('lists the sent PO for the RECEIVER of the department, oldest first; the page shows quantities without amounts', async () => {
    const older = await sentPo([PPE])
    await prisma.purchaseOrder.update({ where: { id: older.poId }, data: { sentAt: new Date(NOW.getTime() - 3_600_000) } })
    const po = await sentPo([PLYWOOD, NAILS, PPE])
    const list = ok(await listReceivable(ctx('receiver_con')))
    expect(list).toMatchObject({ receives: true, page: 1, pageCount: 1 })
    const ids = list.rows.map((r) => r.id)
    expect(ids).toEqual(expect.arrayContaining([older.poId, po.poId]))
    expect(ids.indexOf(older.poId)).toBeLessThan(ids.indexOf(po.poId))
    expect(list.total).toBe(list.rows.length + list.blocked.length)
    expect(list.rows.find((r) => r.id === po.poId)).toMatchObject({ number: po.number, status: 'SENT', lineCount: 3, outstandingLines: 3, supplier: { th: 'ผู้ขายวัสดุ' }, site: { th: 'ไซต์งาน A' } })

    const view = ok(await getReceivingView(ctx('receiver_con'), po.poId))
    expect(view).toMatchObject({ decision: { kind: 'RECEIVE' }, receivable: true, showAmounts: false, canCloseShort: false, tolerancePct: 0 })
    expect(view.po.lines.map((l) => [l.description, l.ordered, l.received, l.outstanding, l.keepPending, l.unitPriceSatang])).toEqual([
      ['ไม้อัด 10 มม.', '10', '0', '10', '0', null],
      ['ตะปู 2 นิ้ว', '1000', '0', '1000', '0', null],
      ['ชุด PPE', '10', '0', '10', '0', null],
    ])
  })

  it('posts what came — quantities typed with thousands separators, empty lines left out — with the delivery note, a photo and notes', async () => {
    const po = await sentPo([PLYWOOD, NAILS, PPE])
    const photo = await photoOf(org, 'receiver_con')
    const posted = await postReceipt(
      ctx('receiver_con'),
      receipt(po.poId, [line(po.lineIds[0]!, '6'), line(po.lineIds[1]!, '1,000'), line(po.lineIds[2]!, '')], { deliveryNoteNo: ' DN-0815 ', notes: 'มาส่งช่วงเช้า', photoFileIds: [photo] }),
      randomUUID(),
    )
    expect(posted).toMatchObject({ ok: true, poStatus: 'PARTIALLY_RECEIVED', varianceCount: 0, pendingApproval: 0 })
    const gr = await prisma.goodsReceipt.findFirstOrThrow({ where: { poId: po.poId }, include: { lines: true } })
    expect(gr).toMatchObject({ deliveryNoteNo: 'DN-0815', notes: 'มาส่งช่วงเช้า', receiverMemberId: org.member.receiver_con, status: 'POSTED' })
    expect(gr.lines.map((l) => [l.poLineId, l.receivedQuantity.toString()]).sort()).toEqual([[po.lineIds[0], '6'], [po.lineIds[1], '1000']].sort())
    expect(await prisma.fileLink.findFirstOrThrow({ where: { subjectType: 'GoodsReceipt', subjectId: gr.id } })).toMatchObject({ fileId: photo, kind: 'PHOTO' })

    const view = ok(await getReceivingView(ctx('receiver_con'), po.poId))
    expect(view.po.receipts).toHaveLength(1)
    expect(view.po.receipts[0]).toMatchObject({ number: gr.number, deliveryNoteNo: 'DN-0815', receiver: { id: org.member.receiver_con }, photos: [{ fileId: photo, fileName: 'delivery.jpg' }] })
    expect(view.po.lines.map((l) => l.outstanding)).toEqual(['4', '0', '10'])
    // po.view with the facts of the PO's PDF and PO page (OWN: creator and requesters · ASSIGNED: its approvers): the
    // receiver still receives by quantity after receiving
    expect(view.showAmounts).toBe(false)
    expect(view.po.lines[0]!.unitPriceSatang).toBeNull()
  })

  it('takes only new pictures as photos: a PDF, or a picture already attached to a receipt, is refused', async () => {
    const po = await sentPo([PLYWOOD])
    const pdf = await photoOf(org, 'receiver_con', 'application/pdf', 'delivery-note.pdf')
    const asPhoto = await check('receiver_con', { poId: po.poId, photoFileIds: [pdf], lines: [line(po.lineIds[0]!, '2')] })
    expect(asPhoto).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'FILE' })
    expect(receivingErrorKey(failureOf(asPhoto))).toBe('PHOTO')
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '2')], { photoFileIds: [pdf] }), randomUUID())).toMatchObject({ ok: false, reason: 'FILE' })

    const photo = await photoOf(org, 'receiver_con')
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '2')], { photoFileIds: [photo] }), randomUUID())).toMatchObject({ ok: true })
    // the same picture again is not evidence of the next delivery
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '2')], { photoFileIds: [photo] }), randomUUID())).toMatchObject({ ok: false, reason: 'FILE' })
    expect((await poLine(po.lineIds[0]!)).receivedQuantity.toString()).toBe('2')
  })

  it('a receipt photo opens for the receiver, the requester, PROCUREMENT, FINANCE and the PO approver, not for a member unrelated to the PO', async () => {
    const po = await sentPo([PPE])
    const photo = await photoOf(org, 'receiver_con')
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '10')], { photoFileIds: [photo] }), randomUUID())).toMatchObject({ ok: true })
    const poApprover = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'APPROVED', step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: po.poId } } } })
    for (const code of ['receiver_con', 'req_con', 'proc_officer', 'fin_officer', codeOf(org, poApprover.assigneeMemberId)]) expect(await getDownloadUrl(ctx(code), { fileId: photo }), code).toMatchObject({ ok: true })
    expect(await getDownloadUrl(ctx('dm_it'), { fileId: photo })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('refuses a malformed call without a crash: no idempotency key, no line received, a quantity that is not a number', async () => {
    const po = await sentPo([PPE])
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '1')]), 'not-a-key')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect(await previewReceipt(ctx('receiver_con'), { poId: po.poId, photoFileIds: [], lines: [line(po.lineIds[0]!, '1')] }, 'not-a-key')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    const nothing = await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '0')]), randomUUID())
    expect(receivingErrorKey(failureOf(nothing))).toBe('NOTHING_RECEIVED')
    const bad = await check('receiver_con', { poId: po.poId, photoFileIds: [], lines: [line(po.lineIds[0]!, 'สิบ')] })
    expect(bad).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'lines.0.received' })
    expect(await check('receiver_con', { poId: 'x' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })
})

describe('[FR-P2P-006/AC2] a partial receipt moves the PO, and the preview says so before posting (GC-GR-01)', () => {
  it('60% of the plywood and all the PPE: PARTIALLY_RECEIVED with two lines to come; the rest later makes it RECEIVED', async () => {
    const po = await sentPo([PLYWOOD, NAILS, PPE])
    const lines = [line(po.lineIds[0]!, '6'), line(po.lineIds[2]!, '10')]
    const preview = await check('receiver_con', { poId: po.poId, photoFileIds: [], lines })
    expect(preview).toMatchObject({ ok: true, preview: { poStatusAfter: 'PARTIALLY_RECEIVED', linesOutstandingAfter: 2, tolerancePct: 0 } })
    if (!preview.ok) throw new Error('preview failed')
    expect(preview.preview.lines.map((l) => [l.accepted, l.outstandingAfter, l.excess, l.damaged, l.hold])).toEqual([
      ['6', '4', null, null, null],
      ['10', '0', null, null, null],
    ])
    // the preview wrote nothing
    expect(await prisma.goodsReceipt.count({ where: { poId: po.poId } })).toBe(0)

    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, lines), randomUUID())).toMatchObject({ ok: true, poStatus: 'PARTIALLY_RECEIVED' })
    expect(await poStatus(po.poId)).toBe('PARTIALLY_RECEIVED')
    expect(ok(await listReceivable(ctx('receiver_con'))).rows.find((r) => r.id === po.poId)).toMatchObject({ status: 'PARTIALLY_RECEIVED', outstandingLines: 2 })

    const rest = [line(po.lineIds[0]!, '4'), line(po.lineIds[1]!, '1,000')]
    expect(await check('receiver_con', { poId: po.poId, photoFileIds: [], lines: rest })).toMatchObject({ ok: true, preview: { poStatusAfter: 'RECEIVED', linesOutstandingAfter: 0 } })
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, rest), randomUUID())).toMatchObject({ ok: true, poStatus: 'RECEIVED' })
    const view = ok(await getReceivingView(ctx('receiver_con'), po.poId))
    expect(view).toMatchObject({ receivable: false, decision: { kind: 'RECEIVE' } })
    expect(view.po.receipts).toHaveLength(2)
    expect(ok(await listReceivable(ctx('receiver_con'))).rows.some((r) => r.id === po.poId)).toBe(false)
    // nothing more is taken once the PO is in
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '1')]), randomUUID())).toMatchObject({ ok: false, code: 'INVALID_STATE_TRANSITION' })
  })

  it('pages the list oldest first and counts every PO of it', async () => {
    const list = ok(await listReceivable(ctx('receiver_con'), { page: 99 }))
    // a page past the end shows the last page
    expect(list).toMatchObject({ page: list.pageCount, pageSize: 50 })
    expect(list.total).toBeGreaterThan(0)
    expect(list.rows.length + list.blocked.length).toBeLessThanOrEqual(list.pageSize)
  })
})

describe('[FR-P2P-006/AC3] [FR-DOA-007/AC2] separation of duties at receiving, in plain words (GC-SOD-02, GC-SOD-05)', () => {
  it('a RECEIVER who approved the request acting for the DM is refused everywhere, with the rule, and every attempt is recorded; the requester receives own goods', async () => {
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.asst_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
    const delegation = ok(
      await createDelegation(
        ctx('dm_con'),
        { delegateMemberId: org.member.asst_con!, startsAt: new Date(NOW.getTime() - 3_600_000).toISOString(), endsAt: new Date(NOW.getTime() + 86_400_000).toISOString(), reason: 'ลาพักร้อน' },
        key(),
      ),
    )
    let po: Awaited<ReturnType<typeof sentPo>>
    try {
      po = await sentPo([PPE])
    } finally {
      ok(await revokeDelegation(ctx('dm_con'), { delegationId: delegation.delegationId }, key()))
    }
    const decided = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'APPROVED', step: { route: { subjectId: po.requestId } } } })
    expect(decided).toMatchObject({ decidedByMemberId: org.member.asst_con, principalMemberId: org.member.dm_con })

    const list = ok(await listReceivable(ctx('asst_con')))
    expect(list.rows.some((r) => r.id === po.poId)).toBe(false)
    expect(list.blocked.find((r) => r.id === po.poId)).toMatchObject({ rule: 'BR-SOD-02' })
    expect(ok(await getReceivingView(ctx('asst_con'), po.poId))).toMatchObject({ decision: { kind: 'SOD', rule: 'BR-SOD-02' }, receivable: false })

    // FR-DOA-007 AC2: a check refused by separation of duties is recorded too, once per attempt (its idempotency key)
    const blockedChecks = () => prisma.event.count({ where: { type: 'security.sod_blocked', aggregateId: po.poId, data: { path: ['action'], equals: 'gr.preview' } } })
    const attempt = randomUUID()
    const input = { poId: po.poId, photoFileIds: [], lines: [line(po.lineIds[0]!, '10')] }
    expect(await previewReceipt(ctx('asst_con'), input, attempt)).toMatchObject({ ok: false, code: 'SOD_VIOLATION', rule: 'BR-SOD-02' })
    expect(await blockedChecks()).toBe(1)
    expect(await previewReceipt(ctx('asst_con'), input, attempt)).toMatchObject({ ok: false, code: 'SOD_VIOLATION', rule: 'BR-SOD-02' })
    expect(await blockedChecks()).toBe(1)
    expect(await check('asst_con', input)).toMatchObject({ ok: false, code: 'SOD_VIOLATION' })
    expect(await blockedChecks()).toBe(2)
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'security.sod_blocked', aggregateId: po.poId, data: { path: ['action'], equals: 'gr.preview' } } })).toMatchObject({
      data: { rule: 'BR-SOD-02', subjectType: 'PURCHASE_ORDER', subjectId: po.poId, actorMemberId: org.member.asst_con },
    })

    const posted = await postReceipt(ctx('asst_con'), receipt(po.poId, [line(po.lineIds[0]!, '10')]), randomUUID())
    expect(posted).toMatchObject({ ok: false, code: 'SOD_VIOLATION', rule: 'BR-SOD-02' })
    expect(receivingErrorKey(failureOf(posted))).toBe('SOD_APPROVER')
    // FR-DOA-007 AC2: the refusal is recorded with its rule
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'security.sod_blocked', aggregateId: po.poId, data: { path: ['action'], equals: 'gr.post' } } })).toMatchObject({ data: { rule: 'BR-SOD-02', actorMemberId: org.member.asst_con } })
    expect(await prisma.goodsReceipt.count({ where: { poId: po.poId } })).toBe(0)

    // GC-SOD-05: the requester may receive their own goods under this DOA (requesterMayReceive = true)
    expect(ok(await listReceivable(ctx('req_con'))).rows.some((r) => r.id === po.poId)).toBe(true)
    expect(ok(await getReceivingView(ctx('req_con'), po.poId))).toMatchObject({ decision: { kind: 'RECEIVE' }, showAmounts: true })
    expect(await postReceipt(ctx('req_con'), receipt(po.poId, [line(po.lineIds[0]!, '10')]), randomUUID())).toMatchObject({ ok: true, poStatus: 'RECEIVED' })
  })

  it('BR-SOD-07: when the DOA in effect does not let requesters receive, a requester who is also RECEIVER is refused and the refusal recorded', async () => {
    const strict = await createDoaOrg()
    const strictSupplier = (await prisma.supplier.create({ data: { organizationId: strict.organizationId, code: 'S1', nameTh: 'ผู้ขายวัสดุ', taxId: '0999999000012' } })).id
    const strictSite = (await prisma.deliverySite.create({ data: { organizationId: strict.organizationId, code: 'SITE-A', nameTh: 'ไซต์งาน A' } })).id
    await prisma.doaVersion.updateMany({ where: { organizationId: strict.organizationId }, data: { sodPolicy: { approverMayReceive: false, requesterMayReceive: false } } })
    const po = await sentPo([PPE], { o: strict, supplier: strictSupplier, site: strictSite })

    // a plain requester has no gr.post at all now
    expect(ok(await listReceivable(strict.ctxOf('req_con', NOW)))).toMatchObject({ receives: false, rows: [], blocked: [] })
    expect(await postReceipt(strict.ctxOf('req_con', NOW), receipt(po.poId, [line(po.lineIds[0]!, '1')]), randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    await prisma.roleAssignment.create({ data: { organizationId: strict.organizationId, memberId: strict.member.req_con!, role: 'RECEIVER', scopeDepartmentId: strict.department.CON!, grantedAt: NOW } })
    expect(ok(await listReceivable(strict.ctxOf('req_con', NOW))).blocked.find((r) => r.id === po.poId)).toMatchObject({ rule: 'BR-SOD-07' })
    expect(await check('req_con', { poId: po.poId, photoFileIds: [], lines: [line(po.lineIds[0]!, '1')] }, strict)).toMatchObject({ ok: false, code: 'SOD_VIOLATION', rule: 'BR-SOD-07' })
    const posted = await postReceipt(strict.ctxOf('req_con', NOW), receipt(po.poId, [line(po.lineIds[0]!, '1')]), randomUUID())
    expect(posted).toMatchObject({ ok: false, code: 'SOD_VIOLATION', rule: 'BR-SOD-07' })
    expect(receivingErrorKey(failureOf(posted))).toBe('SOD_REQUESTER')
    for (const action of ['gr.preview', 'gr.post']) {
      expect(await prisma.event.findFirstOrThrow({ where: { organizationId: strict.organizationId, type: 'security.sod_blocked', aggregateId: po.poId, data: { path: ['action'], equals: action } } })).toMatchObject({ data: { rule: 'BR-SOD-07' } })
    }
  })

  it('members without gr.post for the PO: an outsider sees nothing and is refused; FINANCE and the PO approver see the PO read-only with amounts', async () => {
    const po = await sentPo([PPE])
    expect(await getReceivingView(ctx('dm_it'), po.poId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(ok(await listReceivable(ctx('dm_it'))).rows.some((r) => r.id === po.poId)).toBe(false)
    expect(await check('dm_it', { poId: po.poId, photoFileIds: [], lines: [line(po.lineIds[0]!, '1')] })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await postReceipt(ctx('dm_it'), receipt(po.poId, [line(po.lineIds[0]!, '1')]), randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const finance = ok(await getReceivingView(ctx('fin_officer'), po.poId))
    expect(finance).toMatchObject({ decision: { kind: 'NONE' }, receivable: false, showAmounts: true, canCloseShort: false })
    expect(finance.po.lines[0]!.unitPriceSatang).toBe(85_000n)
    // §2.4 po.view ASSIGNED: whoever approved the PO opens it, read-only
    const poApprover = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'APPROVED', step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: po.poId } } } })
    expect(ok(await getReceivingView(ctx(codeOf(org, poApprover.assigneeMemberId)), po.poId))).toMatchObject({ decision: { kind: 'NONE' }, receivable: false, showAmounts: true })
    expect(await getReceivingView(ctx('receiver_con'), randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('a RECEIVER of another department has no gr.post here: the PO is not listed, and the page, the check, the receipt and its photos are refused', async () => {
    const po = await sentPo([PPE])
    const photo = await photoOf(org, 'receiver_con')
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '4')], { photoFileIds: [photo] }), randomUUID())).toMatchObject({ ok: true })

    const list = ok(await listReceivable(ctx('admin')))
    expect(list.receives).toBe(true)
    expect([...list.rows, ...list.blocked].some((r) => r.id === po.poId)).toBe(false)
    expect(await getReceivingView(ctx('admin'), po.poId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await check('admin', { poId: po.poId, photoFileIds: [], lines: [line(po.lineIds[0]!, '1')] })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await postReceipt(ctx('admin'), receipt(po.poId, [line(po.lineIds[0]!, '1')]), randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await getDownloadUrl(ctx('admin'), { fileId: photo })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect((await poLine(po.lineIds[0]!)).receivedQuantity.toString()).toBe('4')
  })

  it('the RECEIVER of the department does not open a PO that has not gone to the supplier; its requester sees it read-only', async () => {
    const po = await sentPo([PPE])
    await prisma.purchaseOrder.update({ where: { id: po.poId }, data: { status: 'APPROVED', sentAt: null } })
    expect(await getReceivingView(ctx('receiver_con'), po.poId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(ok(await getReceivingView(ctx('req_con'), po.poId))).toMatchObject({ decision: { kind: 'RECEIVE' }, receivable: false })
    expect(ok(await listReceivable(ctx('receiver_con'))).rows.some((r) => r.id === po.poId)).toBe(false)
  })
})

describe('[FR-P2P-007/AC1] [FR-P2P-007/AC2] beyond the order: the preview names the choice and the GR_VARIANCE approver (GC-GR-02, GC-GR-03, GC-GR-05, GC-DOA-18)', () => {
  it('11 of 10: the excess of 1 must be returned or kept; kept goes to the DM of the department (GRV-01) named in the preview', async () => {
    const po = await sentPo([CEMENT])
    const lines = [line(po.lineIds[0]!, '11')]
    const preview = await check('receiver_con', { poId: po.poId, photoFileIds: [], lines })
    if (!preview.ok) throw new Error(JSON.stringify(preview))
    expect(preview.preview).toMatchObject({ poStatusAfter: 'RECEIVED', linesOutstandingAfter: 0 })
    const excess = preview.preview.lines[0]!.excess!
    // a RECEIVER sees quantities, not amounts
    expect(excess).toMatchObject({ quantity: '1', amount: null, keep: { kind: 'ROUTE', ruleCode: 'GRV-01', name: { th: 'ผู้ใช้ dm_con' }, position: { th: 'DM' } } })
    // the requester (po.view) sees the amount
    const own = await check('req_con', { poId: po.poId, photoFileIds: [], lines })
    expect(own).toMatchObject({ ok: true, preview: { lines: [{ excess: { quantity: '1', amount: '1,100.00' } }] } })

    const unchosen = await postReceipt(ctx('receiver_con'), receipt(po.poId, lines), randomUUID())
    expect(unchosen).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', excess: '1' })
    expect(receivingErrorKey(failureOf(unchosen))).toBe('EXCESS_CHOICE')

    const kept = await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '11', { excessDisposition: 'ACCEPT_EXCESS' })]), randomUUID())
    expect(kept).toMatchObject({ ok: true, poStatus: 'RECEIVED', varianceCount: 1, pendingApproval: 1 })
    const variance = await prisma.variance.findFirstOrThrow({ where: { poId: po.poId } })
    expect(variance).toMatchObject({ type: 'OVER', disposition: 'ACCEPT_EXCESS', status: 'PENDING_APPROVAL', amountSatang: 110_000n })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'VARIANCE', subjectId: variance.id } } }, include: { step: { include: { route: true } } } })
    expect(task.step.route.ruleCode).toBe('GRV-01')
    expect(task.assigneeMemberId).toBe(org.member.dm_con)
    const view = ok(await getReceivingView(ctx('receiver_con'), po.poId))
    expect(view.po.receipts[0]!.variances).toMatchObject([{ type: 'OVER', disposition: 'ACCEPT_EXCESS', status: 'PENDING_APPROVAL', quantity: '1', amountSatang: null }])
    expect(ok(await getReceivingView(ctx('req_con'), po.poId)).po.receipts[0]!.variances).toMatchObject([{ amountSatang: 110_000n }])
    // the excess waits for approval: not taken in by this receipt, but not refused either
    expect(view.po.receipts[0]!.lines[0]).toMatchObject({ received: '11', accepted: '10', rejected: '1', refused: '0' })
  })

  it('returning the excess needs no approval (GC-GR-02)', async () => {
    const po = await sentPo([CEMENT])
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '11', { excessDisposition: 'RETURN_EXCESS' })]), randomUUID())).toMatchObject({ ok: true, poStatus: 'RECEIVED', varianceCount: 1, pendingApproval: 0 })
    expect(await prisma.variance.findFirstOrThrow({ where: { poId: po.poId } })).toMatchObject({ disposition: 'RETURN_EXCESS', status: 'RECORDED' })
  })

  it('GC-GR-05: within a 5% tolerance the excess is accepted at once and the preview tells what more is held', async () => {
    const row = await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })
    const settings = row.settings as Record<string, unknown>
    await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, receiving: { overTolerancePct: 5 } } } })
    try {
      const po = await sentPo([{ description: 'อิฐมอญ', quantity: '100', uom: 'ก้อน', unitPrice: '10.00' }])
      const lines = [line(po.lineIds[0]!, '104')]
      expect(await check('req_con', { poId: po.poId, photoFileIds: [], lines })).toMatchObject({
        ok: true,
        preview: { tolerancePct: 5, poStatusAfter: 'RECEIVED', lines: [{ accepted: '104', withinTolerance: '4', hold: '40.00', excess: null }] },
      })
      expect(await check('receiver_con', { poId: po.poId, photoFileIds: [], lines })).toMatchObject({ ok: true, preview: { lines: [{ withinTolerance: '4', hold: null }] } })
      expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, lines), randomUUID())).toMatchObject({ ok: true, poStatus: 'RECEIVED', varianceCount: 0 })
    } finally {
      await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: settings as object } })
    }
  })

  it('damaged goods need a photo and the receiver choice; kept damaged goods wait for the approver (BR-GR-05)', async () => {
    const po = await sentPo([PLYWOOD])
    const damaged = [line(po.lineIds[0]!, '10', { rejected: '2', damaged: true, remark: 'ขอบแตก' })]
    const noPhoto = await check('receiver_con', { poId: po.poId, photoFileIds: [], lines: damaged })
    expect(receivingErrorKey(failureOf(noPhoto))).toBe('PHOTO_REQUIRED')
    const photo = await photoOf(org, 'receiver_con')
    // a photo someone else uploaded is not the receiver's evidence
    const foreign = await photoOf(org, 'req_con')
    expect(receivingErrorKey(failureOf(await check('receiver_con', { poId: po.poId, photoFileIds: [foreign], lines: damaged })))).toBe('PHOTO')
    const preview = await check('receiver_con', { poId: po.poId, photoFileIds: [photo], lines: damaged })
    expect(preview).toMatchObject({ ok: true, preview: { poStatusAfter: 'PARTIALLY_RECEIVED', lines: [{ rejected: '2', accepted: '8', outstandingAfter: '2', damaged: { quantity: '2', keep: { kind: 'ROUTE', ruleCode: 'GRV-01' } } }] } })

    const unchosen = await postReceipt(ctx('receiver_con'), receipt(po.poId, damaged, { photoFileIds: [photo] }), randomUUID())
    expect(receivingErrorKey(failureOf(unchosen))).toBe('DAMAGED_CHOICE')
    const kept = await postReceipt(ctx('receiver_con'), receipt(po.poId, [{ ...damaged[0]!, damagedDisposition: 'ACCEPT_DAMAGED' }], { photoFileIds: [photo] }), randomUUID())
    expect(kept).toMatchObject({ ok: true, poStatus: 'PARTIALLY_RECEIVED', varianceCount: 1, pendingApproval: 1 })
    const gr = await prisma.goodsReceipt.findFirstOrThrow({ where: { poId: po.poId }, include: { lines: true } })
    expect(gr.lines[0]).toMatchObject({ remark: 'ขอบแตก' })
    expect(gr.lines[0]!.rejectedQuantity.toString()).toBe('2')
    expect(await prisma.variance.findFirstOrThrow({ where: { grId: gr.id } })).toMatchObject({ type: 'DAMAGED', disposition: 'ACCEPT_DAMAGED', status: 'PENDING_APPROVAL', amountSatang: 104_000n })
    // the approver of the damaged goods opens the photo they decide on, without seeing the PO itself
    expect(await getDownloadUrl(ctx('dm_con'), { fileId: photo })).toMatchObject({ ok: true })
    expect(await getReceivingView(ctx('dm_con'), po.poId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const view = ok(await getReceivingView(ctx('receiver_con'), po.poId))
    expect(view.po.receipts[0]!.lines[0]).toMatchObject({ accepted: '8', refused: '2', remark: 'ขอบแตก' })
    expect(view.po.lines[0]).toMatchObject({ outstanding: '2', keepPending: '2' })

    // refused for another reason: no variance, no photo needed, the line stays to come
    const other = await sentPo([PLYWOOD])
    expect(
      await postReceipt(ctx('receiver_con'), receipt(other.poId, [line(other.lineIds[0]!, '10', { rejected: '1', damaged: false, remark: 'ผิดขนาด' })]), randomUUID()),
    ).toMatchObject({ ok: true, poStatus: 'PARTIALLY_RECEIVED', varianceCount: 0 })
  })

  it('damaged goods are kept only up to what is still to come: beyond it they go back, and the preview says so', async () => {
    const po = await sentPo([PLYWOOD])
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '8')]), randomUUID())).toMatchObject({ ok: true })
    const photo = await photoOf(org, 'receiver_con')
    // 4 come for the 2 still to come: 2 good fill the order, the 2 damaged lie beyond it
    const lines = [line(po.lineIds[0]!, '4', { rejected: '2', damaged: true })]
    expect(await check('receiver_con', { poId: po.poId, photoFileIds: [photo], lines })).toMatchObject({
      ok: true,
      preview: { poStatusAfter: 'RECEIVED', lines: [{ accepted: '2', damaged: { quantity: '2', keep: { kind: 'BLOCKED', code: 'BEYOND_ORDER' } } }] },
    })
    const keep = await postReceipt(ctx('receiver_con'), receipt(po.poId, [{ ...lines[0]!, damagedDisposition: 'ACCEPT_DAMAGED' }], { photoFileIds: [photo] }), randomUUID())
    expect(keep).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'DAMAGED_BEYOND_ORDER', keepable: '0' })
    expect(receivingErrorKey(failureOf(keep))).toBe('DAMAGED_BEYOND_ORDER')
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [{ ...lines[0]!, damagedDisposition: 'RETURN_REPLACE' }], { photoFileIds: [photo] }), randomUUID())).toMatchObject({ ok: true, poStatus: 'RECEIVED' })
    expect((await poLine(po.lineIds[0]!)).receivedQuantity.toString()).toBe('10')
  })

  it('a within-tolerance excess the budget cannot hold is refused; the balance is told only to who may view the budget line (§2.4 budget.view)', async () => {
    const tight = await createDoaOrg()
    const tightSupplier = (await prisma.supplier.create({ data: { organizationId: tight.organizationId, code: 'S1', nameTh: 'ผู้ขายวัสดุ', taxId: '0999999000012' } })).id
    const tightSite = (await prisma.deliverySite.create({ data: { organizationId: tight.organizationId, code: 'SITE-A', nameTh: 'ไซต์งาน A' } })).id
    const row = await prisma.organization.findUniqueOrThrow({ where: { id: tight.organizationId } })
    await prisma.organization.update({ where: { id: tight.organizationId }, data: { settings: { ...(row.settings as Record<string, unknown>), receiving: { overTolerancePct: 10 } } } })
    for (const [code, role] of [
      ['receiver_con', 'RECEIVER'],
      ['fin_officer', 'RECEIVER'],
      ['fin_officer', 'FINANCE'],
    ] as const) {
      await prisma.roleAssignment.create({ data: { organizationId: tight.organizationId, memberId: tight.member[code]!, role, ...(role === 'RECEIVER' ? { scopeDepartmentId: tight.department.CON! } : {}), grantedAt: NOW } })
    }
    // 10 × 100.00 on a budget line of exactly 1,000.00: nothing is left for 1 more within the 10% tolerance
    const po = await sentPo([SAND], { o: tight, supplier: tightSupplier, site: tightSite, budgetSatang: 100_000n })
    const eleven = [line(po.lineIds[0]!, '11')]

    // a RECEIVER has no budget.view: refused without figures
    const receiver = await postReceipt(tight.ctxOf('receiver_con', NOW), receipt(po.poId, eleven), randomUUID())
    expect(receiver).toEqual({ ok: false, code: 'BUDGET_INSUFFICIENT' })
    expect(receivingErrorKey(failureOf(receiver))).toBe('BUDGET_INSUFFICIENT_PLAIN')
    // FINANCE (budget.view for the whole organization) who receives for the department sees what is left and missing
    const finance = await postReceipt(tight.ctxOf('fin_officer', NOW), receipt(po.poId, eleven), randomUUID())
    expect(finance).toEqual({ ok: false, code: 'BUDGET_INSUFFICIENT', available: '0.00', shortfall: '100.00' })
    expect(receivingErrorKey(failureOf(finance))).toBe('BUDGET_INSUFFICIENT')
    expect(await prisma.goodsReceipt.count({ where: { poId: po.poId } })).toBe(0)
  })
})

describe('[FR-P2P-010/AC2] PROCUREMENT asks to close a PO short from the receiving page, with a reason and a tick (GC-GR-04)', () => {
  it('shows the plan to PROCUREMENT only; refuses without a reason, without the tick and for the receiver; the PO stays open until approved', async () => {
    const po = await sentPo([CEMENT])
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '6')]), randomUUID())).toMatchObject({ ok: true })

    expect(ok(await getReceivingView(ctx('receiver_con'), po.poId))).toMatchObject({ canCloseShort: false, closeShortPlan: null })
    const procurement = ok(await getReceivingView(ctx('proc_officer'), po.poId))
    expect(procurement).toMatchObject({ decision: { kind: 'NONE' }, showAmounts: true, canCloseShort: true })
    expect(procurement.closeShortPlan).toMatchObject({ totalSatang: 440_000n, lines: [{ quantity: '4', amountSatang: 440_000n }], approvers: [{ kind: 'ROUTE', ruleCode: 'GRV-01' }] })

    expect(receivingErrorKey(failureOf(await closeShort(ctx('proc_officer'), { poId: po.poId, reason: 'x', confirmed: true }, randomUUID())))).toBe('REASON')
    expect(receivingErrorKey(failureOf(await closeShort(ctx('proc_officer'), { poId: po.poId, reason: 'ผู้ขายเลิกผลิต', confirmed: false }, randomUUID())))).toBe('CONFIRM')
    expect(await closeShort(ctx('receiver_con'), { poId: po.poId, reason: 'ผู้ขายเลิกผลิต', confirmed: true }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    expect(await closeShort(ctx('proc_officer'), { poId: po.poId, reason: 'ผู้ขายเลิกผลิต', confirmed: true }, randomUUID())).toEqual({ ok: true, lines: 1 })
    const after = ok(await getReceivingView(ctx('proc_officer'), po.poId))
    expect(after).toMatchObject({ canCloseShort: false, closeShortPending: true, po: { status: 'PARTIALLY_RECEIVED', closeShort: [{ type: 'SHORT', disposition: 'CLOSE_SHORT', status: 'PENDING_APPROVAL', quantity: '4', reason: 'ผู้ขายเลิกผลิต' }] } })
    expect(receivingErrorKey(failureOf(await closeShort(ctx('proc_officer'), { poId: po.poId, reason: 'ซ้ำอีกครั้ง', confirmed: true }, randomUUID())))).toBe('CLOSE_SHORT_PENDING')
    // FR-P2P-010 AC2: asking is not closing — the PO closes only with an approved SHORT
    expect(await poStatus(po.poId)).toBe('PARTIALLY_RECEIVED')
    expect(await closePurchaseOrder(ctx('proc_officer'), { poId: po.poId }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'SHORT_NOT_APPROVED' } } })
  })
})

describe('[FR-P2P-010/AC3] a close-short gives back only what never came; nothing is counted twice (NEW-32, BR-BUD-06, BR-GR-04)', () => {
  it('goods received while the close-short waits are not given up: the approval cancels what is still missing and releases only that', async () => {
    const po = await sentPo([CEMENT])
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '6')]), randomUUID())).toMatchObject({ ok: true })
    expect(await closeShort(ctx('proc_officer'), { poId: po.poId, reason: 'ผู้ขายแจ้งว่าของหมด', confirmed: true }, randomUUID())).toEqual({ ok: true, lines: 1 })
    expect((await varianceOf(po.poId, 'CLOSE_SHORT')).quantity.toString()).toBe('4')

    // 3 more bags arrive while it waits: the receiver may still record them, as ordered goods
    expect(ok(await getReceivingView(ctx('receiver_con'), po.poId))).toMatchObject({ receivable: true, closeShortPending: true })
    const three = [line(po.lineIds[0]!, '3')]
    expect(await check('receiver_con', { poId: po.poId, photoFileIds: [], lines: three })).toMatchObject({ ok: true, preview: { lines: [{ accepted: '3', outstandingAfter: '1', excess: null }] } })
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, three), randomUUID())).toMatchObject({ ok: true, poStatus: 'PARTIALLY_RECEIVED' })

    const before = await balanceOf(po.budgetLineId)
    expect(before.committedSatang).toBe(1_100_000n)
    const variance = await varianceOf(po.poId, 'CLOSE_SHORT')
    await approveAll(org, variance.id)
    expect(await prisma.variance.findUniqueOrThrow({ where: { id: variance.id } })).toMatchObject({ status: 'APPROVED' })

    // 9 received + 1 given up = the 10 ordered; 1 × 1,100.00 goes back, the 9 received stay held for their invoice
    const after = await poLine(po.lineIds[0]!)
    expect([after.receivedQuantity.toString(), after.cancelledQuantity.toString()]).toEqual(['9', '1'])
    const balance = await balanceOf(po.budgetLineId)
    expect(balance.availableSatang - before.availableSatang).toBe(110_000n)
    expect(balance.committedSatang).toBe(990_000n)
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'budget.commitment_released', aggregateId: po.budgetLineId } })).toMatchObject({ data: { documentId: po.poId, amountSatang: '110000' } })
    expect(await poStatus(po.poId)).toBe('CLOSED')
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: po.poId, type: 'po.closed' } })).toMatchObject({ data: { via: 'CLOSE_SHORT', keptSatang: '990000', releasedSatang: '0' } })
  })

  it('everything came before the approval: nothing is given up or released, and the PO closes', async () => {
    const po = await sentPo([CEMENT])
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '6')]), randomUUID())).toMatchObject({ ok: true })
    expect(await closeShort(ctx('proc_officer'), { poId: po.poId, reason: 'ผู้ขายแจ้งว่าของหมด', confirmed: true }, randomUUID())).toEqual({ ok: true, lines: 1 })
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '4')]), randomUUID())).toMatchObject({ ok: true, poStatus: 'RECEIVED' })
    const before = await balanceOf(po.budgetLineId)
    await approveAll(org, (await varianceOf(po.poId, 'CLOSE_SHORT')).id)
    const after = await poLine(po.lineIds[0]!)
    expect([after.receivedQuantity.toString(), after.cancelledQuantity.toString()]).toEqual(['10', '0'])
    expect(await balanceOf(po.budgetLineId)).toEqual(before)
    expect(await poStatus(po.poId)).toBe('CLOSED')
  })

  it('a line closed short takes no more goods as ordered: what still comes on it is an excess to return, or to keep with the GR_VARIANCE approver (BR-GR-02, BR-GR-03)', async () => {
    const po = await sentPo([SAND, { ...SAND, description: 'หินคลุก' }])
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '6'), line(po.lineIds[1]!, '6')]), randomUUID())).toMatchObject({ ok: true })
    expect(await closeShort(ctx('proc_officer'), { poId: po.poId, reason: 'ผู้ขายแจ้งว่าของหมด', confirmed: true }, randomUUID())).toEqual({ ok: true, lines: 2 })
    // only the first line's close-short is approved: the PO waits for the other
    await approveAll(org, (await varianceOf(po.poId, 'CLOSE_SHORT', po.lineIds[0]!)).id)
    expect(await poStatus(po.poId)).toBe('PARTIALLY_RECEIVED')
    const given = await poLine(po.lineIds[0]!)
    expect([given.receivedQuantity.toString(), given.cancelledQuantity.toString()]).toEqual(['6', '4'])
    expect(ok(await getReceivingView(ctx('receiver_con'), po.poId)).po.lines[0]).toMatchObject({ ordered: '10', received: '6', cancelled: '4', outstanding: '0' })

    // 4 more of the first line: beyond what is still on order, so an excess with the approver named
    const four = [line(po.lineIds[0]!, '4')]
    const preview = await check('receiver_con', { poId: po.poId, photoFileIds: [], lines: four })
    expect(preview).toMatchObject({ ok: true, preview: { lines: [{ accepted: '0', excess: { quantity: '4', keep: { kind: 'ROUTE', ruleCode: 'GRV-01' } } }] } })
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, four), randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'EXCESS_DISPOSITION_REQUIRED', excess: '4' })
    expect(await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '4', { excessDisposition: 'RETURN_EXCESS' })]), randomUUID())).toMatchObject({ ok: true, varianceCount: 1, pendingApproval: 0 })
    expect((await poLine(po.lineIds[0]!)).receivedQuantity.toString()).toBe('6')
    // the second line, whose close-short still waits, takes its goods as ordered
    expect(await check('receiver_con', { poId: po.poId, photoFileIds: [], lines: [line(po.lineIds[1]!, '4')] })).toMatchObject({ ok: true, preview: { lines: [{ accepted: '4', excess: null }] } })
  })

  it('damaged goods waiting to be kept are not given up by a close-short and are not received over: once kept, the line is complete', async () => {
    const po = await sentPo([PLYWOOD])
    const photo = await photoOf(org, 'receiver_con')
    // 6 come, 1 of them damaged and kept (waiting for approval): 5 accepted, 1 waiting, 4 still to come
    expect(
      await postReceipt(ctx('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '6', { rejected: '1', damaged: true, damagedDisposition: 'ACCEPT_DAMAGED' })], { photoFileIds: [photo] }), randomUUID()),
    ).toMatchObject({ ok: true, pendingApproval: 1 })
    // what comes beyond the 4 still to come is an excess: the damaged one waiting counts as taken
    expect(await check('receiver_con', { poId: po.poId, photoFileIds: [], lines: [line(po.lineIds[0]!, '5')] })).toMatchObject({ ok: true, preview: { lines: [{ accepted: '4', excess: { quantity: '1' } }] } })

    const plan = ok(await getReceivingView(ctx('proc_officer'), po.poId))
    expect(plan.closeShortPlan).toMatchObject({ lines: [{ quantity: '4', amountSatang: 208_000n }] })
    expect(await closeShort(ctx('proc_officer'), { poId: po.poId, reason: 'ผู้ขายแจ้งว่าของหมด', confirmed: true }, randomUUID())).toEqual({ ok: true, lines: 1 })
    expect((await varianceOf(po.poId, 'CLOSE_SHORT')).quantity.toString()).toBe('4')
    const before = await balanceOf(po.budgetLineId)
    await approveAll(org, (await varianceOf(po.poId, 'CLOSE_SHORT')).id)
    // 4 given up, 4 × 520.00 back; the damaged one still waits, so the PO stays open
    const closed = await poLine(po.lineIds[0]!)
    expect([closed.receivedQuantity.toString(), closed.cancelledQuantity.toString()]).toEqual(['5', '4'])
    expect((await balanceOf(po.budgetLineId)).availableSatang - before.availableSatang).toBe(208_000n)
    expect(await poStatus(po.poId)).toBe('PARTIALLY_RECEIVED')
    // nothing else can be closed short: what is not in is the damaged one waiting
    expect(ok(await getReceivingView(ctx('proc_officer'), po.poId))).toMatchObject({ canCloseShort: false, closeShortWaitsForDamaged: true, closeShortPlan: null })
    expect(receivingErrorKey(failureOf(await closeShort(ctx('proc_officer'), { poId: po.poId, reason: 'ปิดที่เหลือ', confirmed: true }, randomUUID())))).toBe('DAMAGED_PENDING')

    // kept: 6 received + 4 given up = the 10 ordered, never more; the hold is what was received
    await approveAll(org, (await varianceOf(po.poId, 'ACCEPT_DAMAGED')).id)
    const kept = await poLine(po.lineIds[0]!)
    expect([kept.receivedQuantity.toString(), kept.cancelledQuantity.toString()]).toEqual(['6', '4'])
    expect((await balanceOf(po.budgetLineId)).committedSatang).toBe(312_000n)
    expect(await poStatus(po.poId)).toBe('RECEIVED')
  })
})
