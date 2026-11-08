import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { listPortalTodos } from '@/server/portal/queries'
import { getPortalInvoice, listPortalInvoicePos, listPortalInvoices, listPortalPayments, portalInvoicesShown } from '@/server/portal/queries-invoices'
import { portalCtx } from '@/server/portal/session'
import { readDocument } from '@/server/services/ai/agents/document'
import { cancelInvoice, confirmInvoiceCoding, createInvoice, createInvoiceFromPortal, submitInvoice, updateInvoice } from '@/server/services/ap'
import { rejectInvoice } from '@/server/services/ap/exceptions'
import { uploadInvoiceFile, uploadPortalInvoiceFile } from '@/server/services/ap/files'
import { whtCertificateUrlForContact } from '@/server/services/ap/portal'
import { listApInvoices } from '@/server/services/ap/view-list'
import { getDownloadUrl } from '@/server/services/files'
import { scanFile } from '@/server/services/suppliers/documents'
import { AP_NOW, apOrg, fin, key, ok, receive, sentPo, type ApOrg } from '../support/ap'

// S7-12 (FR-AP-101 AC7 · FR-AP-103 AC5 · FR-PAY-103 AC8 · BR-SUP ข้อ 15 · ADR-188 · INV-SUP-01): the supplier's contact
// sends an invoice on the portal through S8's own commands (channel PORTAL, the contact as its maker), edits it until
// FINANCE confirms its coding, and reads where it stands in its own words; FINANCE opens the file only once the central
// scan called it clean; the same invoice from the portal and from an upload matches the same way; the supplier reads its
// payments masked (four digits, no bank reference) and downloads its 50 ทวิ by a logged POST. Nobody sees another's.

let ap: ApOrg
const PDF = new TextEncoder().encode('%PDF-1.4\n% invoice of the portal test\n%%EOF\n')

beforeAll(async () => {
  setDefaultOutboxSender(null)
  ap = await apOrg()
  await prisma.orgModule.create({ data: { organizationId: ap.org.organizationId, module: 'SUPPLIER', enabled: true, enabledAt: AP_NOW, contractRef: 'TEST-P2', reason: 'พอร์ทัลผู้ขาย' } })
  await prisma.supplier.update({ where: { id: ap.supplierId }, data: { portalEnabled: true } })
})

