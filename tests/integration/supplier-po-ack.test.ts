import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { getPortalPo, listPortalPos } from '@/server/portal/queries'
import { portalCtx } from '@/server/portal/session'
import { getPoAckStrip } from '@/server/queries/po-ack'
import { acknowledgePo, listPosAwaitingAck, poPdfUrlForContact, resetPoAck, updatePoDelivery } from '@/server/services/suppliers/po-ack'
import { AP_NOW, apOrg, sentPo, type ApOrg } from '../support/ap'

// S7-11 (FR-SUP-105 AC1–AC4 · BR-SUP ข้อ 14 · ADR-188 · INV-SUP-01): the supplier's contact sees the POs sent to its
// supplier only, acknowledges the current revision once with the date it delivers, moves the date with a reason; the
// requesters and the receiver hear of it (digest), of a new date at once with the buyer — no price in the words; a new
// revision sent to the supplier waits for its acknowledgement again (job po-ack-reset); PROCUREMENT sees the strip on
// the PO and the list of POs not acknowledged yet.

let ap: ApOrg
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

beforeAll(async () => {
  setDefaultOutboxSender(null)
  ap = await apOrg()
  await prisma.orgModule.create({ data: { organizationId: ap.org.organizationId, module: 'SUPPLIER', enabled: true, enabledAt: AP_NOW, contractRef: 'TEST-P2', reason: 'พอร์ทัลผู้ขาย' } })
  await prisma.supplier.update({ where: { id: ap.supplierId }, data: { portalEnabled: true } })
})

