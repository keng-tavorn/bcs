import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import { beforeAll, describe, expect, it } from 'vitest'
import { InboxReadError, messageIdOf, type EmailInbox, type InboundMessage } from '@/integrations/email-inbound'
import { prisma } from '@/server/db/client'
import { createInvoice } from '@/server/services/ap'
import { uploadInvoiceFile } from '@/server/services/ap/files'
import { createInvoiceFromInbox, ignoreInboundEmail, INBOX_MAX_ATTEMPTS, pollAllInvoiceInboxes, pollInvoiceInbox } from '@/server/services/ap/inbox'
import { etaxXml } from '../support/etax-files'
import { AP_NOW, apOrg, fin, key, ok, receive, sentPo, type ApOrg } from '../support/ap'

// S8-07 (FR-AP-101 AC2 AC4, BR-AP-02, BR-IVC-07, ADR-123): mail sent to Mailpit at an inbox address made for this file
// (so lanes and tests never read each other's mail) becomes drafts with the supplier and the PO proposed; the same mail
// twice is one message and one draft; files of other kinds are skipped with a reason; the same e-Tax file gives the same
// values by upload and by e-mail; a message that cannot be read is tried again three times. AI is off in this org.

const smtp = nodemailer.createTransport({ host: 'localhost', port: 1025, secure: false })

let ap: ApOrg
let inbox: string
beforeAll(async () => {
  ap = await apOrg()
  inbox = `inbox-${randomUUID().slice(0, 8)}@test.bcs.local`
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ap.org.organizationId }, select: { settings: true } })
  const settings = org.settings as Record<string, unknown>
  await prisma.organization.update({ where: { id: ap.org.organizationId }, data: { settings: { ...settings, ap: { ...((settings.ap as object) ?? {}), inboxAddress: inbox } } } })
})

const send = (mail: { subject: string; from?: string; messageId?: string; attachments?: Array<{ filename: string; content: string | Uint8Array; contentType?: string }> }) =>
  smtp.sendMail({
    from: mail.from ?? 'ap-supplier@test.bcs.local',
    to: inbox,
    subject: mail.subject,
    text: 'เนื้อความนี้ต้องไม่ถูกเก็บ',
    ...(mail.messageId ? { messageId: mail.messageId } : {}),
    attachments: (mail.attachments ?? []).map((a) => ({ filename: a.filename, content: typeof a.content === 'string' ? a.content : Buffer.from(a.content), ...(a.contentType ? { contentType: a.contentType } : {}) })),
  })

const emailOf = (messageId: string) => prisma.inboundEmail.findFirst({ where: { organizationId: ap.org.organizationId, messageId: messageIdOf(messageId) } })