async function contactOf(supplierId: string): Promise<{ id: string; ctx: Ctx }> {
  const c = await prisma.supplierContact.create({ data: { organizationId: ap.org.organizationId, supplierId, nameTh: 'ผู้ติดต่อใบแจ้งหนี้', email: `inv-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: false, privacyNoticeVersion: '2026-11-01' } })
  return { id: c.id, ctx: portalCtx(ap.org.organizationId, c, AP_NOW) }
}

async function otherSupplier() {
  return prisma.supplier.create({ data: { organizationId: ap.org.organizationId, code: `S-${randomUUID().slice(0, 5)}`, nameTh: 'ผู้ขายอื่น', taxId: `09${randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11)}`, portalEnabled: true } })
}

/** The contact sends the invoice of the PO: its file, the draft and its header (what the portal's form does) */
async function sendOnPortal(ctx: Ctx, poId: string, header: { no: string; vat: string; lines?: Array<{ poLineId: string; quantity: string; unitPrice: string }> }) {
  const { fileId } = ok(await uploadPortalInvoiceFile(ctx, { poId, fileName: 'invoice.pdf', content: PDF }, key()))
  const { invoiceId } = ok(await createInvoice(ctx, { poId, sourceFileId: fileId }, key()))
  const { version } = ok(await updateInvoice(ctx, { invoiceId, version: 0, supplierInvoiceNo: header.no, invoiceDate: '2026-10-10', statedVat: header.vat, ...(header.lines ? { lines: header.lines } : {}) }, key()))
  return { invoiceId, fileId, version }
}

/** FINANCE codes every line with the budget line's account and submits it (the invoice is matched) */
async function financeSubmits(invoiceId: string, version: number) {
  const lines = await prisma.invoiceLine.findMany({ where: { invoiceId }, include: { poLine: { include: { budgetLine: true } } } })
  const coded = ok(await confirmInvoiceCoding(fin(ap), { invoiceId, version, lines: lines.map((l) => ({ invoiceLineId: l.id, accountCode: l.poLine.budgetLine.accountCode ?? '510101', costCenterId: l.poLine.budgetLine.costCenterId })) }, key()))
  return ok(await submitInvoice(fin(ap), { invoiceId, version: coded.version }, key()))
}

describe('[FR-AP-101/AC7] [BR-SUP-15] the contact sends an invoice on the portal with S8’s commands', () => {
  it('a draft of channel PORTAL made by the contact on its own PO, its file waiting for the scan, FINANCE told in the digest', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00' }])
    await receive(ap, po, { 0: '10' })
    const c = await contactOf(ap.supplierId)
    expect((await listPortalInvoicePos(c.ctx)).map((p) => p.id)).toContain(po.id)
    const sent = await sendOnPortal(c.ctx, po.id, { no: `INV-${randomUUID().slice(0, 6)}`, vat: '70.00' })
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: sent.invoiceId }, include: { lines: true } })
    expect(invoice).toMatchObject({ channel: 'PORTAL', createdById: null, createdByContactId: c.id, status: 'DRAFT', sourceFileId: sent.fileId, netSatang: 100000n, statedVatSatang: 7000n, grossSatang: 107000n })
    expect(invoice.lines).toHaveLength(1)
    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: sent.fileId } })
    expect(file).toMatchObject({ scanStatus: 'PENDING', uploadedById: null })
    expect(file.storageKey).toContain(`/portal/${c.id}/`)
    const events = await prisma.event.findMany({ where: { organizationId: ap.org.organizationId, OR: [{ aggregateId: sent.invoiceId }, { aggregateId: sent.fileId }] }, orderBy: { occurredAt: 'asc' } })
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['file.uploaded', 'invoice.drafted', 'invoice.updated']))
    expect(events.find((e) => e.type === 'invoice.drafted')).toMatchObject({ actorType: 'SUPPLIER', data: expect.objectContaining({ channel: 'PORTAL' }) })
    const told = await prisma.notification.findMany({ where: { subjectId: sent.invoiceId, templateKey: 'invoice.portal_drafted' } })
    expect(told.map((n) => n.recipientMemberId).sort()).toEqual([ap.org.member.dm_fin!, ap.org.member.fin_officer!].sort())
    expect(told.every((n) => n.urgency === 'DIGEST')).toBe(true)
    // FINANCE's list: the channel's filter and the file waiting for the scan
    const list = ok(await listApInvoices(fin(ap), { tab: 'draft', channel: 'PORTAL' }))
    expect(list.rows.find((r) => r.id === sent.invoiceId)).toMatchObject({ channel: 'PORTAL', scanPending: true })
    expect(ok(await listApInvoices(fin(ap), { tab: 'draft', channel: 'EMAIL' })).rows.some((r) => r.id === sent.invoiceId)).toBe(false)
  })

  it('[BR-PORTAL-07] FINANCE opens the file only once the central scan called it clean', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '500.00' }])
    const c = await contactOf(ap.supplierId)
    const sent = await sendOnPortal(c.ctx, po.id, { no: `SCAN-${randomUUID().slice(0, 6)}`, vat: '0.00' })
    expect(await getDownloadUrl(fin(ap), { fileId: sent.fileId })).toMatchObject({ ok: false, error: { code: 'FILE_NOT_SCANNED' } })
    expect(await scanFile(ap.org.organizationId, sent.fileId, AP_NOW)).toBe('CLEAN')
    expect(await getDownloadUrl(fin(ap), { fileId: sent.fileId })).toMatchObject({ ok: true })
    expect(ok(await listApInvoices(fin(ap), { tab: 'draft', channel: 'PORTAL' })).rows.find((r) => r.id === sent.invoiceId)).toMatchObject({ scanPending: false })
  })

  it('the contact changes its draft until FINANCE confirms the coding; then it is FINANCE’s', async () => {
    const po = await sentPo(ap, [{ quantity: '4', unitPrice: '250.00' }])
    await receive(ap, po, { 0: '4' })
    const c = await contactOf(ap.supplierId)
    const sent = await sendOnPortal(c.ctx, po.id, { no: `EDIT-${randomUUID().slice(0, 6)}`, vat: '70.00' })
    const edited = ok(await updateInvoice(c.ctx, { invoiceId: sent.invoiceId, version: sent.version, statedVat: '35.00', lines: [{ poLineId: po.lines[0]!.id, quantity: '2', unitPrice: '250.00' }] }, key()))
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: sent.invoiceId } })).toMatchObject({ netSatang: 50000n, statedVatSatang: 3500n })
    // only FINANCE says it is the last invoice of the PO, and only a person of the organization takes AI values
    expect(await updateInvoice(c.ctx, { invoiceId: sent.invoiceId, version: edited.version, isFinal: true }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NOT_FOR_SUPPLIER' } } })
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: sent.invoiceId }, include: { poLine: { include: { budgetLine: true } } } })
    const coded = ok(await confirmInvoiceCoding(fin(ap), { invoiceId: sent.invoiceId, version: edited.version, lines: lines.map((l) => ({ invoiceLineId: l.id, accountCode: '510101', costCenterId: l.poLine.budgetLine.costCenterId })) }, key()))
    expect(await updateInvoice(c.ctx, { invoiceId: sent.invoiceId, version: coded.version, statedVat: '0.00' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'CODING_CONFIRMED' } } })
    expect((await getPortalInvoice(c.ctx, sent.invoiceId))?.editable).toBe(false)
    // FINANCE still edits it as any draft
    expect(await updateInvoice(fin(ap), { invoiceId: sent.invoiceId, version: coded.version, statedVat: '35.00', supplierInvoiceNo: 'EDIT-FIN' }, key())).toMatchObject({ ok: true })
  })

  it('a numbered draft (sent, then reopened) stays FINANCE’s even with no line coded; a cancelled draft tells its reason', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '100.00' }])
    await receive(ap, po, { 0: '2' })
    const c = await contactOf(ap.supplierId)
    const sent = await sendOnPortal(c.ctx, po.id, { no: `NUM-${randomUUID().slice(0, 6)}`, vat: '14.00' })
    await prisma.invoice.update({ where: { id: sent.invoiceId }, data: { number: `AP-T-${randomUUID().slice(0, 6)}` } })
    expect(await updateInvoice(c.ctx, { invoiceId: sent.invoiceId, version: sent.version, statedVat: '0.00' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'CODING_CONFIRMED' } } })
    expect((await getPortalInvoice(c.ctx, sent.invoiceId))?.editable).toBe(false)
    const po2 = await sentPo(ap, [{ quantity: '1', unitPrice: '100.00' }])
    const other = await sendOnPortal(c.ctx, po2.id, { no: `CXL-${randomUUID().slice(0, 6)}`, vat: '7.00' })
    ok(await cancelInvoice(fin(ap), { invoiceId: other.invoiceId, version: other.version, reason: 'แนบไฟล์ผิดใบ' }, key()))
    expect(await getPortalInvoice(c.ctx, other.invoiceId)).toMatchObject({ stage: 'CANCELLED', rejectReason: 'แนบไฟล์ผิดใบ' })
  })

  it('[BR-PORTAL-07] a file the scan found infected: flagged in FINANCE’s list, the invoice not submitted, the AI never reads an unscanned file', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '700.00' }])
    await receive(ap, po, { 0: '1' })
    const c = await contactOf(ap.supplierId)
    const sent = await sendOnPortal(c.ctx, po.id, { no: `INF-${randomUUID().slice(0, 6)}`, vat: '49.00' })
    // the Document Agent does not read a portal file before the scan called it clean
    expect(await readDocument(fin(ap), { fileId: sent.fileId, purpose: 'INVOICE', subject: { type: 'PURCHASE_ORDER', id: po.id } }, key())).toMatchObject({ ok: false, error: { code: 'AI_FILE_UNSUPPORTED', details: { reason: 'NOT_AVAILABLE' } } })
    await prisma.fileObject.update({ where: { id: sent.fileId }, data: { scanStatus: 'INFECTED' } })
    expect(ok(await listApInvoices(fin(ap), { tab: 'draft', channel: 'PORTAL' })).rows.find((r) => r.id === sent.invoiceId)).toMatchObject({ scanInfected: true, scanPending: false })
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: sent.invoiceId }, include: { poLine: { include: { budgetLine: true } } } })
    const coded = ok(await confirmInvoiceCoding(fin(ap), { invoiceId: sent.invoiceId, version: sent.version, lines: lines.map((l) => ({ invoiceLineId: l.id, accountCode: '510101', costCenterId: l.poLine.budgetLine.costCenterId })) }, key()))
    expect(await submitInvoice(fin(ap), { invoiceId: sent.invoiceId, version: coded.version }, key())).toMatchObject({ ok: false, error: { code: 'FILE_INFECTED' } })
  })

  it('[BR-PORTAL-04] at most 20 drafts a day per supplier through the portal’s adapter', async () => {
    const supplier = await otherSupplier()
    const c = await contactOf(supplier.id)
    // AP_NOW is 10:00 of 12 Oct in Bangkok: the day's window starts at its midnight there (17:00 UTC the day before)
    await prisma.portalRateLimit.create({ data: { organizationId: ap.org.organizationId, scopeKind: 'SUPPLIER', scopeKey: supplier.id, bucket: 'INVOICE', windowStart: new Date(Date.UTC(2026, 9, 11, 17)), count: 20 } })
    expect(await createInvoiceFromPortal(c.ctx, { poId: randomUUID(), sourceFileId: randomUUID() }, key())).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } })
  })

  it('[INV-SUP-01] another supplier’s PO or invoice is not found; a member’s file is not the contact’s; FINANCE cannot take the contact’s file', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '100.00' }])
    const mine = await contactOf(ap.supplierId)
    const theirs = await contactOf((await otherSupplier()).id)
    expect(await uploadPortalInvoiceFile(theirs.ctx, { poId: po.id, fileName: 'x.pdf', content: PDF }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await listPortalInvoicePos(theirs.ctx)).toEqual([])
    const sent = await sendOnPortal(mine.ctx, po.id, { no: `ISO-${randomUUID().slice(0, 6)}`, vat: '7.00' })
    expect(await updateInvoice(theirs.ctx, { invoiceId: sent.invoiceId, version: sent.version, statedVat: '0.00' }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await getPortalInvoice(theirs.ctx, sent.invoiceId)).toBeNull()
    expect((await listPortalInvoices(theirs.ctx)).some((i) => i.id === sent.invoiceId)).toBe(false)
    // a file FINANCE uploaded for the PO is not the contact's to send, nor the contact's file FINANCE's to take
    const finFile = ok(await uploadInvoiceFile(fin(ap), { poId: po.id, fileName: 'fin.pdf', content: PDF }))
    expect(await createInvoice(mine.ctx, { poId: po.id, sourceFileId: finFile.fileId }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'sourceFileId' } } })
    const contactFile = ok(await uploadPortalInvoiceFile(mine.ctx, { poId: po.id, fileName: 'c.pdf', content: PDF }, key()))
    expect(await createInvoice(fin(ap), { poId: po.id, sourceFileId: contactFile.fileId }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'sourceFileId' } } })
    // a draft without its file is refused; a member's command is FINANCE's guard as before
    expect(await createInvoice(mine.ctx, { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'FILE_REQUIRED' } } })
    expect(await createInvoice(ap.org.ctxOf('proc_officer', AP_NOW), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('a file that is not a PDF, JPEG or PNG is refused by its bytes', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '100.00' }])
    const c = await contactOf(ap.supplierId)
    expect(await uploadPortalInvoiceFile(c.ctx, { poId: po.id, fileName: 'a.xml', content: new TextEncoder().encode('<?xml version="1.0"?><x/>') }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'TYPE_NOT_ALLOWED' } } })
    expect(await uploadPortalInvoiceFile(c.ctx, { poId: po.id, fileName: 'a.pdf', content: new TextEncoder().encode('MZ not a pdf') }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'TYPE_NOT_ALLOWED' } } })
  })

  it('[BR-SUP-16] PAY off or supplier.portalInvoice false: MODULE_DISABLED and no menu; a closed contact or a supplier not ACTIVE is refused', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '100.00' }])
    const c = await contactOf(ap.supplierId)
    expect(await portalInvoicesShown(c.ctx)).toBe(true)
    const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: ap.org.organizationId } })).settings as Record<string, unknown>
    await prisma.organization.update({ where: { id: ap.org.organizationId }, data: { settings: { ...settings, supplier: { ...((settings.supplier as object) ?? {}), portalInvoice: false } } } })
    try {
      expect(await portalInvoicesShown(c.ctx)).toBe(false)
      expect(await uploadPortalInvoiceFile(c.ctx, { poId: po.id, fileName: 'x.pdf', content: PDF }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
      expect(await listPortalInvoices(c.ctx)).toEqual([])
    } finally {
      await prisma.organization.update({ where: { id: ap.org.organizationId }, data: { settings: settings as object } })
    }
    await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: false } })
    try {
      expect(await portalInvoicesShown(c.ctx)).toBe(false)
      expect(await createInvoice(c.ctx, { poId: po.id, sourceFileId: randomUUID() }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
      expect(await listPortalPayments(c.ctx)).toEqual([])
    } finally {
      await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: true } })
    }
    const closed = await contactOf(ap.supplierId)
    await prisma.supplierContact.update({ where: { id: closed.id }, data: { portalEnabled: false } })
    expect(await uploadPortalInvoiceFile(closed.ctx, { poId: po.id, fileName: 'x.pdf', content: PDF }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('[FR-AP-101/AC3] the same invoice from the portal and from an upload matches the same way: the match never reads the channel', async () => {
    const results = []
    for (const channel of ['PORTAL', 'UPLOAD'] as const) {
      const po = await sentPo(ap, [{ quantity: '10', unitPrice: '120.00' }])
      await receive(ap, po, { 0: '8' })
      const lines = [{ poLineId: po.lines[0]!.id, quantity: '10', unitPrice: '125.00' }]
      let invoiceId: string
      let version: number
      if (channel === 'PORTAL') {
        ;({ invoiceId, version } = await sendOnPortal((await contactOf(ap.supplierId)).ctx, po.id, { no: `SAME-${randomUUID().slice(0, 6)}`, vat: '87.50', lines }))
      } else {
        const { fileId } = ok(await uploadInvoiceFile(fin(ap), { poId: po.id, fileName: 'u.pdf', content: PDF }))
        ;({ invoiceId } = ok(await createInvoice(fin(ap), { poId: po.id, sourceFileId: fileId }, key())))
        ;({ version } = ok(await updateInvoice(fin(ap), { invoiceId, version: 0, supplierInvoiceNo: `SAME-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-10-10', statedVat: '87.50', lines }, key())))
      }
      const submitted = await financeSubmits(invoiceId, version)
      const exceptions = await prisma.matchException.findMany({ where: { invoiceId }, orderBy: { type: 'asc' } })
      const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
      // the second of the two is the first one again for the duplicate check (same supplier, amount and date), whichever
      // channel came second: that flag compares the two invoices, not the channels
      results.push({ status: submitted.status, matchResult: row.matchResult, net: row.netSatang, gross: row.grossSatang, exceptions: exceptions.filter((e) => e.type !== 'POSSIBLE_DUPLICATE').map((e) => ({ type: e.type, amount: e.amountSatang.toString() })) })
    }
    expect(results[0]).toEqual(results[1])
    expect(results[0]!.status).toBe('EXCEPTION')
  })
})

