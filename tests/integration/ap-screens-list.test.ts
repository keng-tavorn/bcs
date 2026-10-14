import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApInvoiceFor, createFromInboxFor, ignoreEmailFor, pollInboxFor, uploadApInvoiceFileFor } from '@/app/(workspace)/finance/invoices/ap-list-commands'
import { messageIdOf, type EmailInbox, type InboundMessage } from '@/integrations/email-inbound'
import { prisma } from '@/server/db/client'
import { apInvoicesOn, canIgnoreEmail, getInvoiceInboxView, listApInvoices, newApInvoiceView } from '@/server/services/ap/view-list'
import { etaxXml } from '../support/etax-files'
import { AP_NOW, apOrg, codedDraft, fin, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'

// S8-13 G1 (docs/sub-specs/S8.md "หน้าจอ"): what /finance/invoices (with PAY on), /finance/invoices/new and
// /finance/invoices/inbox read and do — the invoices by tab with their counts, the search and the possible-duplicate
// badge; the POs a new invoice can be made on, a file uploaded and the draft made from it; the inbox fetched now, a file
// that waits for its PO put on one, a message skipped with a reason. Every view and command checks its capability and
// module PAY; members without them and organizations without PAY are refused.

const proc = (ap: ApOrg) => ap.org.ctxOf('proc_officer', AP_NOW)
const uuid = () => randomUUID()

describe('[FR-AP-103/AC1] /finance/invoices with PAY on lists the tier-2 invoices by tab', () => {
  let ap: ApOrg
  let po: Awaited<ReturnType<typeof sentPo>>
  let draftId: string
  let readyId: string
  let duplicateId: string
  beforeAll(async () => {
    ap = await apOrg()
    po = await sentPo(ap, [{ quantity: '2', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '2' })
    const first = await codedDraft(ap, po, { no: 'LS-1', date: '2026-10-08', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
    ok(await submit(ap, first))
    readyId = first.invoiceId
    // another number with the same total within 3 days: POSSIBLE_DUPLICATE (GC-MATCH-23)
    const second = await codedDraft(ap, po, { no: 'LS-2', date: '2026-10-10', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
    ok(await submit(ap, second))
    duplicateId = second.invoiceId
    const made = await createApInvoiceFor(fin(ap), { poId: po.id, sourceFileId: null }, uuid())
    if (!made.ok) throw new Error(JSON.stringify(made))
    draftId = made.invoiceId
  })

  it('the page branches on module PAY; the tabs count every status under the search', async () => {
    expect(await apInvoicesOn(fin(ap))).toBe(true)
    const list = ok(await listApInvoices(fin(ap), { tab: 'draft' }))
    expect(list.counts).toEqual({ draft: 1, exceptions: 1, pending: 0, ready: 1, all: 3 })
    expect(list.rows.map((r) => r.id)).toEqual([draftId])
    expect(list.rows[0]).toMatchObject({ status: 'DRAFT', number: null, po: { id: po.id, number: po.number }, supplier: { code: 'S1' }, possibleDuplicate: false })
    expect(list.canManageInbox).toBe(true)
    // with no tab the drafts come first
    expect(ok(await listApInvoices(fin(ap))).tab).toBe('draft')
  })

  it('the exceptions tab shows the possible duplicate with its badge; ready shows the matched one with its amounts', async () => {
    const exceptions = ok(await listApInvoices(fin(ap), { tab: 'exceptions' }))
    expect(exceptions.rows).toHaveLength(1)
    expect(exceptions.rows[0]).toMatchObject({ id: duplicateId, status: 'EXCEPTION', supplierInvoiceNo: 'LS-2', possibleDuplicate: true })
    expect(exceptions.rows[0]!.openExceptions).toBeGreaterThan(0)
    const ready = ok(await listApInvoices(fin(ap), { tab: 'ready' }))
    expect(ready.rows).toHaveLength(1)
    expect(ready.rows[0]).toMatchObject({ id: readyId, status: 'READY_FOR_PAYMENT', netSatang: 100_000n, vatSatang: 7_000n, grossSatang: 107_000n })
    expect(ready.rows[0]!.number).toMatch(/^AP-/)
    expect(ready.rows[0]!.dueDate).not.toBeNull()
  })

  it('the search narrows every tab by the supplier invoice number, the PO number or the supplier', async () => {
    const byNo = ok(await listApInvoices(fin(ap), { tab: 'all', q: 'ls-2' }))
    expect(byNo.rows.map((r) => r.id)).toEqual([duplicateId])
    expect(byNo.counts).toMatchObject({ all: 1, exceptions: 1, draft: 0 })
    expect(ok(await listApInvoices(fin(ap), { tab: 'all', q: po.number! })).counts.all).toBe(3)
    expect(ok(await listApInvoices(fin(ap), { tab: 'all', q: 'ผู้ขายหนึ่ง' })).counts.all).toBe(3)
    expect(ok(await listApInvoices(fin(ap), { tab: 'all', q: 'nothing-like-this' })).rows).toEqual([])
  })

  it('refuses a member without invoice.record (FORBIDDEN)', async () => {
    expect(await listApInvoices(proc(ap), { tab: 'all' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await newApInvoiceView(proc(ap))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-AP-101/AC1] /finance/invoices/new: choose the PO, upload the file, get the draft', () => {
  let ap: ApOrg
  beforeAll(async () => {
    ap = await apOrg()
  })

  it('lists the POs that can take a tier-2 invoice, not the ones on the tier-1 track', async () => {
    const open = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    const tier1 = await sentPo(ap, [{ quantity: '1', unitPrice: '500.00' }])
    await prisma.invoiceConfirmation.create({
      data: { organizationId: ap.org.organizationId, poId: tier1.id, supplierId: ap.supplierId, invoiceNo: 'T1-1', invoiceNoNormalized: 'T1-1', invoiceDate: new Date('2026-10-01'), netSatang: 50_000n, vatSatang: 3_500n, grossSatang: 53_500n, recordedById: ap.org.member.fin_officer!, recordedAt: AP_NOW },
    })
    const view = ok(await newApInvoiceView(fin(ap)))
    const ids = view.pos.map((p) => p.id)
    expect(ids).toContain(open.id)
    expect(ids).not.toContain(tier1.id)
    expect(view.pos.find((p) => p.id === open.id)).toMatchObject({ number: open.number, status: 'SENT', netSatang: 100_000n, supplier: { id: ap.supplierId, code: 'S1' } })
  })

  it('an e-Tax file uploaded for the PO becomes a draft filled from it; the same submission sent twice makes one draft', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    const invoiceNo = `UP-${uuid().slice(0, 6)}`
    const file = await uploadApInvoiceFileFor(fin(ap), po.id, 'invoice.xml', new TextEncoder().encode(etaxXml({ invoiceNo, net: '1000.00', vat: '70.00', gross: '1070.00' })))
    if (!file.ok) throw new Error(JSON.stringify(file))
    const submission = uuid()
    const made = await createApInvoiceFor(fin(ap), { poId: po.id, sourceFileId: file.fileId }, submission)
    if (!made.ok) throw new Error(JSON.stringify(made))
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: made.invoiceId } })).toMatchObject({ status: 'DRAFT', channel: 'UPLOAD', prefill: 'ETAX_XML', sourceFileId: file.fileId, supplierInvoiceNo: invoiceNo, poId: po.id })
    expect(await createApInvoiceFor(fin(ap), { poId: po.id, sourceFileId: file.fileId }, submission)).toEqual(made)
    expect(await prisma.invoice.count({ where: { poId: po.id } })).toBe(1)
  })

  it('a draft without a file; a file of another kind, a missing key or a malformed PO is refused in words the form maps', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    const made = await createApInvoiceFor(fin(ap), { poId: po.id, sourceFileId: null }, uuid())
    expect(made).toMatchObject({ ok: true })
    expect(await uploadApInvoiceFileFor(fin(ap), po.id, 'note.txt', new TextEncoder().encode('hello'))).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'TYPE_NOT_ALLOWED' })
    expect(await uploadApInvoiceFileFor(fin(ap), 'not-a-po', 'a.pdf', new TextEncoder().encode('%PDF-1.4'))).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'poId' })
    expect(await createApInvoiceFor(fin(ap), { poId: po.id, sourceFileId: null }, 'not-a-key')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect(await createApInvoiceFor(fin(ap), { poId: po.id }, uuid())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'sourceFileId' })
  })

  it('refuses a member without invoice.record (FORBIDDEN) and keeps nothing', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    expect(await createApInvoiceFor(proc(ap), { poId: po.id, sourceFileId: null }, uuid())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await uploadApInvoiceFileFor(proc(ap), po.id, 'a.pdf', new TextEncoder().encode('%PDF-1.4 x'))).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await prisma.invoice.count({ where: { poId: po.id } })).toBe(0)
  })
})

