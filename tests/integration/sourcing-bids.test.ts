import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { portalRfx } from '@/server/portal/queries-rfx'
import { portalCtx } from '@/server/portal/session'
import {
  bidForMember,
  closeRfxAt,
  createRfx,
  declineRfx,
  disqualifyBid,
  inviteToRfx,
  openRfx,
  recordBidOnBehalf,
  saveBid,
  setScorecard,
  submitBid,
  updateRfx,
  viewRfx,
  withdrawBid,
} from '@/server/services/sourcing'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S10-06 (FR-SRC-202 AC1 to AC4 AC6 · INV-RFX-01 02 · BR-RFX-02 03 06 07 08 10): bids on real Postgres — the contact of an
// invited, ACTIVE supplier saves, submits (again), withdraws; amounts from compareBids with the VAT of the day (0 when
// not registered); late at closesAt exactly; an application's contact waits; sealed prices refused inside before the
// close (and the refusal kept); procurement records a bid received by other means; one bid per supplier.

const MON = new Date('2026-11-02T02:00:00Z') // Monday 09:00 Bangkok
const CLOSES = '2026-11-05T10:00:00Z' // Thursday 17:00
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
let seq = 100
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
  // the member "auditor" holds AUDITOR: sourcing.view at ORG (the shared test organization gives roles to procurement only)
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: new Date('2026-01-01T00:00:00Z') } })
}, 120_000)

const proc = (now = MON) => org.ctxOf('proc_officer', now)
const version = async (id: string) => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id } })).version

