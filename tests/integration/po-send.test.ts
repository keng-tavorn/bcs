import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EmailSendError, setEmailProvider, type EmailMessage } from '@/integrations/email-provider'
import { readObject } from '@/integrations/storage'
import { prisma } from '@/server/db/client'
import { sendPurchaseOrder } from '@/server/services/purchase-orders/send'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { attachmentOf, messagesTo } from '../support/mailpit'
import { p2p } from '../support/p2p'

// S4-06 (spec §6.4 APPROVED → po.send → SENT, FR-P2P-005): PROCUREMENT e-mails an approved PO to its supplier with the
// PDF; a mail server that refuses it leaves the PO APPROVED and tells procurement; sending again needs a reason and is
// an event every time. The e-mail really goes to Mailpit; bounces and outages come from a provider the test sets.

const NOW = new Date('2026-10-06T02:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let kit: ReturnType<typeof p2p>
const proc = () => org.ctxOf('proc_officer', NOW)

beforeAll(async () => {
  org = await createDoaOrg()
  kit = p2p(org, NOW)
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
})

afterEach(() => setEmailProvider(null))

/** An approved PO of a supplier of its own, whose e-mail is new to Mailpit */
let branch = 0
async function approvedPo(options: { email?: string | null } = {}) {
  const email = options.email === undefined ? `po-${randomUUID().slice(0, 8)}@supplier.test` : options.email
  // one tax id, a branch of its own each (tax id and branch are unique per organization)
  const branchCode = String(++branch).padStart(5, '0')
  const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 8)}`, nameTh: 'บริษัท ผู้ขายทดสอบ จำกัด', taxId: '0999999000012', branchCode, email } })
  const line = await kit.fundedLine(500_000n)
  const pr = await kit.approvedRequest(line, [{ quantity: '10', unitPrice: '1250.00', description: 'ปูนซีเมนต์ปอร์ตแลนด์ประเภทหนึ่ง' }])
  const po = await kit.approvedPo([pr.lines[0]!.id], supplier.id)
  return { po, email, requesterId: pr.requesterMemberId }
}

/** A provider that refuses or cannot be reached, counting what it was asked to send */
function failingProvider(error: EmailSendError) {
  const asked: EmailMessage[] = []
  setEmailProvider({
    async send(message) {
      asked.push(message)
      throw error
    },
  })
  return asked
}

describe('[FR-P2P-005/AC1] an approved PO goes to the supplier by e-mail with its PDF', () => {
  it('sends to the supplier, reply-to the officer, with the PO PDF; the PO is SENT with sentAt and sentToEmail', async () => {
    const { po, email, requesterId } = await approvedPo()
    expect(po.status).toBe('APPROVED')
    const result = ok(await sendPurchaseOrder(proc(), { poId: po.id }, key()))
    expect(result).toMatchObject({ poId: po.id, status: 'SENT', sent: true, bounce: null })

    const sent = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(sent).toMatchObject({ status: 'SENT', sentAt: NOW, sentToEmail: email, pdfFileId: result.pdfFileId, sendBouncedAt: null })

    const [message, ...more] = await messagesTo(email!)
    expect(more).toEqual([])
    expect(message!.Subject).toContain(po.number!)
    expect(message!.ReplyTo.map((r) => r.Address)).toEqual([(await prisma.member.findUniqueOrThrow({ where: { id: org.member.proc_officer! } })).email])
    expect(message!.Attachments).toEqual([expect.objectContaining({ FileName: `${po.number}.pdf`, ContentType: 'application/pdf' })])
    const attached = await attachmentOf(message!, message!.Attachments[0]!.PartID)
    expect(new TextDecoder('latin1').decode(attached.subarray(0, 5))).toBe('%PDF-')

    // The same PDF is kept with the PO (FR-PLT-009) and linked as PO_PDF
    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: result.pdfFileId } })
    expect(file).toMatchObject({ mimeType: 'application/pdf', fileName: `${po.number}.pdf`, uploadedById: org.member.proc_officer, sizeBytes: attached.length })
    expect(Buffer.from(await readObject(file.storageKey)).equals(Buffer.from(attached))).toBe(true)
    expect(await prisma.fileLink.count({ where: { fileId: file.id, subjectType: 'PurchaseOrder', subjectId: po.id, kind: 'PO_PDF' } })).toBe(1)

    const events = await prisma.event.findMany({ where: { aggregateId: po.id, type: { in: ['po.sent', 'po.send_bounced'] } }, select: { type: true, data: true } })
    expect(events).toEqual([{ type: 'po.sent', data: expect.objectContaining({ from: 'APPROVED', resend: false, reasonCommentId: null, pdfFileId: result.pdfFileId }) }])
    // §10.1 po.sent: the requester in the daily summary; the RECEIVER of the department at once (S17-05, FR-LINE-303 AC5)
    const notified = await prisma.notification.findMany({ where: { templateKey: { in: ['po.sent', 'po.sent_receiver'] }, subjectId: po.id }, select: { recipientMemberId: true, templateKey: true, urgency: true, data: true } })
    expect(notified.map((n) => [n.recipientMemberId, n.templateKey, n.urgency]).sort()).toEqual(
      [
        [requesterId, 'po.sent', 'DIGEST'],
        [org.member.receiver_con!, 'po.sent_receiver', 'IMMEDIATE'],
      ].sort(),
    )
    expect(notified.find((n) => n.recipientMemberId === org.member.receiver_con)!.data).toEqual({ poId: po.id, number: po.number })
  })

  it('a supplier without an e-mail address, a PO not yet approved, and anybody but PROCUREMENT are refused', async () => {
    const { po } = await approvedPo({ email: null })
    expect(await sendPurchaseOrder(proc(), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'supplierEmail', reason: 'MISSING' } } })
    const other = await approvedPo()
    for (const who of ['req_con', 'fin_officer', 'coo']) {
      expect(await sendPurchaseOrder(org.ctxOf(who, NOW), { poId: other.po.id }, key()), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    await prisma.purchaseOrder.update({ where: { id: other.po.id }, data: { status: 'PENDING_APPROVAL' } })
    expect(await sendPurchaseOrder(proc(), { poId: other.po.id }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'PENDING_APPROVAL' } } })
    expect(await sendPurchaseOrder(proc(), { poId: randomUUID() }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await messagesTo(other.email!)).toEqual([])
  })

  it('two officers pressing send together e-mail the supplier once', async () => {
    const { po, email } = await approvedPo()
    const [a, b] = await Promise.all([sendPurchaseOrder(proc(), { poId: po.id }, key()), sendPurchaseOrder(proc(), { poId: po.id }, key())])
    expect([a, b].filter((r) => r.ok)).toHaveLength(1)
    expect([a, b].find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'reason', reason: 'REQUIRED' } } })
    expect(await messagesTo(email!)).toHaveLength(1)
  })

  it('a provider that cannot be reached changes nothing and says so', async () => {
    const { po } = await approvedPo()
    const asked = failingProvider(new EmailSendError(false, 'ECONNECTION'))
    expect(await sendPurchaseOrder(proc(), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'EXTERNAL_SERVICE_ERROR', details: { service: 'email', code: 'ECONNECTION' } } })
    expect(asked).toHaveLength(1)
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).toMatchObject({ status: 'APPROVED', sentAt: null, sendBouncedAt: null, pdfFileId: null })
    expect(await prisma.event.count({ where: { aggregateId: po.id, type: { in: ['po.sent', 'po.send_bounced'] } } })).toBe(0)
    expect(await prisma.fileLink.count({ where: { subjectId: po.id, kind: 'PO_PDF' } })).toBe(0)
  })
})

describe('[FR-P2P-005/AC2] a bounced e-mail leaves the PO APPROVED and tells procurement', () => {
  it('keeps APPROVED, records the bounce, tells PROCUREMENT; a corrected send clears it and the PO is SENT', async () => {
    const { po, email } = await approvedPo()
    failingProvider(new EmailSendError(true, 'SMTP_550'))
    const bounced = ok(await sendPurchaseOrder(proc(), { poId: po.id }, key()))
    expect(bounced).toMatchObject({ status: 'APPROVED', sent: false, bounce: 'SMTP_550' })
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).toMatchObject({ status: 'APPROVED', sentAt: null, sentToEmail: null, sendBouncedAt: NOW, sendBounceReason: 'SMTP_550' })
    expect(await prisma.event.findFirst({ where: { aggregateId: po.id, type: 'po.send_bounced' }, select: { data: true } })).toEqual({ data: expect.objectContaining({ status: 'APPROVED', code: 'SMTP_550', resend: false }) })
    const procurement = await prisma.roleAssignment.findMany({ where: { organizationId: org.organizationId, role: 'PROCUREMENT', revokedAt: null }, select: { memberId: true } })
    const told = await prisma.notification.findMany({ where: { templateKey: 'po.send_bounced', subjectId: po.id }, select: { recipientMemberId: true, urgency: true } })
    expect(told.map((t) => t.recipientMemberId).sort()).toEqual([...new Set(procurement.map((p) => p.memberId))].sort())
    expect(told.every((t) => t.urgency === 'IMMEDIATE')).toBe(true)

    // AC3: sending again needs a reason
    setEmailProvider(null)
    expect(await sendPurchaseOrder(proc(), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'reason', reason: 'REQUIRED' } } })
    const again = ok(await sendPurchaseOrder(proc(), { poId: po.id, reason: 'แก้อีเมลผู้ขายแล้ว' }, key()))
    expect(again).toMatchObject({ status: 'SENT', sent: true })
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).toMatchObject({ status: 'SENT', sentAt: NOW, sendBouncedAt: null, sendBounceReason: null })
    expect(await messagesTo(email!)).toHaveLength(1)
  })
})

describe('[FR-P2P-005/AC3] the supplier gets the PO again with a reason, an event each time', () => {
  it('a SENT PO goes again only with a reason, keeps its status, and every send is an event', async () => {
    const { po, email } = await approvedPo()
    ok(await sendPurchaseOrder(proc(), { poId: po.id }, key()))
    expect(await sendPurchaseOrder(proc(), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'reason' } } })
    const again = ok(await sendPurchaseOrder(proc(), { poId: po.id, reason: 'ผู้ขายขอใบสั่งซื้ออีกครั้ง' }, key()))
    expect(again).toMatchObject({ status: 'SENT', sent: true })
    const events = await prisma.event.findMany({ where: { aggregateId: po.id, type: 'po.sent' }, orderBy: { seq: 'asc' }, select: { data: true } })
    expect(events.map((e) => e.data)).toEqual([expect.objectContaining({ resend: false, reasonCommentId: null }), expect.objectContaining({ from: 'SENT', resend: true, reasonCommentId: expect.any(String) })])
    const reasonCommentId = (events[1]!.data as { reasonCommentId: string }).reasonCommentId
    expect(await prisma.comment.findUniqueOrThrow({ where: { id: reasonCommentId } })).toMatchObject({ subjectType: 'PurchaseOrder', subjectId: po.id, body: 'ผู้ขายขอใบสั่งซื้ออีกครั้ง' })
    const messages = await messagesTo(email!)
    expect(messages).toHaveLength(2)
    expect(messages[1]!.Subject).toContain('ส่งอีกครั้ง')
    // Once goods are all in, the PO is not sent again
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'RECEIVED' } })
    expect(await sendPurchaseOrder(proc(), { poId: po.id, reason: 'ขออีกครั้ง' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})