async function contactOf(supplierId: string): Promise<{ id: string; ctx: Ctx }> {
  const c = await prisma.supplierContact.create({ data: { organizationId: ap.org.organizationId, supplierId, nameTh: 'ผู้ติดต่อ', email: `ack-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: false, privacyNoticeVersion: '2026-11-01' } })
  return { id: c.id, ctx: portalCtx(ap.org.organizationId, c, AP_NOW) }
}

describe('[FR-SUP-105/AC1] the supplier sees its own POs sent to it', () => {
  it('a sent PO with its lines and totals; never a draft, never another supplier’s; its PDF by a short-lived address', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00', description: 'ท่อ PVC 4 นิ้ว' }])
    const mine = await contactOf(ap.supplierId)
    expect((await listPortalPos(mine.ctx)).map((p) => p.id)).toContain(po.id)
    const view = await getPortalPo(mine.ctx, po.id)
    expect(view).toMatchObject({ id: po.id, ackStatus: 'NOT_ACKNOWLEDGED', lines: [{ description: 'ท่อ PVC 4 นิ้ว', uom: expect.any(String) }] })
    const other = await prisma.supplier.create({ data: { organizationId: ap.org.organizationId, code: `S-${randomUUID().slice(0, 4)}`, nameTh: 'ผู้ขายอื่น', taxId: '0999999000020', portalEnabled: true } })
    const theirs = await contactOf(other.id)
    expect(await listPortalPos(theirs.ctx)).toEqual([])
    expect(await getPortalPo(theirs.ctx, po.id)).toBeNull()
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'APPROVED' } })
    expect(await getPortalPo(mine.ctx, po.id)).toBeNull()
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT' } })
    const pdf = await prisma.fileObject.create({ data: { organizationId: ap.org.organizationId, storageKey: `${ap.org.organizationId}/po/${randomUUID()}.pdf`, fileName: 'po.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE' } })
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { pdfFileId: pdf.id } })
    expect(await poPdfUrlForContact(mine.ctx, po.id)).toMatchObject({ ok: true, data: { url: expect.stringContaining('po.pdf') } })
    expect(await poPdfUrlForContact(theirs.ctx, po.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('[FR-SUP-105/AC2] [FR-SUP-105/AC3] acknowledge once per revision, then move the date with a reason', () => {
  it('acknowledged with its date, told in the digest and to the supplier; again refused; a new date told at once with the buyer, no price', async () => {
    const po = await sentPo(ap, [{ quantity: '5', unitPrice: '2000.00' }])
    const c = await contactOf(ap.supplierId)
    expect(await acknowledgePo(c.ctx, { poId: po.id, promisedDeliveryOn: '2026-10-01' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'PAST_DATE' } } })
    expect(await acknowledgePo(ap.org.ctxOf('proc_officer', AP_NOW), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await acknowledgePo(c.ctx, { poId: po.id, promisedDeliveryOn: '2026-10-20', note: 'ส่งรอบเช้า' }, key())).toMatchObject({ ok: true })
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, select: { supplierAckStatus: true, supplierPromisedDeliveryOn: true } })).toEqual({ supplierAckStatus: 'ACKNOWLEDGED', supplierPromisedDeliveryOn: new Date('2026-10-20T00:00:00Z') })
    const acked = await prisma.event.findFirstOrThrow({ where: { type: 'po.acknowledged', aggregateId: po.id } })
    expect(acked).toMatchObject({ actorType: 'SUPPLIER', actorSupplierContactId: c.id, channel: 'PORTAL', data: { revisionNo: 0, promisedDeliveryOn: '2026-10-20' } })
    const digest = await prisma.notification.findMany({ where: { subjectId: po.id, templateKey: 'po.acknowledged' } })
    expect(digest.length).toBeGreaterThan(0)
    expect(digest.every((n) => n.urgency === 'DIGEST')).toBe(true)
    expect(digest.map((n) => n.recipientMemberId)).toContain(ap.org.member.receiver_con)
    expect(await prisma.supplierNotice.count({ where: { subjectId: po.id, templateKey: 'supplier.po_delivery_ack', contactId: c.id } })).toBe(1)
    expect(await acknowledgePo(c.ctx, { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })

    expect(await updatePoDelivery(c.ctx, { poId: po.id, promisedDeliveryOn: '2026-10-20', reason: 'วันเดิม' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NO_CHANGE' } } })
    expect(await updatePoDelivery(c.ctx, { poId: po.id, promisedDeliveryOn: '2026-10-27', reason: 'โรงงานผลิตไม่ทัน' }, key())).toMatchObject({ ok: true })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'po.delivery_date_changed', aggregateId: po.id } })).toMatchObject({ data: { from: '2026-10-20', to: '2026-10-27' } })
    const moved = await prisma.notification.findMany({ where: { subjectId: po.id, templateKey: 'po.delivery_changed' } })
    expect(moved.every((n) => n.urgency === 'IMMEDIATE')).toBe(true)
    expect(moved.map((n) => n.recipientMemberId)).toEqual(expect.arrayContaining([ap.org.member.receiver_con, po.createdById]))
    expect(JSON.stringify(moved.map((n) => n.data))).not.toMatch(/2000|10000|Satang/)
    expect(await getPoAckStrip(ap.org.ctxOf('proc_officer', AP_NOW), po.id)).toMatchObject({ status: 'DELIVERY_UPDATED', promisedDeliveryOn: '2026-10-27', movedFrom: '2026-10-20' })
  })

  it('a PO received or closed takes no acknowledgement', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '10.00' }])
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'RECEIVED' } })
    const c = await contactOf(ap.supplierId)
    expect(await acknowledgePo(c.ctx, { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})

describe('[FR-SUP-105/AC4] a new revision waits for its acknowledgement again', () => {
  it('po-ack-reset: NOT_ACKNOWLEDGED with its event; an older revision changes nothing; PROCUREMENT lists POs not acknowledged', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '50.00' }])
    const c = await contactOf(ap.supplierId)
    expect((await listPosAwaitingAck(ap.org.ctxOf('proc_officer', AP_NOW))).map((r) => r.id)).toContain(po.id)
    expect(await acknowledgePo(c.ctx, { poId: po.id, promisedDeliveryOn: '2026-10-15' }, key())).toMatchObject({ ok: true })
    expect((await listPosAwaitingAck(ap.org.ctxOf('proc_officer', AP_NOW))).map((r) => r.id)).not.toContain(po.id)
    expect(await resetPoAck(ap.org.organizationId, po.id, 1, AP_NOW)).toBe(false)
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { revisionNo: 1 } })
    expect(await resetPoAck(ap.org.organizationId, po.id, 1, AP_NOW)).toBe(true)
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, select: { supplierAckStatus: true, supplierPromisedDeliveryOn: true } })).toEqual({ supplierAckStatus: 'NOT_ACKNOWLEDGED', supplierPromisedDeliveryOn: null })
    expect(await prisma.event.count({ where: { type: 'po.ack_reset', aggregateId: po.id } })).toBe(1)
    expect(await acknowledgePo(c.ctx, { poId: po.id }, key())).toMatchObject({ ok: true })
    expect(await prisma.poAcknowledgement.count({ where: { poId: po.id, kind: 'ACK' } })).toBe(2)
    expect(await listPosAwaitingAck(ap.org.ctxOf('req_con', AP_NOW))).toEqual([])
  })
})