async function party(name: string, opts: { vat?: boolean } = {}) {
  const vat = opts.vat ?? true
  const s = await prisma.supplier.create({
    data: { organizationId: org.organizationId, code: `B-${randomUUID().slice(0, 6)}`, nameTh: name, taxId: vat ? taxId() : null, isForeign: !vat, isVatRegistered: vat, branchCode: '00000', portalEnabled: true },
  })
  const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: s.id, nameTh: `ติดต่อ ${name}`, email: `b-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true } })
  return { supplier: s, contact, ctx: (now = MON) => portalCtx(org.organizationId, contact, now) }
}

/** An open RFQ of two lines (8 and 5 tonnes) and its three parties; the scorecard is price-only so the close reveals */
async function openRfq(options: { allowPartialBids?: boolean; allowVatInclusiveBids?: boolean } = {}) {
  if (options.allowVatInclusiveBids) {
    const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as Record<string, unknown>
    await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, sourcing: { allowVatInclusiveBids: true } } } })
  }
  const { rfxEventId } = ok(
    await createRfx(
      proc(),
      {
        kind: 'RFQ',
        title: 'เหล็กข้ออ้อย DB12',
        description: 'ขอราคา',
        source: { kind: 'NEED', categoryCode: 'STEEL', lines: [{ description: 'DB12 ไซต์ 1', quantity: '8', uom: 'ตัน', refUnitPrice: '23800.00' }, { description: 'DB12 ไซต์ 9', quantity: '5', uom: 'ตัน', refUnitPrice: '23800.00' }] },
        ...options,
      },
      key(),
    ),
  )
  const parties = [await party('ชลบุรีภัณฑ์'), await party('สหมิตร'), await party('ไม่จด VAT', { vat: false })]
  for (const p of parties) ok(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: p.supplier.id }, key()))
  ok(await setScorecard(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: [{ code: 'PRICE', nameTh: 'ราคา', weightBp: 10000, kind: 'PRICE' }], evaluatorMemberIds: [org.member.dm_proc!, org.member.dm_it!] }, key()))
  ok(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: CLOSES }, key()))
  const lines = await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })
  return { rfxEventId, parties, lines: lines.map((l) => l.id) }
}

const priced = (lines: string[], prices: string[]) => lines.map((rfxLineId, i) => ({ rfxLineId, offered: true, unitPrice: prices[i]! }))

describe('[FR-SRC-202/AC1] [INV-RFX-01] the contact reads its RFx; the page POSTs viewed once; reading writes nothing', () => {
  it('portalRfx shows the invited RFx and no other; reading creates no event; portal.rfx.view moves INVITED → VIEWED once', async () => {
    const { rfxEventId, parties } = await openRfq()
    const me = parties[0]!
    const before = await prisma.event.count({ where: { organizationId: org.organizationId } })
    const detail = await portalRfx(me.ctx(), rfxEventId)
    expect(detail).toMatchObject({ id: rfxEventId, inviteStatus: 'INVITED', bid: null })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId } })).toBe(before)
    const stranger = await party('ไม่ได้รับเชิญ')
    expect(await portalRfx(stranger.ctx(), rfxEventId)).toBeNull()
    const k = { idempotencyKey: `rfx-view:${rfxEventId}:${me.contact.id}`, sender: null }
    ok(await viewRfx(me.ctx(), { rfxEventId }, k))
    ok(await viewRfx(me.ctx(), { rfxEventId }, k)) // the same load again: the stored answer
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'rfx_invite.viewed' } })).toBe(1)
    expect((await prisma.rfxInvite.findFirstOrThrow({ where: { rfxEventId, supplierId: me.supplier.id } })).status).toBe('VIEWED')
    ok(await declineRfx(parties[1]!.ctx(), { rfxEventId, reason: 'ของไม่พอ' }, key()))
    expect((await prisma.rfxInvite.findFirstOrThrow({ where: { rfxEventId, supplierId: parties[1]!.supplier.id } })).status).toBe('DECLINED')
  })
})

describe('[FR-SRC-202/AC2] save, submit, submit again, withdraw — amounts by compareBids, VAT of the day, valid 30 days', () => {
  it('a VAT-registered supplier: 8 × 23,500 + 5 × 23,700 = 306,500.00 + VAT 21,455.00; a resubmit counts; withdraw then send again', async () => {
    const { rfxEventId, parties, lines } = await openRfq()
    const me = parties[0]!
    ok(await saveBid(me.ctx(), { rfxEventId, lines: [{ rfxLineId: lines[0]!, offered: true, unitPrice: '23500.00' }] }, key()))
    expect(await submitBid(me.ctx(), { rfxEventId, lines: [{ rfxLineId: lines[0]!, offered: true, unitPrice: '0' }, { rfxLineId: lines[1]!, offered: true, unitPrice: '23700.00' }] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'PRICE' } } })
    expect(await submitBid(me.ctx(), { rfxEventId, lines: [{ rfxLineId: lines[0]!, offered: true, unitPrice: '23500.00' }] }, key())).toMatchObject({ ok: false, error: { code: 'BID_INCOMPLETE', details: { lines: '2' } } })
    const sent = ok(await submitBid(me.ctx(), { rfxEventId, lines: priced(lines, ['23500.00', '23700.00']) }, key()))
    expect(sent).toMatchObject({ submitCount: 1, net: '306500.00', vat: '21455.00', gross: '327955.00' })
    const bid = await prisma.bid.findUniqueOrThrow({ where: { id: sent.bidId }, include: { lines: { orderBy: { rfxLineId: 'asc' } } } })
    expect(bid).toMatchObject({ status: 'SUBMITTED', vatRateBp: 700, isVatRegistered: true, validUntil: new Date('2026-12-02T00:00:00Z'), revisionNoAtSubmit: 1, submittedByContactId: me.contact.id })
    expect(await prisma.supplierNotice.count({ where: { organizationId: org.organizationId, subjectId: sent.bidId, templateKey: 'rfx.bid_received' } })).toBe(1)
    const again = ok(await submitBid(me.ctx(), { rfxEventId, lines: priced(lines, ['23400.00', '23700.00']) }, key()))
    expect(again).toMatchObject({ bidId: sent.bidId, submitCount: 2, net: '305700.00' })
    ok(await withdrawBid(me.ctx(), { rfxEventId }, key()))
    expect((await prisma.rfxInvite.findFirstOrThrow({ where: { rfxEventId, supplierId: me.supplier.id } })).status).toBe('WITHDRAWN')
    expect(ok(await submitBid(me.ctx(), { rfxEventId, lines: priced(lines, ['23400.00', '23700.00']) }, key())).submitCount).toBe(3)
  })

  it('a supplier not registered for VAT bids with vat 0; a price with VAT included is refused unless the RFx takes it and the supplier is registered', async () => {
    const { rfxEventId, parties, lines } = await openRfq()
    expect(ok(await submitBid(parties[2]!.ctx(), { rfxEventId, lines: priced(lines, ['22000.00', '22000.00']) }, key()))).toMatchObject({ net: '286000.00', vat: '0.00', gross: '286000.00' })
    expect(await submitBid(parties[0]!.ctx(), { rfxEventId, priceIncludesVat: true, lines: priced(lines, ['25000.00', '25000.00']) }, key())).toMatchObject({ ok: false, error: { code: 'VAT_INCLUSIVE_NOT_ALLOWED' } })
    const withVat = await openRfq({ allowVatInclusiveBids: true })
    // 13 × 25,000 = 325,000.00 with VAT → 303,738.32 + 21,261.68 (BR-VAT-03 at the document)
    expect(ok(await submitBid(withVat.parties[0]!.ctx(), { rfxEventId: withVat.rfxEventId, priceIncludesVat: true, lines: priced(withVat.lines, ['25000.00', '25000.00']) }, key()))).toMatchObject({ net: '303738.32', vat: '21261.68', gross: '325000.00' })
    expect(await submitBid(withVat.parties[2]!.ctx(), { rfxEventId: withVat.rfxEventId, priceIncludesVat: true, lines: priced(withVat.lines, ['25000.00', '25000.00']) }, key())).toMatchObject({ ok: false, error: { code: 'VAT_INCLUSIVE_NOT_ALLOWED' } })
  })

  it('a partial bid is taken where the RFx allows it', async () => {
    const { rfxEventId, parties, lines } = await openRfq({ allowPartialBids: true })
    expect(ok(await submitBid(parties[0]!.ctx(), { rfxEventId, lines: [{ rfxLineId: lines[0]!, offered: true, unitPrice: '23500.00' }] }, key()))).toMatchObject({ net: '188000.00' })
    expect((await prisma.bid.findFirstOrThrow({ where: { rfxEventId } })).isPartial).toBe(true)
  })
})

describe('[FR-SRC-202/AC3] late at closesAt exactly; an application waits for its approval', () => {
  it('RFX_CLOSED at closesAt; SUPPLIER_NOT_APPROVED for the contact of an application', async () => {
    const { rfxEventId, parties, lines } = await openRfq()
    expect(await submitBid(parties[0]!.ctx(new Date(CLOSES)), { rfxEventId, lines: priced(lines, ['1.00', '1.00']) }, key())).toMatchObject({ ok: false, error: { code: 'RFX_CLOSED' } })
    const application = await prisma.supplierApplication.create({ data: { organizationId: org.organizationId, kind: 'NEW', invitedById: org.member.proc_officer!, invitedAt: MON, lastActivityAt: MON, expiresAt: new Date('2026-12-02T00:00:00Z'), nameTh: 'ผู้สมัคร', status: 'SUBMITTED' } })
    const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, applicationId: application.id, nameTh: 'ผู้สมัคร', email: `a-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true } })
    ok(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), applicationId: application.id }, key()))
    expect(await submitBid(portalCtx(org.organizationId, contact, MON), { rfxEventId, lines: priced(lines, ['1.00', '1.00']) }, key())).toMatchObject({ ok: false, error: { code: 'SUPPLIER_NOT_APPROVED' } })
  })
})

