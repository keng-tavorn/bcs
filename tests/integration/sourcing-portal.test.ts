import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { listPortalRfx, portalRfx, portalRfxLanding, portalRfxSummary } from '@/server/portal/queries-rfx'
import { portalCtx } from '@/server/portal/session'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import {
  amendRfx,
  bidFileScanned,
  closeRfxAt,
  createRfx,
  inviteToRfx,
  openRfx,
  removeBidFile,
  requestPortalRfxFile,
  saveBid,
  setScorecard,
  submitBid,
  uploadBidFile,
} from '@/server/services/sourcing'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S10-07 (FR-SRC-202 AC1 AC2 · BR-RFX-07 · BR-PORTAL-07 · INV-RFX-01): what the portal's RFx pages stand on, on real
// Postgres and storage — the files of a bid (attached, taken off, refused by type and count, closed with the RFx; an
// infected one taken off by the scan's listener and the contact told), the contact opening the RFx's and its bid's files
// (never another's), the contact's own state through the RFx's life (to bid, draft, sent, to send again after an
// amendment, closed, awarded or not), the home's row, the landing after the invite's link, and a supplier whose VAT the
// register says is cancelled bidding without VAT.

const MON = new Date('2026-11-02T02:00:00Z') // Monday 09:00 Bangkok
const CLOSES = '2026-11-05T10:00:00Z' // Thursday 17:00
const AFTER = new Date('2026-11-05T10:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const PDF = (text = 'hello') => new TextEncoder().encode(`%PDF-1.7\n${text}\n%%EOF`)
let seq = 300
/** A Thai taxpayer id that passes mod 11 (BR-TAXID-01) */
function taxId(): string {
  const body = `01055${String(seq++).padStart(7, '0')}`
  const sum = [...body].reduce((a, d, i) => a + Number(d) * (13 - i), 0)
  return body + String((11 - (sum % 11)) % 10)
}

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  for (const m of ['SUPPLIER', 'SOURCING'] as const) {
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: m, enabled: true, enabledAt: new Date('2026-01-01T00:00:00Z'), contractRef: 'TEST-S10', reason: 'องค์กรทดสอบจัดหา' } })
  }
}, 120_000)

const proc = (now = MON) => org.ctxOf('proc_officer', now)
const version = async (id: string) => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id } })).version