describe('[FR-AP-101/AC2] /finance/invoices/inbox: fetch now, choose the PO of a waiting file, skip with a reason', () => {
  let ap: ApOrg
  let inboxAddress: string
  let po: Awaited<ReturnType<typeof sentPo>>
  const messages: InboundMessage[] = []
  const files = new Map<string, Uint8Array>()
  const fake: EmailInbox = {
    name: 'mailpit',
    list: async (address) => (address === inboxAddress ? messages : []),
    attachment: async (message, partId) => files.get(`${messageIdOf(message.messageId)}:${partId}`) ?? new Uint8Array(),
  }
  const mail = (subject: string, attachments: Array<{ fileName: string; content: string }>) => {
    const messageId = `<${uuid()}@supplier.test>`
    messages.push({ providerId: uuid(), messageId, from: 'ap-supplier@test.bcs.local', to: inboxAddress, subject, receivedAt: AP_NOW, attachments: attachments.map((a, i) => ({ partId: String(i + 2), fileName: a.fileName, size: a.content.length })) })
    attachments.forEach((a, i) => files.set(`${messageIdOf(messageId)}:${i + 2}`, new TextEncoder().encode(a.content)))
    return messageId
  }
  const emailOf = (messageId: string) => prisma.inboundEmail.findFirstOrThrow({ where: { organizationId: ap.org.organizationId, messageId: messageIdOf(messageId) } })

  beforeAll(async () => {
    ap = await apOrg()
    inboxAddress = `inbox-${uuid().slice(0, 8)}@test.bcs.local`
    po = await sentPo(ap, [{ quantity: '3', unitPrice: '300.00' }])
    await receive(ap, po, { 0: '3' })
  })

  it('without an inbox address "fetch now" reads nothing and says so', async () => {
    expect(await pollInboxFor(fin(ap), { inbox: fake })).toEqual({ ok: true, configured: false, received: 0, drafts: 0, failed: 0 })
    const view = ok(await getInvoiceInboxView(fin(ap)))
    expect(view).toMatchObject({ address: null, emails: [], canRecord: true })
  })

  it('fetch now keeps the mail: a file naming its PO is a draft, one without waits, other kinds are listed with why', async () => {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: ap.org.organizationId }, select: { settings: true } })
    const settings = org.settings as Record<string, unknown>
    await prisma.organization.update({ where: { id: ap.org.organizationId }, data: { settings: { ...settings, ap: { ...((settings.ap as object) ?? {}), inboxAddress } } } })
    const named = mail(`ใบแจ้งหนี้ ${po.number}`, [{ fileName: 'scan.pdf', content: '%PDF-1.4 named' }])
    const waiting = mail('ใบแจ้งหนี้เดือนนี้', [
      { fileName: 'bill.pdf', content: '%PDF-1.4 waiting' },
      { fileName: 'note.txt', content: 'hello' },
    ])
    expect(await pollInboxFor(fin(ap), { inbox: fake })).toEqual({ ok: true, configured: true, received: 2, drafts: 1, failed: 0 })

    const view = ok(await getInvoiceInboxView(fin(ap)))
    expect(view.address).toBe(inboxAddress)
    expect(view.pos.map((p) => p.id)).toContain(po.id)
    const namedId = (await emailOf(named)).id
    const namedRow = view.emails.find((e) => e.id === namedId)!
    expect(namedRow).toMatchObject({ status: 'PROCESSED', fromAddress: 'ap-supplier@test.bcs.local', poRefsFound: [po.number], senderSupplierId: ap.supplierId })
    expect(namedRow.invoices).toHaveLength(1)
    expect(namedRow.invoices[0]).toMatchObject({ status: 'DRAFT', poNumber: po.number })
    expect(namedRow.files[0]!.invoice).toMatchObject({ id: namedRow.invoices[0]!.id })
    expect(canIgnoreEmail(namedRow)).toBe(false)

    const waitingId = (await emailOf(waiting)).id
    const waitingRow = view.emails.find((e) => e.id === waitingId)!
    expect(waitingRow).toMatchObject({ status: 'PROCESSED', invoices: [], skipped: [{ fileName: 'note.txt', reason: 'TYPE_NOT_ALLOWED' }] })
    expect(waitingRow.files).toEqual([{ fileId: expect.any(String), fileName: 'bill.pdf', invoice: null }])
    expect(canIgnoreEmail(waitingRow)).toBe(true)

    // FINANCE chooses the PO of the waiting file and gets the draft
    const made = await createFromInboxFor(fin(ap), { inboundEmailId: waitingRow.id, fileId: waitingRow.files[0]!.fileId, poId: po.id }, uuid())
    if (!made.ok) throw new Error(JSON.stringify(made))
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: made.invoiceId } })).toMatchObject({ channel: 'EMAIL', inboundEmailId: waitingRow.id, poId: po.id, status: 'DRAFT' })
    const after = ok(await getInvoiceInboxView(fin(ap))).emails.find((e) => e.id === waitingRow.id)!
    expect(after.files[0]!.invoice).toMatchObject({ id: made.invoiceId })
    // the file is one invoice's paper only
    expect(await createFromInboxFor(fin(ap), { inboundEmailId: waitingRow.id, fileId: waitingRow.files[0]!.fileId, poId: po.id }, uuid())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'FILE_IN_USE' })
    // a fetch again keeps nothing twice
    expect(await pollInboxFor(fin(ap), { inbox: fake })).toMatchObject({ ok: true, received: 0, drafts: 0 })
  })

  it('a message is skipped only with a reason, and then shows why', async () => {
    const skipped = mail('โฆษณา', [{ fileName: 'flyer.pdf', content: '%PDF-1.4 flyer' }])
    expect(await pollInboxFor(fin(ap), { inbox: fake })).toMatchObject({ ok: true, received: 1, drafts: 0 })
    const id = (await emailOf(skipped)).id
    expect(await ignoreEmailFor(fin(ap), { inboundEmailId: id, reason: '   ' }, uuid())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'reason', reason: 'REQUIRED' })
    expect(await ignoreEmailFor(proc(ap), { inboundEmailId: id, reason: 'โฆษณา' }, uuid())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await ignoreEmailFor(fin(ap), { inboundEmailId: id, reason: 'อีเมลโฆษณา' }, uuid())).toEqual({ ok: true })
    const row = ok(await getInvoiceInboxView(fin(ap))).emails.find((e) => e.id === id)!
    expect(row).toMatchObject({ status: 'IGNORED', ignoreReason: 'อีเมลโฆษณา' })
    expect(canIgnoreEmail(row)).toBe(false)
    expect(await prisma.event.count({ where: { aggregateId: id, type: 'inbound_email.ignored' } })).toBe(1)
  })

  it('refuses the inbox to a member without invoice.inbox.manage (FORBIDDEN)', async () => {
    expect(await getInvoiceInboxView(proc(ap))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await pollInboxFor(proc(ap), { inbox: fake })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})

describe('[FR-AP-102/AC6] an organization without PAY keeps the tier-1 page (BR-AP-13)', () => {
  it('the list branch is off and every view and command of these screens is MODULE_DISABLED', async () => {
    const ap = await apOrg({ modules: [] })
    expect(await apInvoicesOn(fin(ap))).toBe(false)
    expect(await listApInvoices(fin(ap))).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await newApInvoiceView(fin(ap))).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await getInvoiceInboxView(fin(ap))).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    expect(await createApInvoiceFor(fin(ap), { poId: po.id, sourceFileId: null }, uuid())).toMatchObject({ ok: false, code: 'MODULE_DISABLED' })
    expect(await pollInboxFor(fin(ap))).toMatchObject({ ok: false, code: 'MODULE_DISABLED' })
  })
})