describe('[FR-SRC-202/AC4] [BR-RFX-06] sealed until the close', () => {
  it('PROCUREMENT and AUDITOR are refused a bid before the close (FORBIDDEN SEALED, kept); bid.submitted carries no amount; after the close they read it', async () => {
    const { rfxEventId, parties, lines } = await openRfq()
    const sent = ok(await submitBid(parties[0]!.ctx(), { rfxEventId, lines: priced(lines, ['23500.00', '23700.00']) }, key()))
    const submitted = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'bid.submitted', aggregateId: sent.bidId } })
    expect(submitted.data).not.toHaveProperty('net')
    for (const who of ['proc_officer', 'auditor']) {
      expect(await bidForMember(org.ctxOf(who, MON), sent.bidId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'SEALED' } } })
    }
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'security.sealed_bid_denied', aggregateId: sent.bidId } })).toBe(2)
    expect(await bidForMember(org.ctxOf('req_con', MON), sent.bidId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await closeRfxAt(org.organizationId, rfxEventId, CLOSES, new Date(CLOSES))).toEqual({ closed: true })
    expect(ok(await bidForMember(org.ctxOf('proc_officer', new Date(CLOSES)), sent.bidId))).toMatchObject({ net: '306500.00', lines: expect.arrayContaining([expect.objectContaining({ unitPrice: '23500.00' })]) })
  })

  it('an RFx unsealed with a reason puts the amounts in bid.submitted', async () => {
    const created = ok(await createRfx(proc(), { kind: 'RFQ', title: 'เปิดซอง', description: 'ทดสอบ', source: { kind: 'NEED', categoryCode: 'STEEL', lines: [{ description: 'เหล็ก', quantity: '1', uom: 'ตัน' }] } }, key()))
    const p = await party('เปิดซอง')
    ok(await updateRfx(proc(), { rfxEventId: created.rfxEventId, expectedVersion: await version(created.rfxEventId), sealed: false, unsealReason: 'ราคากลางเปิดเผยตามระเบียบ' }, key()))
    ok(await inviteToRfx(proc(), { rfxEventId: created.rfxEventId, expectedVersion: await version(created.rfxEventId), supplierId: p.supplier.id }, key()))
    ok(await setScorecard(proc(), { rfxEventId: created.rfxEventId, expectedVersion: await version(created.rfxEventId), criteria: [{ code: 'PRICE', nameTh: 'ราคา', weightBp: 10000, kind: 'PRICE' }], evaluatorMemberIds: [org.member.dm_proc!, org.member.dm_it!] }, key()))
    ok(await openRfx(proc(), { rfxEventId: created.rfxEventId, expectedVersion: await version(created.rfxEventId), closesAt: CLOSES }, key()))
    const line = await prisma.rfxLine.findFirstOrThrow({ where: { rfxEventId: created.rfxEventId } })
    const sent = ok(await submitBid(p.ctx(), { rfxEventId: created.rfxEventId, lines: [{ rfxLineId: line.id, offered: true, unitPrice: '100.00' }] }, key()))
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'bid.submitted', aggregateId: sent.bidId } })).data).toMatchObject({ net: '100.00', vat: '7.00', gross: '107.00' })
  })
})