describe('[FR-AP-103/AC5] the supplier reads where its invoices stand, in its own words', () => {
  it('sent → received with BCS’s number → ready with its due date; a difference is "being checked" without its kind or amount; rejected with the reason', async () => {
    const c = await contactOf(ap.supplierId)
    // matched: ready to pay with its due date
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '300.00' }])
    await receive(ap, po, { 0: '2' })
    const sent = await sendOnPortal(c.ctx, po.id, { no: `RDY-${randomUUID().slice(0, 6)}`, vat: '42.00' })
    expect(await getPortalInvoice(c.ctx, sent.invoiceId)).toMatchObject({ stage: 'DRAFT', editable: true, number: null })
    expect((await financeSubmits(sent.invoiceId, sent.version)).status).toBe('READY_FOR_PAYMENT')
    const ready = await getPortalInvoice(c.ctx, sent.invoiceId)
    expect(ready).toMatchObject({ stage: 'READY', editable: false, number: expect.stringMatching(/^AP-/), dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    expect(ready!.timeline.receivedAt).not.toBeNull()
    // a difference: being checked, and nothing of what differed
    const po2 = await sentPo(ap, [{ quantity: '5', unitPrice: '100.00' }])
    await receive(ap, po2, { 0: '5' })
    const diff = await sendOnPortal(c.ctx, po2.id, { no: `DIF-${randomUUID().slice(0, 6)}`, vat: '38.50', lines: [{ poLineId: po2.lines[0]!.id, quantity: '5', unitPrice: '110.00' }] })
    expect((await financeSubmits(diff.invoiceId, diff.version)).status).toBe('EXCEPTION')
    const seen = await getPortalInvoice(c.ctx, diff.invoiceId)
    expect(seen).toMatchObject({ stage: 'IN_REVIEW' })
    const text = JSON.stringify([seen, await listPortalInvoices(c.ctx)])
    expect(text).not.toContain('PRICE_OVER')
    expect(text).not.toMatch(/variance|exception/i)
    // rejected (FINANCE rejects the one with the difference): the reason the supplier is given, and the home's line to send it again
    const rej = diff
    const v = (await prisma.invoice.findUniqueOrThrow({ where: { id: rej.invoiceId } })).version
    ok(await rejectInvoice(fin(ap), { invoiceId: rej.invoiceId, version: v, reason: 'เลขผู้เสียภาษีในใบไม่ตรง' }, key()))
    expect(await getPortalInvoice(c.ctx, rej.invoiceId)).toMatchObject({ stage: 'REJECTED', rejectReason: 'เลขผู้เสียภาษีในใบไม่ตรง' })
    expect(await listPortalTodos(c.ctx)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'INVOICE_REJECTED', page: `/invoices/${rej.invoiceId}` })]))
  })

  it('an invoice FINANCE recorded from an upload shows once it is numbered; its draft does not', async () => {
    const c = await contactOf(ap.supplierId)
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '100.00' }])
    await receive(ap, po, { 0: '1' })
    const { invoiceId } = ok(await createInvoice(fin(ap), { poId: po.id }, key()))
    const { version } = ok(await updateInvoice(fin(ap), { invoiceId, version: 0, supplierInvoiceNo: `UP-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-10-10', statedVat: '7.00' }, key()))
    expect((await listPortalInvoices(c.ctx)).some((i) => i.id === invoiceId)).toBe(false)
    await financeSubmits(invoiceId, version)
    expect((await listPortalInvoices(c.ctx)).find((i) => i.id === invoiceId)).toMatchObject({ fromPortal: false, editable: false })
  })
})

describe('[FR-PAY-103/AC8] the supplier reads its payments masked and downloads its own 50 ทวิ', () => {
  it('PAID and FAILED items of its own: four digits, no account number, no bank reference; the 50 ทวิ by a logged POST', async () => {
    const organizationId = ap.org.organizationId
    const c = await contactOf(ap.supplierId)
    const other = await otherSupplier()
    const theirs = await contactOf(other.id)
    const payer = await prisma.bankAccount.create({ data: { organizationId, ownerKind: 'ORGANIZATION', code: `CB-${randomUUID().slice(0, 4)}`, bankCode: '004', accountNo: '1000000032', accountName: 'องค์กร', accountType: 'CURRENT', fileTemplateCode: 'BCS-NEUTRAL-1', activatedAt: AP_NOW } })
    const run = await prisma.paymentRun.create({ data: { organizationId, number: `PAY-2569-${randomUUID().slice(0, 5)}`, status: 'COMPLETED', payDate: new Date('2026-10-16T00:00:00Z'), payerBankAccountId: payer.id, fileTemplateCode: 'BCS-NEUTRAL-1', preparedById: ap.org.member.fin_officer! } })
    const paid = await prisma.paymentRunItem.create({ data: { organizationId, paymentRunId: run.id, supplierId: ap.supplierId, seq: 1, payeeBankCode: '014', payeeAccountNo: '2123456789', payeeAccountName: 'ผู้ขายหนึ่ง', payableSatang: 10058000n, whtSatang: 0n, transferSatang: 10058000n, status: 'PAID', paidOn: new Date('2026-10-16T00:00:00Z'), bankReference: 'BANKREF-SECRET-1', resultRecordedAt: AP_NOW } })
    await prisma.paymentRunItem.create({ data: { organizationId, paymentRunId: run.id, supplierId: other.id, seq: 2, payeeBankCode: '014', payeeAccountNo: '2999999999', payableSatang: 500n, transferSatang: 500n, status: 'PAID', paidOn: new Date('2026-10-16T00:00:00Z'), resultRecordedAt: AP_NOW } })
    const run2 = await prisma.paymentRun.create({ data: { organizationId, number: `PAY-2569-${randomUUID().slice(0, 5)}`, status: 'COMPLETED', payDate: new Date('2026-10-23T00:00:00Z'), payerBankAccountId: payer.id, fileTemplateCode: 'BCS-NEUTRAL-1', preparedById: ap.org.member.fin_officer! } })
    await prisma.paymentRunItem.create({ data: { organizationId, paymentRunId: run2.id, supplierId: ap.supplierId, seq: 1, payeeBankCode: '014', payeeAccountNo: '2123456789', payableSatang: 2000n, transferSatang: 2000n, status: 'FAILED', failureReason: 'บัญชีปิดแล้ว', bankReference: 'BANKREF-SECRET-2', resultRecordedAt: AP_NOW } })
    const pdf = await prisma.fileObject.create({ data: { organizationId, storageKey: `org/${organizationId}/wht/${randomUUID()}.pdf`, fileName: '50twi.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', scanStatus: 'NOT_REQUIRED' } })
    const cert = await prisma.whtCertificate.create({ data: { organizationId, number: `WHT-${randomUUID().slice(0, 6)}`, supplierId: ap.supplierId, form: 'PND53', paidOn: new Date('2026-10-16T00:00:00Z'), totalBaseSatang: 0n, totalTaxSatang: 0n, payeeSnapshot: {}, payerSnapshot: {}, fileId: pdf.id, paymentRunItemId: paid.id, issuedAt: AP_NOW } })

    const rows = await listPortalPayments(c.ctx)
    expect(rows.find((r) => r.id === paid.id)).toMatchObject({ runNumber: run.number, status: 'PAID', paidOn: '2026-10-16', transferSatang: '10058000', last4: '6789', certificate: { id: cert.id, number: cert.number } })
    expect(rows.find((r) => r.status === 'FAILED')).toMatchObject({ failureReason: 'บัญชีปิดแล้ว', certificate: null })
    const text = JSON.stringify(rows)
    for (const secret of ['2123456789', 'BANKREF-SECRET', '2999999999', other.id]) expect(text).not.toContain(secret)
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['bankName', 'certificate', 'failureReason', 'id', 'invoices', 'last4', 'paidOn', 'payableSatang', 'runNumber', 'status', 'transferSatang', 'whtSatang'])
    expect(await listPortalPayments(theirs.ctx)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: paid.id })]))

    expect(await whtCertificateUrlForContact(c.ctx, { certificateId: cert.id }, key())).toMatchObject({ ok: true, data: { url: expect.stringContaining('50twi') } })
    expect(await prisma.event.count({ where: { organizationId, type: 'file.downloaded', aggregateId: pdf.id, actorType: 'SUPPLIER' } })).toBe(1)
    expect(await whtCertificateUrlForContact(theirs.ctx, { certificateId: cert.id }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    // a contact procurement closed to the portal reads no certificate, as it sends no invoice
    await prisma.supplierContact.update({ where: { id: c.id }, data: { portalEnabled: false } })
    expect(await whtCertificateUrlForContact(c.ctx, { certificateId: cert.id }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})
