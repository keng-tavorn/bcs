import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx, systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { sendSupplierNotice } from '@/server/notifications/supplier-notices'
import { renderNotification } from '@/server/notifications/templates'
import { getExceptionHelp, sendExceptionMessage } from '@/server/services/ap/exception-help'
import { recheckInvoice } from '@/server/services/ap/exceptions'
import { messagesTo } from '../support/mailpit'
import { AP_NOW, apOrg, codedDraft, key, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'

// NEW-126 (FR-AP-103 AC6 AC7, ADR-081): the helper of an invoice's open differences. Who sees it (the role a difference is
// sent to under BR-MATCH-09, and FINANCE who records invoices — nobody else), what code gathers for it, the ways it offers
// being the ways the reader really has, and match_exception.message: sent by the member who pressed send only, to a
// receiver or requester of the line or to the supplier, each an Event naming them without the words, with LINE and e-mail
// carrying the numbers only (BR-NOTI-01). The AI is never involved: the helper is the same with the AI module off.

let ap: ApOrg
beforeAll(async () => {
  ap = await apOrg()
  // A RECEIVER of another department, who reads none of these invoices
  await prisma.roleAssignment.create({ data: { organizationId: ap.org.organizationId, memberId: ap.org.member.dm_it!, role: 'RECEIVER', scopeDepartmentId: ap.org.department.IT!, grantedAt: AP_NOW } })
})

const as = (code: string) => ap.org.ctxOf(code, AP_NOW)
let invoiceCount = 0
/** Each invoice 4 days before the one before, so none is a possible duplicate of another (BR-MATCH-12) */
const nextDate = () => new Date(Date.UTC(2026, 9, 10 - 4 * ++invoiceCount)).toISOString().slice(0, 10)

/** A PO of one line received in full and its invoice 10% over the PO's price: EXCEPTION PRICE_OVER (to PROCUREMENT) */
async function priceOver(description: string) {
  const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00', description }])
  await receive(ap, po, { 0: '1' })
  const draft = await codedDraft(ap, po, { no: `HP-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '77.00', lines: [{ line: 0, quantity: '1', unitPrice: '1100.00' }] })
  const submitted = ok(await submit(ap, draft))
  expect(submitted.status).toBe('EXCEPTION')
  const exception = await prisma.matchException.findFirstOrThrow({ where: { invoiceId: draft.invoiceId, status: 'OPEN' } })
  return { po, invoiceId: draft.invoiceId, number: submitted.number, exceptionId: exception.id }
}

/** A PO of 10 with 6 received, invoiced for 10: EXCEPTION QTY_NOT_RECEIVED (to the receivers) */
async function notReceived() {
  const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00', description: `ปูน ${randomUUID().slice(0, 4)}` }])
  await receive(ap, po, { 0: '6' })
  const draft = await codedDraft(ap, po, { no: `HQ-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '70.00', lines: [{ line: 0, quantity: '10', unitPrice: '100.00' }] })
  const submitted = ok(await submit(ap, draft))
  expect(submitted.status).toBe('EXCEPTION')
  const exception = await prisma.matchException.findFirstOrThrow({ where: { invoiceId: draft.invoiceId, status: 'OPEN' } })
  expect(exception.type).toBe('QTY_NOT_RECEIVED')
  return { po, invoiceId: draft.invoiceId, number: submitted.number, exceptionId: exception.id }
}

const fixesOf = async (code: string, invoiceId: string) => ok(await getExceptionHelp(as(code), invoiceId)).helps.map((h) => h.fixes.map((f) => f.key))

describe('[FR-AP-103/AC6] the helper of a difference: seen by whom it is sent to and by FINANCE, built by code', () => {
  it('gathers the PO line, what this invoice bills and the past prices for a price over, and offers PROCUREMENT and FINANCE their own ways', async () => {
    const description = `เหล็ก ${randomUUID().slice(0, 4)}`
    // Bought before at 950.00 (another PO of the same item); this PO is not a past price of itself
    const earlier = await sentPo(ap, [{ quantity: '1', unitPrice: '950.00', description }])
    const { invoiceId, po } = await priceOver(description)

    const help = ok(await getExceptionHelp(as('proc_officer'), invoiceId))
    expect(help.helps).toHaveLength(1)
    const h = help.helps[0]!
    expect(h).toMatchObject({ type: 'PRICE_OVER', assigneeRole: 'PROCUREMENT', amountSatang: 10_000n })
    expect(h.line).toMatchObject({ lineNo: 1, poLineNo: 1, description, uom: 'ชิ้น', ordered: '1', received: '1', invoiced: '1', poUnitPriceSatang: 100_000n, unitPriceSatang: 110_000n })
    // Not a catalogue item: no agreed price to compare
    expect(h.agreement).toEqual({ kind: 'NO_ITEM' })
    expect(h.pastPrices?.count).toBe(1)
    expect(h.pastPrices?.recent[0]).toMatchObject({ poNumber: earlier.number, unitPriceSatang: 95_000n })
    expect(h.receipts).toBeNull()
    expect(h.fixes.map((f) => f.key)).toEqual(['VARIANCE', 'PO_CHANGE', 'ASK', 'EMAIL_SUPPLIER', 'RECHECK', 'REJECT'])
    expect(h.fixes.find((f) => f.key === 'PO_CHANGE')!.href).toBe(`/procurement/pos/${po.id}/change`)
    // The requester of the line is the one to ask about a price; the reader never asks themself
    expect(h.recipients.map((r) => [r.id, r.relation])).toEqual([[ap.org.member.req_con, 'REQUESTER']])
    expect(h.email).toEqual({ hasEmail: true })

    // FINANCE: no variance and no PO change of its own, but reopening is
    expect(await fixesOf('fin_officer', invoiceId)).toEqual([['ASK', 'EMAIL_SUPPLIER', 'RECHECK', 'REOPEN', 'REJECT']])
  })

  it('sends a quantity not received to its receivers: they receive the rest; PROCUREMENT, who reads the invoice, gets no helper of it', async () => {
    const { invoiceId, po } = await notReceived()
    const theirs = ok(await getExceptionHelp(as('receiver_con'), invoiceId)).helps
    expect(theirs).toHaveLength(1)
    expect(theirs[0]!.receipts).toMatchObject({ count: 1 })
    expect(theirs[0]!.line).toMatchObject({ ordered: '10', received: '6', invoiced: '10', invoicedElsewhere: '0' })
    expect(theirs[0]!.fixes.map((f) => f.key)).toEqual(['RECEIVE', 'ASK', 'RECHECK'])
    expect(theirs[0]!.fixes[0]!.href).toBe(`/receiving/${po.id}`)
    // A receiver does not e-mail the supplier from here
    expect(theirs[0]!.email).toBeNull()
    expect(theirs[0]!.recipients.map((r) => r.relation)).toEqual(['REQUESTER'])
    expect(theirs[0]!.pastPrices).toBeNull()

    // FINANCE asks the receiver first, then the requester; it does not receive
    const finance = ok(await getExceptionHelp(as('fin_officer'), invoiceId)).helps[0]!
    expect(finance.fixes.map((f) => f.key)).toEqual(['ASK', 'RECHECK', 'EMAIL_SUPPLIER', 'REOPEN', 'REJECT'])
    expect(finance.recipients.map((r) => [r.id, r.relation])).toEqual([
      [ap.org.member.receiver_con, 'RECEIVER'],
      [ap.org.member.req_con, 'REQUESTER'],
    ])

    // PROCUREMENT reads the invoice (it may reject one) but the difference is not sent to it
    expect(ok(await getExceptionHelp(as('proc_officer'), invoiceId)).helps).toEqual([])
  })

  it('refuses whoever does not read the invoice: a RECEIVER of another department, the auditor, the requester', async () => {
    const { invoiceId } = await notReceived()
    for (const code of ['dm_it', 'auditor', 'req_con']) {
      const r = await getExceptionHelp(as(code), invoiceId)
      expect(r.ok, code).toBe(false)
      if (!r.ok) expect(r.error.code, code).toBe('FORBIDDEN')
    }
    expect((await getExceptionHelp(systemCtx(ap.org.organizationId, AP_NOW, 'test'), invoiceId)).ok).toBe(false)
  })

  it('works the same with the AI module off: nothing of it comes from an AI', async () => {
    const { invoiceId } = await priceOver(`ทราย ${randomUUID().slice(0, 4)}`)
    const before = ok(await getExceptionHelp(as('fin_officer'), invoiceId))
    await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'AI' }, data: { enabled: false } })
    try {
      expect(ok(await getExceptionHelp(as('fin_officer'), invoiceId))).toEqual(before)
    } finally {
      await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'AI' }, data: { enabled: true } })
    }
  })

  it('has nothing to offer once the difference is settled', async () => {
    const { invoiceId, po } = await notReceived()
    await receive(ap, po, { 0: '4' })
    // gr.posted rechecks it by SYSTEM through a job; here by hand
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    if (invoice.status === 'EXCEPTION') ok(await recheckInvoice(as('fin_officer'), { invoiceId, version: invoice.version }, key()))
    expect(ok(await getExceptionHelp(as('fin_officer'), invoiceId)).helps).toEqual([])
  })
})