async function party(name: string) {
  const s = await prisma.supplier.create({
    data: { organizationId: org.organizationId, code: `P-${randomUUID().slice(0, 6)}`, nameTh: name, taxId: taxId(), isVatRegistered: true, branchCode: '00000', portalEnabled: true },
  })
  const contact = await prisma.supplierContact.create({
    data: { organizationId: org.organizationId, supplierId: s.id, nameTh: `ติดต่อ ${name}`, email: `p-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true, privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION },
  })
  return { supplier: s, contact, ctx: (now = MON) => portalCtx(org.organizationId, contact, now) }
}

/** An open RFQ of two lines and its parties; the scorecard is price-only */
async function openRfq(parties: Array<Awaited<ReturnType<typeof party>>>) {
  const { rfxEventId } = ok(
    await createRfx(
      proc(),
      { kind: 'RFQ', title: 'ปูนซีเมนต์', description: 'ขอราคา', source: { kind: 'NEED', categoryCode: 'CEMENT', lines: [{ description: 'ปูน 50 กก.', quantity: '100', uom: 'ถุง', refUnitPrice: '150.00' }, { description: 'ทราย', quantity: '4', uom: 'คิว', refUnitPrice: '600.00' }] } },
      key(),
    ),
  )
  for (const p of parties) ok(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: p.supplier.id }, key()))
  ok(await setScorecard(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: [{ code: 'PRICE', nameTh: 'ราคา', weightBp: 10000, kind: 'PRICE' }], evaluatorMemberIds: [org.member.dm_proc!, org.member.dm_it!] }, key()))
  ok(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: CLOSES }, key()))
  const lines = (await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })).map((l) => l.id)
  return { rfxEventId, lines }
}
const priced = (lines: string[], prices: string[]) => lines.map((rfxLineId, i) => ({ rfxLineId, offered: true, unitPrice: prices[i]! }))

describe('[FR-SRC-202/AC2] [BR-PORTAL-07] the files of a bid from the portal', () => {
  it('attached (a draft bid made for it), taken off, refused by type, count and the close; a sent bid stays sent', async () => {
    const me = await party('ปูนดี')
    const { rfxEventId, lines } = await openRfq([me])
    const first = ok(await uploadBidFile(me.ctx(), { rfxEventId, fileName: 'quote.pdf', bytes: PDF('one') }, key()))
    const bid = await prisma.bid.findUniqueOrThrow({ where: { id: first.bidId } })
    expect(bid).toMatchObject({ status: 'DRAFT', supplierId: me.supplier.id })
    expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: first.fileId } })).toMatchObject({ scanStatus: 'PENDING', mimeType: 'application/pdf', uploadedById: null })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, aggregateId: first.bidId, type: 'bid.file_attached' } })).toBe(1)
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, aggregateId: first.fileId, type: 'file.uploaded' } })).toBe(1)
    expect(await uploadBidFile(me.ctx(), { rfxEventId, fileName: 'x.exe', bytes: new TextEncoder().encode('MZ...') }, key())).toMatchObject({ ok: false, error: { details: { reason: 'TYPE_NOT_ALLOWED' } } })
    // sending the bid keeps its files; a file attached after the send leaves it sent (the files are not its prices)
    ok(await submitBid(me.ctx(), { rfxEventId, lines: priced(lines, ['150.00', '600.00']) }, key()))
    for (let i = 0; i < 9; i++) ok(await uploadBidFile(me.ctx(), { rfxEventId, fileName: `p${i}.pdf`, bytes: PDF(`n${i}`) }, key()))
    expect(await uploadBidFile(me.ctx(), { rfxEventId, fileName: 'p11.pdf', bytes: PDF('eleven') }, key())).toMatchObject({ ok: false, error: { details: { reason: 'TOO_MANY_FILES' } } })
    expect((await prisma.bid.findUniqueOrThrow({ where: { id: first.bidId } })).status).toBe('SUBMITTED')
    ok(await removeBidFile(me.ctx(), { rfxEventId, fileId: first.fileId }, key()))
    expect(await prisma.fileLink.count({ where: { fileId: first.fileId } })).toBe(0)
    expect(await prisma.fileObject.count({ where: { id: first.fileId } })).toBe(1) // kept for the audit
    expect(await removeBidFile(me.ctx(), { rfxEventId, fileId: first.fileId }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await uploadBidFile(me.ctx(AFTER), { rfxEventId, fileName: 'late.pdf', bytes: PDF('late') }, key())).toMatchObject({ ok: false, error: { code: 'RFX_CLOSED' } })
  })

  it('the contact of an application, and a contact who has not accepted the privacy notice, attach nothing', async () => {
    const me = await party('ยังไม่รับทราบ')
    const { rfxEventId } = await openRfq([me])
    await prisma.supplierContact.update({ where: { id: me.contact.id }, data: { privacyNoticeVersion: null } })
    expect(await uploadBidFile(me.ctx(), { rfxEventId, fileName: 'q.pdf', bytes: PDF() }, key())).toMatchObject({ ok: false, error: { code: 'PRIVACY_NOTICE_OUTDATED' } })
    const application = await prisma.supplierApplication.create({ data: { organizationId: org.organizationId, kind: 'NEW', invitedById: org.member.proc_officer!, invitedAt: MON, lastActivityAt: MON, expiresAt: new Date('2026-12-02T00:00:00Z'), nameTh: 'ผู้สมัคร' } })
    const ac = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, applicationId: application.id, nameTh: 'ติดต่อผู้สมัคร', email: `a-${randomUUID().slice(0, 8)}@supplier.test`, privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION } })
    expect(await uploadBidFile(portalCtx(org.organizationId, ac, MON), { rfxEventId, fileName: 'q.pdf', bytes: PDF() }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('an infected file is taken off the bid by the scan and the contact told; a clean one stays', async () => {
    const me = await party('ไฟล์ติดไวรัส')
    const { rfxEventId } = await openRfq([me])
    const bad = ok(await uploadBidFile(me.ctx(), { rfxEventId, fileName: 'bad.pdf', bytes: PDF('bad') }, key()))
    const good = ok(await uploadBidFile(me.ctx(), { rfxEventId, fileName: 'good.pdf', bytes: PDF('good') }, key()))
    expect(await bidFileScanned(org.organizationId, good.fileId, 'CLEAN', MON)).toBe('SKIPPED')
    expect(await bidFileScanned(org.organizationId, bad.fileId, 'INFECTED', MON)).toBe('REJECTED')
    expect(await prisma.fileLink.count({ where: { fileId: bad.fileId } })).toBe(0)
    expect(await prisma.fileLink.count({ where: { fileId: good.fileId } })).toBe(1)
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, aggregateId: bad.bidId, type: 'bid.file_rejected' } })).toBe(1)
    expect(await prisma.supplierNotice.findFirstOrThrow({ where: { organizationId: org.organizationId, subjectId: bad.bidId, templateKey: 'rfx.file_rejected' } })).toMatchObject({ contactId: me.contact.id })
  })
})

describe('[FR-SRC-202/AC1] [INV-RFX-01] the contact opens the files of its RFx and of its bid, never another\'s', () => {
  it('RFX_DOC and its own BID_DOC by a five-minute link with file.downloaded; another supplier\'s file is not found; an infected one is refused', async () => {
    const me = await party('เปิดไฟล์')
    const other = await party('อีกราย')
    const { rfxEventId } = await openRfq([me, other])
    const doc = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `${org.organizationId}/rfx-docs/${randomUUID()}.pdf`, fileName: 'spec.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64), status: 'AVAILABLE', scanStatus: 'NOT_REQUIRED' } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: doc.id, subjectType: 'RfxEvent', subjectId: rfxEventId, kind: 'RFX_DOC' } })
    const mine = ok(await uploadBidFile(me.ctx(), { rfxEventId, fileName: 'mine.pdf', bytes: PDF('mine') }, key()))
    const theirs = ok(await uploadBidFile(other.ctx(), { rfxEventId, fileName: 'theirs.pdf', bytes: PDF('theirs') }, key()))
    expect(ok(await requestPortalRfxFile(me.ctx(), { rfxEventId, fileId: doc.id }, key()))).toMatchObject({ expiresInSeconds: 300 })
    expect(ok(await requestPortalRfxFile(me.ctx(), { rfxEventId, fileId: mine.fileId }, key())).url).toContain('mine')
    expect(await requestPortalRfxFile(me.ctx(), { rfxEventId, fileId: theirs.fileId }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, aggregateId: { in: [doc.id, mine.fileId] }, type: 'file.downloaded' } })).toBe(2)
    await prisma.fileObject.update({ where: { id: mine.fileId }, data: { scanStatus: 'INFECTED' } })
    expect(await requestPortalRfxFile(me.ctx(), { rfxEventId, fileId: mine.fileId }, key())).toMatchObject({ ok: false, error: { code: 'FILE_INFECTED' } })
    // the files are read through the portal's registry: the detail shows the RFx's document and the contact's own file only
    const detail = (await portalRfx(me.ctx(), rfxEventId))!
    expect(detail.files.map((f) => f.fileName)).toEqual(['spec.pdf'])
    expect(detail.bid!.files.map((f) => f.fileName)).toEqual(['mine.pdf'])
  })
})

describe('[FR-SRC-202/AC1] the contact\'s own state through the RFx\'s life, the home\'s row and the landing after the link', () => {
  it('to bid → draft → sent → to send again after an amendment → closed → awarded, or not awarded for the other', async () => {
    const me = await party('ได้งาน')
    const other = await party('ไม่ได้งาน')
    const idle = await party('ไม่ยื่น')
    const { rfxEventId, lines } = await openRfq([me, other, idle])
    const state = async (p: typeof me, now = MON) => (await portalRfx(p.ctx(now), rfxEventId))!.portalStatus
    expect(await state(me)).toBe('NOT_SUBMITTED')
    expect(await portalRfxSummary(me.ctx())).toEqual({ invited: 1, toDo: 1 })
    ok(await saveBid(me.ctx(), { rfxEventId, lines: priced(lines, ['150.00', '600.00']) }, key()))
    expect(await state(me)).toBe('DRAFT')
    ok(await submitBid(me.ctx(), { rfxEventId, lines: priced(lines, ['150.00', '600.00']) }, key()))
    ok(await submitBid(other.ctx(), { rfxEventId, lines: priced(lines, ['160.00', '650.00']) }, key()))
    expect(await state(me)).toBe('SUBMITTED')
    expect(await portalRfxSummary(me.ctx())).toEqual({ invited: 1, toDo: 0 })
    ok(await amendRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), summary: 'แก้รายละเอียดการส่ง', description: 'ขอราคา ส่งหน้างาน' }, key()))
    expect(await state(me)).toBe('RECONFIRM')
    expect((await listPortalRfx(me.ctx()))[0]).toMatchObject({ id: rfxEventId, portalStatus: 'RECONFIRM' })
    ok(await submitBid(me.ctx(), { rfxEventId, lines: priced(lines, ['150.00', '600.00']) }, key()))
    expect(await state(me)).toBe('SUBMITTED')
    // at closesAt exactly the RFx is closed for the contact, whatever the job's timing
    expect(await state(me, AFTER)).toBe('CLOSED')
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    // an approved award gives line 1 and 2 to the first supplier only
    const bid = await prisma.bid.findFirstOrThrow({ where: { rfxEventId, supplierId: me.supplier.id } })
    const award = await prisma.awardDecision.create({
      data: { organizationId: org.organizationId, rfxEventId, number: `AWD-T-${randomUUID().slice(0, 6)}`, status: 'APPROVED', netSatang: 1740000n, vatSatang: 121800n, grossSatang: 1861800n, createdById: org.member.proc_officer!, submittedById: org.member.proc_officer!, submittedAt: AFTER, decidedAt: AFTER },
    })
    const rfxLines = await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })
    for (const [i, l] of rfxLines.entries()) {
      await prisma.awardLine.create({ data: { organizationId: org.organizationId, awardDecisionId: award.id, rfxLineId: l.id, bidId: bid.id, supplierId: me.supplier.id, quantity: l.quantity, unitPriceSatang: i === 0 ? 15000n : 60000n, lineNetSatang: i === 0 ? 1500000n : 240000n, vatRateBp: 700 } })
    }
    await prisma.rfxEvent.update({ where: { id: rfxEventId }, data: { status: 'AWARDED', awardDecisionId: award.id } })
    const won = (await portalRfx(me.ctx(AFTER), rfxEventId))!
    expect(won.portalStatus).toBe('AWARDED')
    expect(won.awardedLines).toEqual([
      expect.objectContaining({ lineNo: 1, quantity: '100', unitPrice: '150.00', lineNet: '15000.00' }),
      expect.objectContaining({ lineNo: 2, quantity: '4', unitPrice: '600.00', lineNet: '2400.00' }),
    ])
    const lost = (await portalRfx(other.ctx(AFTER), rfxEventId))!
    expect(lost).toMatchObject({ portalStatus: 'NOT_AWARDED', awardedLines: [] })
    expect(await state(idle, AFTER)).toBe('CLOSED')
  })

  it('the contact who came by the invite\'s one-time link lands on that RFx', async () => {
    const me = await party('มาจากลิงก์')
    const { rfxEventId } = await openRfq([me])
    expect(await portalRfxLanding(me.ctx())).toBe('')
    const invite = await prisma.rfxInvite.findFirstOrThrow({ where: { rfxEventId, supplierId: me.supplier.id } })
    await prisma.portalInviteLink.update({ where: { id: invite.linkId! }, data: { usedAt: MON } })
    expect(await portalRfxLanding(me.ctx())).toBe(`/rfx/${rfxEventId}`)
  })
})

describe('[BR-RFX-07] [BR-VAT-04] a supplier whose VAT registration the register says is cancelled bids without VAT', () => {
  it('vat 0 on the bid, no VAT-included prices offered, and the page shows a rate of 0', async () => {
    const me = await party('เลิกจด VAT')
    const { rfxEventId, lines } = await openRfq([me])
    // a flagged supplier is never invited (SUPPLIER_FLAGGED): the register's monthly job flags it after the invite (BR-SUP-04)
    await prisma.supplier.update({ where: { id: me.supplier.id }, data: { registryFlag: 'VAT_CANCELLED' } })
    const detail = (await portalRfx(me.ctx(), rfxEventId))!
    expect(detail).toMatchObject({ supplierVatRegistered: false, vatInclusiveAllowed: false, vatRateBp: 0, bidder: 'SUPPLIER' })
    expect(ok(await submitBid(me.ctx(), { rfxEventId, lines: priced(lines, ['150.00', '600.00']) }, key()))).toMatchObject({ net: '17400.00', vat: '0.00', gross: '17400.00' })
    expect(await prisma.bid.findFirstOrThrow({ where: { rfxEventId, supplierId: me.supplier.id } })).toMatchObject({ vatRateBp: 0, isVatRegistered: false })
  })
})