describe('[FR-AP-101/AC2] the inbox makes a draft per invoice file with the supplier and the PO proposed', () => {
  it('an e-Tax XML naming the PO in the subject becomes an EMAIL draft; a text file is skipped with its reason; the body is not kept', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '10' })
    const messageId = `<${randomUUID()}@supplier.test>`
    const invoiceNo = `EM-${randomUUID().slice(0, 6)}`
    await send({ subject: `ใบแจ้งหนี้ตาม ${po.number}`, messageId, attachments: [{ filename: 'invoice.xml', content: etaxXml({ invoiceNo }), contentType: 'application/xml' }, { filename: 'note.txt', content: 'hello' }] })
    const polled = ok(await pollInvoiceInbox(fin(ap)))
    expect(polled).toMatchObject({ provider: 'mailpit', address: inbox, received: 1, drafts: 1 })
    const email = (await emailOf(messageId))!
    expect(email).toMatchObject({ status: 'PROCESSED', attachmentCount: 1, fromAddress: 'ap-supplier@test.bcs.local', toAddress: inbox, poRefsFound: [po.number] })
    expect(JSON.stringify(email)).not.toContain('เนื้อความนี้')
    const draft = await prisma.invoice.findFirstOrThrow({ where: { inboundEmailId: email.id } })
    expect(draft).toMatchObject({ status: 'DRAFT', channel: 'EMAIL', prefill: 'ETAX_XML', poId: po.id, supplierId: ap.supplierId, supplierInvoiceNo: invoiceNo, statedVatSatang: 70_000n, recordedById: null })
    const processed = await prisma.event.findFirstOrThrow({ where: { aggregateId: email.id, type: 'inbound_email.processed' } })
    expect(processed.data).toMatchObject({ draftCount: 1, pendingCount: 0, skipped: [{ fileName: 'note.txt', reason: 'TYPE_NOT_ALLOWED' }] })
    // FINANCE hears of it in the digest
    expect(await prisma.notification.count({ where: { templateKey: 'invoice.inbox_digest', organizationId: ap.org.organizationId } })).toBeGreaterThan(0)
  })

  it('the same mail sent twice (the same Message-ID) is one message and one draft, however often the inbox is read', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '500.00' }])
    await receive(ap, po, { 0: '1' })
    const messageId = `<${randomUUID()}@supplier.test>`
    const mail = { subject: `PO ${po.number}`, messageId, attachments: [{ filename: 'scan.pdf', content: '%PDF-1.4 test' }] }
    await send(mail)
    await send(mail)
    ok(await pollInvoiceInbox(fin(ap)))
    expect(ok(await pollInvoiceInbox(fin(ap)))).toMatchObject({ received: 0, drafts: 0 })
    expect(await prisma.inboundEmail.count({ where: { organizationId: ap.org.organizationId, messageId: messageIdOf(messageId) } })).toBe(1)
    const email = (await emailOf(messageId))!
    const drafts = await prisma.invoice.findMany({ where: { inboundEmailId: email.id } })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ prefill: 'MANUAL', poId: po.id })
  })

  it('without a PO number the file waits in the inbox; FINANCE chooses the PO and gets the draft', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '300.00' }])
    await receive(ap, po, { 0: '2' })
    const messageId = `<${randomUUID()}@supplier.test>`
    await send({ subject: 'ใบแจ้งหนี้เดือนนี้', messageId, attachments: [{ filename: 'scan.pdf', content: '%PDF-1.4 waiting' }] })
    expect(ok(await pollInvoiceInbox(fin(ap)))).toMatchObject({ received: 1, drafts: 0 })
    const email = (await emailOf(messageId))!
    expect(email.status).toBe('PROCESSED')
    const [link] = await prisma.fileLink.findMany({ where: { subjectType: 'InboundEmail', subjectId: email.id } })
    // only FINANCE makes the draft
    expect(await createInvoiceFromInbox(ap.org.ctxOf('proc_officer', AP_NOW), { inboundEmailId: email.id, fileId: link!.fileId, poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const made = ok(await createInvoiceFromInbox(fin(ap), { inboundEmailId: email.id, fileId: link!.fileId, poId: po.id }, key()))
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: made.invoiceId } })).toMatchObject({ channel: 'EMAIL', inboundEmailId: email.id, sourceFileId: link!.fileId, poId: po.id })
    // the file is one invoice's paper only
    expect(await createInvoiceFromInbox(fin(ap), { inboundEmailId: email.id, fileId: link!.fileId, poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'FILE_IN_USE' } } })
    // an inbox file is not taken by the upload path (the member did not upload it)
    expect(await createInvoice(fin(ap), { poId: po.id, sourceFileId: link!.fileId }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'FILE' } } })
  })

  it('a mail without an invoice file is IGNORED with its reason; FINANCE skips a message only with a reason', async () => {
    const messageId = `<${randomUUID()}@someone.test>`
    await send({ subject: 'สวัสดี', from: 'someone@else.test', messageId, attachments: [{ filename: 'a.docx', content: 'PK not an invoice' }] })
    ok(await pollInvoiceInbox(fin(ap)))
    expect(await emailOf(messageId)).toMatchObject({ status: 'IGNORED', ignoreReason: 'NO_INVOICE_FILE', attachmentCount: 0 })
    expect(await ignoreInboundEmail(fin(ap), { inboundEmailId: (await emailOf(messageId))!.id, reason: 'ซ้ำ' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})

describe('[FR-AP-101/AC4] [BR-IVC-07] the same e-Tax file by upload and by e-mail', () => {
  it('gives the same draft values', async () => {
    const xml = etaxXml({ invoiceNo: `SAME-${randomUUID().slice(0, 6)}`, net: '1000.00', vat: '70.00', gross: '1070.00' })
    const byUpload = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    const byEmail = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    const file = ok(await uploadInvoiceFile(fin(ap), { poId: byUpload.id, fileName: 'invoice.xml', content: new TextEncoder().encode(xml) }))
    const uploaded = ok(await createInvoice(fin(ap), { poId: byUpload.id, sourceFileId: file.fileId }, key()))
    const messageId = `<${randomUUID()}@supplier.test>`
    await send({ subject: byEmail.number!, messageId, attachments: [{ filename: 'invoice.xml', content: xml, contentType: 'application/xml' }] })
    ok(await pollInvoiceInbox(fin(ap)))
    const mailed = await prisma.invoice.findFirstOrThrow({ where: { inboundEmail: { messageId: messageIdOf(messageId) } } })
    const fields = (i: { prefill: string; supplierInvoiceNo: string | null; invoiceDate: Date | null; statedVatSatang: bigint; supplierId: string }) => ({ prefill: i.prefill, supplierInvoiceNo: i.supplierInvoiceNo, invoiceDate: i.invoiceDate, statedVatSatang: i.statedVatSatang, supplierId: i.supplierId })
    expect(fields(mailed)).toEqual(fields(await prisma.invoice.findUniqueOrThrow({ where: { id: uploaded.invoiceId } })))
    expect(mailed.prefill).toBe('ETAX_XML')
  })
})

describe('[FR-AP-101/AC2] a message the inbox cannot read', () => {
  const broken = (messageId: string): EmailInbox => {
    const message: InboundMessage = { providerId: 'x', messageId, from: 'ap-supplier@test.bcs.local', to: inbox, subject: 'broken', receivedAt: AP_NOW, attachments: [{ partId: '2', fileName: 'a.pdf', size: 10 }] }
    return {
      name: 'mailpit',
      list: async (address) => (address === inbox ? [message] : []),
      attachment: async () => {
        throw new InboxReadError('HTTP_500')
      },
    }
  }

  it('is FAILED and tried again until 3 attempts, then waits for FINANCE to skip it with a reason', async () => {
    const messageId = `<${randomUUID()}@broken.test>`
    const fake = broken(messageId)
    for (let i = 0; i < INBOX_MAX_ATTEMPTS + 1; i++) await pollInvoiceInbox(fin(ap), { inbox: fake })
    const email = (await emailOf(messageId))!
    expect(email).toMatchObject({ status: 'FAILED', attempts: INBOX_MAX_ATTEMPTS })
    expect(await prisma.event.count({ where: { aggregateId: email.id, type: 'inbound_email.failed' } })).toBe(INBOX_MAX_ATTEMPTS)
    ok(await ignoreInboundEmail(fin(ap), { inboundEmailId: email.id, reason: 'ไฟล์เสีย ขอให้ผู้ขายส่งใหม่' }, key()))
    expect(await emailOf(messageId)).toMatchObject({ status: 'IGNORED', ignoreReason: 'ไฟล์เสีย ขอให้ผู้ขายส่งใหม่' })
  })

  it('the job reads every organization with PAY and an inbox address as SYSTEM', async () => {
    const messageId = `<${randomUUID()}@broken.test>`
    const results = await pollAllInvoiceInboxes(AP_NOW, { inbox: broken(messageId) })
    expect(results).toEqual(expect.arrayContaining([{ organizationId: ap.org.organizationId, ok: true }]))
    const failed = await prisma.event.findFirstOrThrow({ where: { aggregateId: (await emailOf(messageId))!.id, type: 'inbound_email.failed' } })
    expect(failed.actorType).toBe('SYSTEM')
  })
})

describe('[FR-AP-101/AC5] [EG-1] the inbox works with the AI module off', () => {
  it('an organization with PAY only gets its draft from the inbox', async () => {
    const payOnly = await apOrg({ modules: ['PAY'] })
    expect(await prisma.orgModule.count({ where: { organizationId: payOnly.org.organizationId, module: 'AI', enabled: true } })).toBe(0)
    const address = `inbox-${randomUUID().slice(0, 8)}@test.bcs.local`
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: payOnly.org.organizationId }, select: { settings: true } })
    const settings = org.settings as Record<string, unknown>
    await prisma.organization.update({ where: { id: payOnly.org.organizationId }, data: { settings: { ...settings, ap: { ...((settings.ap as object) ?? {}), inboxAddress: address } } } })
    const po = await sentPo(payOnly, [{ quantity: '1', unitPrice: '10000.00' }])
    await receive(payOnly, po, { 0: '1' })
    await smtp.sendMail({ from: 'ap-supplier@test.bcs.local', to: address, subject: `ใบแจ้งหนี้ ${po.number}`, text: '-', attachments: [{ filename: 'invoice.xml', content: etaxXml({ invoiceNo: `AI-OFF-${randomUUID().slice(0, 6)}` }), contentType: 'application/xml' }] })
    expect(ok(await pollInvoiceInbox(fin(payOnly)))).toMatchObject({ received: 1, drafts: 1 })
    expect(await prisma.invoice.findFirstOrThrow({ where: { poId: po.id } })).toMatchObject({ channel: 'EMAIL', prefill: 'ETAX_XML' })
  })
})

describe('[FR-AP-101/AC6] who reads the inbox', () => {
  it('only FINANCE (invoice.inbox.manage) reads or skips; PAY off refuses MODULE_DISABLED', async () => {
    expect(await pollInvoiceInbox(ap.org.ctxOf('proc_officer', AP_NOW))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const off = await apOrg({ modules: [] })
    expect(await pollInvoiceInbox(fin(off))).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})