describe('[FR-AP-103/AC7] what the helper drafted goes when a member presses send, to the line’s people or the supplier', () => {
  it('sends FINANCE’s question to the receiver: the event names who sent it, the bell has the words, LINE and e-mail the numbers only', async () => {
    const { invoiceId, number, po, exceptionId } = await notReceived()
    const text = `ได้รับปูนครบ ${number} หรือยัง ราคา 100.00 บาท`
    const send = { exceptionId, to: 'MEMBER' as const, memberId: ap.org.member.receiver_con!, text }
    const sent = key()
    expect(ok(await sendExceptionMessage(as('fin_officer'), send, sent))).toEqual({ exceptionId, to: 'MEMBER' })
    // The same submission again is the same send
    ok(await sendExceptionMessage(as('fin_officer'), send, sent))

    const events = await prisma.event.findMany({ where: { aggregateType: 'Invoice', aggregateId: invoiceId, type: 'invoice.question_sent' } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actorType: 'USER', actorMemberId: ap.org.member.fin_officer })
    expect(events[0]!.data).toEqual({ exceptionId, type: 'QTY_NOT_RECEIVED', recipientMemberId: ap.org.member.receiver_con, relation: 'RECEIVER' })
    expect(JSON.stringify(events[0]!.data)).not.toContain('ปูน')

    const notices = await prisma.notification.findMany({ where: { templateKey: 'invoice.question', subjectId: invoiceId } })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ recipientMemberId: ap.org.member.receiver_con, urgency: 'IMMEDIATE' })
    const outside = renderNotification(notices[0]!, 'th')
    expect(outside.title).toContain(number!)
    expect(outside.title).toContain(po.number!)
    // BR-NOTI-01: no line, no unit price, no name outside BCS
    expect(`${outside.title} ${outside.body}`).not.toContain('ปูน')
    expect(`${outside.title} ${outside.body}`).not.toContain('100.00')
    expect(`${outside.title} ${outside.body}`).not.toContain('fin_officer')
    expect(outside.href).toBe(`/receiving/${po.id}`)
    const bell = renderNotification(notices[0]!, 'th', 'IN_APP')
    expect(bell.title).toContain('ผู้ใช้ fin_officer')
    expect(bell.body).toBe(text)
  })

  it('refuses a recipient who is not a receiver or requester of the line, and a member the difference is not sent to', async () => {
    const { exceptionId, invoiceId } = await notReceived()
    const toAuditor = await sendExceptionMessage(as('fin_officer'), { exceptionId, to: 'MEMBER', memberId: ap.org.member.auditor!, text: 'ถามหน่อย' }, key())
    expect(toAuditor.ok).toBe(false)
    if (!toAuditor.ok) expect(toAuditor.error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'RECIPIENT_NOT_ALLOWED' } })
    // PROCUREMENT reads the invoice but the quantity is not sent to it
    const fromProcurement = await sendExceptionMessage(as('proc_officer'), { exceptionId, to: 'MEMBER', memberId: ap.org.member.req_con!, text: 'ถามหน่อย' }, key())
    expect(fromProcurement.ok).toBe(false)
    if (!fromProcurement.ok) expect(fromProcurement.error.code).toBe('FORBIDDEN')
    // A receiver may ask the requester, never e-mail the supplier
    const fromReceiver = await sendExceptionMessage(as('receiver_con'), { exceptionId, to: 'SUPPLIER', text: 'ส่งของไม่ครบ' }, key())
    expect(fromReceiver.ok).toBe(false)
    if (!fromReceiver.ok) expect(fromReceiver.error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'SUPPLIER_NOT_ALLOWED' } })
    ok(await sendExceptionMessage(as('receiver_con'), { exceptionId, to: 'MEMBER', memberId: ap.org.member.req_con!, text: 'ได้รับของครบไหม' }, key()))
    // A RECEIVER of another department reads nothing of it
    expect((await sendExceptionMessage(as('dm_it'), { exceptionId, to: 'MEMBER', memberId: ap.org.member.req_con!, text: 'ถาม' }, key())).ok).toBe(false)
    expect(await prisma.event.count({ where: { aggregateId: invoiceId, type: 'invoice.question_sent' } })).toBe(1)
  })

  it('BR-AI-01: an agent or a job never sends; only a member who pressed send', async () => {
    const { exceptionId, invoiceId } = await notReceived()
    const input = { exceptionId, to: 'MEMBER' as const, memberId: ap.org.member.req_con!, text: 'ได้รับของครบไหม' }
    const agent = makeCtx({ organizationId: ap.org.organizationId, actor: { type: 'AI_AGENT', agentId: 'INSIGHT' }, channel: 'SYSTEM', now: AP_NOW })
    for (const ctx of [agent, systemCtx(ap.org.organizationId, AP_NOW, 'test')]) {
      const r = await sendExceptionMessage(ctx, input, key())
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('FORBIDDEN')
    }
    expect(await prisma.event.count({ where: { aggregateId: invoiceId, type: 'invoice.question_sent' } })).toBe(0)
  })

  it('e-mails the supplier what PROCUREMENT confirmed, through SupplierNotice once, and refuses a supplier without an address', async () => {
    const { invoiceId, number, exceptionId } = await priceOver(`กระเบื้อง ${randomUUID().slice(0, 4)}`)
    const text = 'ราคาต่อหน่วย 1,100.00 บาท ไม่ตรงกับใบสั่งซื้อ 1,000.00 บาท\nโปรดส่งใบลดหนี้'
    ok(await sendExceptionMessage(as('proc_officer'), { exceptionId, to: 'SUPPLIER', text }, key()))
    const asked = await prisma.event.findFirstOrThrow({ where: { aggregateId: invoiceId, type: 'invoice.supplier_asked' } })
    expect(asked).toMatchObject({ actorType: 'USER', actorMemberId: ap.org.member.proc_officer })
    expect(JSON.stringify(asked.data)).not.toContain('1,100.00')
    const notice = await prisma.supplierNotice.findFirstOrThrow({ where: { subjectId: invoiceId, templateKey: 'supplier.invoice_question' } })
    expect(notice).toMatchObject({ status: 'PENDING', toEmail: 'ap-supplier@test.bcs.local' })
    expect((asked.data as { noticeId: string }).noticeId).toBe(notice.id)

    expect(await sendSupplierNotice(ap.org.organizationId, notice.id, AP_NOW)).toBe('SENT')
    const mail = (await messagesTo('ap-supplier@test.bcs.local')).find((m) => m.Text.includes(number!) && m.Subject.startsWith('คำถามเรื่องใบแจ้งหนี้'))
    expect(mail).toBeDefined()
    expect(mail!.Text).toContain('ราคาต่อหน่วย 1,100.00 บาท ไม่ตรงกับใบสั่งซื้อ 1,000.00 บาท')
    expect(mail!.Text).toContain('โปรดส่งใบลดหนี้')
    expect(mail!.Text).toContain('ผู้ติดต่อ: ผู้ใช้ proc_officer')

    await prisma.supplier.update({ where: { id: ap.supplierId }, data: { email: null } })
    try {
      const { exceptionId: other, invoiceId: otherInvoice } = await priceOver(`หิน ${randomUUID().slice(0, 4)}`)
      expect(ok(await getExceptionHelp(as('fin_officer'), otherInvoice)).helps[0]!).toMatchObject({ email: { hasEmail: false } })
      expect(await fixesOf('fin_officer', otherInvoice)).toEqual([['ASK', 'RECHECK', 'REOPEN', 'REJECT']])
      const refused = await sendExceptionMessage(as('fin_officer'), { exceptionId: other, to: 'SUPPLIER', text: 'โปรดแก้ใบ' }, key())
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'SUPPLIER_NO_EMAIL' } })
      expect(await prisma.supplierNotice.count({ where: { subjectId: otherInvoice, templateKey: 'supplier.invoice_question' } })).toBe(0)
    } finally {
      await prisma.supplier.update({ where: { id: ap.supplierId }, data: { email: 'ap-supplier@test.bcs.local' } })
    }
  })

  it('refuses a difference that is no longer open', async () => {
    const { invoiceId, po, exceptionId } = await notReceived()
    await receive(ap, po, { 0: '4' })
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    if (invoice.status === 'EXCEPTION') ok(await recheckInvoice(as('fin_officer'), { invoiceId, version: invoice.version }, key()))
    const r = await sendExceptionMessage(as('fin_officer'), { exceptionId, to: 'MEMBER', memberId: ap.org.member.receiver_con!, text: 'ได้รับครบไหม' }, key())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(['INVALID_STATE_TRANSITION', 'FORBIDDEN']).toContain(r.error.code)
  })
})