describe('[FR-SRC-202/AC6] [INV-RFX-02] a bid recorded on behalf; one bid per supplier; disqualified after the close', () => {
  it('procurement records a bid with its file and is named as its recorder; two contacts of one supplier sending at once make one bid', async () => {
    const { rfxEventId, parties, lines } = await openRfq()
    const target = parties[1]!
    expect(await recordBidOnBehalf(proc(), { rfxEventId, supplierId: target.supplier.id, fileId: randomUUID(), lines: priced(lines, ['24000.00', '24000.00']) }, key())).toMatchObject({ ok: false, error: { details: { reason: 'FILE' } } })
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'quote.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.proc_officer! } })
    const recorded = ok(await recordBidOnBehalf(proc(), { rfxEventId, supplierId: target.supplier.id, fileId: file.id, lines: priced(lines, ['24000.00', '24000.00']) }, key()))
    expect(await prisma.bid.findUniqueOrThrow({ where: { id: recorded.bidId } })).toMatchObject({ status: 'SUBMITTED', submittedByMemberId: org.member.proc_officer, submittedByContactId: null })
    expect(await prisma.fileLink.count({ where: { subjectType: 'Bid', subjectId: recorded.bidId, kind: 'BID_DOC' } })).toBe(1)
    const second = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: parties[0]!.supplier.id, nameTh: 'ผู้ติดต่อสอง', email: `b2-${randomUUID().slice(0, 8)}@supplier.test` } })
    const both = await Promise.all([
      submitBid(parties[0]!.ctx(), { rfxEventId, lines: priced(lines, ['23500.00', '23700.00']) }, key()),
      submitBid(portalCtx(org.organizationId, second, MON), { rfxEventId, lines: priced(lines, ['23600.00', '23700.00']) }, key()),
    ])
    expect(both.every((r) => r.ok)).toBe(true)
    expect(await prisma.bid.count({ where: { rfxEventId, supplierId: parties[0]!.supplier.id } })).toBe(1)
    // disqualify only after the close, and not while an award is open
    expect(await disqualifyBid(proc(), { bidId: recorded.bidId, reason: 'ไม่ได้ลงนามในใบเสนอราคา' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, new Date(CLOSES))
    const award = await prisma.awardDecision.create({ data: { organizationId: org.organizationId, rfxEventId, createdById: org.member.proc_officer!, netSatang: 100n, vatSatang: 7n, grossSatang: 107n } })
    expect(await disqualifyBid(proc(new Date(CLOSES)), { bidId: recorded.bidId, reason: 'ไม่ได้ลงนาม' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'AWARD_OPEN' } } })
    await prisma.awardDecision.update({ where: { id: award.id }, data: { status: 'CANCELLED', cancelReason: 'ทดสอบ', cancelledAt: new Date(CLOSES) } })
    ok(await disqualifyBid(proc(new Date(CLOSES)), { bidId: recorded.bidId, reason: 'ไม่ได้ลงนามในใบเสนอราคา' }, key()))
    expect(await prisma.bid.findUniqueOrThrow({ where: { id: recorded.bidId } })).toMatchObject({ status: 'DISQUALIFIED' })
    // the price-only scorecard was revealed at the close: the ranking is computed again
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'scorecard.recomputed' } })).toBeGreaterThan(0)
  })
})

describe('[FR-SRC-202/AC6] after the review of S10-06: procurement never replaces a supplier\'s own bid', () => {
  it('BID_FROM_SUPPLIER when the supplier submitted in the portal; FILE_LINKED for a file that is another document\'s evidence', async () => {
    const { rfxEventId, parties, lines } = await openRfq()
    ok(await submitBid(parties[0]!.ctx(), { rfxEventId, lines: priced(lines, ['23500.00', '23700.00']) }, key()))
    const upload = () => prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.proc_officer! } })
    const file = await upload()
    expect(await recordBidOnBehalf(proc(), { rfxEventId, supplierId: parties[0]!.supplier.id, fileId: file.id, lines: priced(lines, ['24500.00', '24500.00']) }, key())).toMatchObject({ ok: false, error: { details: { reason: 'BID_FROM_SUPPLIER' } } })
    expect((await prisma.bid.findFirstOrThrow({ where: { rfxEventId, supplierId: parties[0]!.supplier.id } })).submittedByContactId).toBe(parties[0]!.contact.id)
    ok(await recordBidOnBehalf(proc(), { rfxEventId, supplierId: parties[1]!.supplier.id, fileId: file.id, lines: priced(lines, ['24000.00', '24000.00']) }, key()))
    expect(await recordBidOnBehalf(proc(), { rfxEventId, supplierId: parties[2]!.supplier.id, fileId: file.id, lines: priced(lines, ['24000.00', '24000.00']) }, key())).toMatchObject({ ok: false, error: { details: { reason: 'FILE_LINKED' } } })
    // a bid procurement recorded may be recorded again with a new file (a corrected quotation)
    ok(await recordBidOnBehalf(proc(), { rfxEventId, supplierId: parties[1]!.supplier.id, fileId: (await upload()).id, lines: priced(lines, ['23900.00', '24000.00']) }, key()))
  })
})
