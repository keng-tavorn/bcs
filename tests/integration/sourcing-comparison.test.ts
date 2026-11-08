import { createHash, randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { compareBids } from '@/core/sourcing'
import { readObject } from '@/integrations/storage'
import { prisma } from '@/server/db/client'
import { portalCtx } from '@/server/portal/session'
import {
  closeRfxAt,
  comparisonFacts,
  createRfx,
  exportComparison,
  inviteToRfx,
  openRfx,
  registerSupplierRiskProvider,
  rfxComparison,
  setScorecard,
  submitBid,
} from '@/server/services/sourcing'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S10-09 (FR-SRC-202 AC5 · FR-SRC-203 AC4 · BR-RFX-08 BR-RFX-11 · BR-AI-32): the comparison table of an RFx on real Postgres
// — scene 9 as GC-SRC-01 (the bid with VAT brought before VAT and spread over its lines), the same as core's compareBids;
// sealed before the close; read only by those who read its prices; the reference of each line and bid (the bidder's own
// agreed price, another's, the catalogue's, the price typed) and its one flag as GC-SRC-31 and GC-SRC-32; the facts with
// no supplier's text or contact and an individual by code; RISK's tag on and off; the Excel export and its sha256.

const MON = new Date('2026-11-02T02:00:00Z')
const CLOSES = '2026-11-05T10:00:00Z'
const AFTER = new Date('2026-11-05T10:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
let seq = 700
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
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: new Date('2026-01-01T00:00:00Z') } })
  const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as Record<string, unknown>
  await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, sourcing: { allowVatInclusiveBids: true } } } })
}, 120_000)

const proc = (now = MON) => org.ctxOf('proc_officer', now)
const version = async (id: string) => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id } })).version

async function party(name: string, opts: { individual?: boolean } = {}) {
  const s = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `C-${randomUUID().slice(0, 6)}`, nameTh: name, taxId: taxId(), isVatRegistered: true, branchCode: '00000', portalEnabled: true, payeeType: opts.individual ? 'INDIVIDUAL' : 'JURISTIC' } })
  const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: s.id, nameTh: `ติดต่อ ${name}`, email: `c-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true } })
  return { supplier: s, contact, ctx: () => portalCtx(org.organizationId, contact, MON) }
}

/** An RFQ of 8 and 5 tonnes (a typed reference of 23,800.00 unless a catalogue item is given), its parties, opened */
async function rfq(parties: Array<Awaited<ReturnType<typeof party>>>, opts: { catalogItemId?: string } = {}) {
  const lines = [
    { description: 'DB12 ไซต์ 1', quantity: '8', uom: 'ตัน', ...(opts.catalogItemId ? { catalogItemId: opts.catalogItemId } : { refUnitPrice: '23800.00' }) },
    { description: 'DB12 ไซต์ 9', quantity: '5', uom: 'ตัน', ...(opts.catalogItemId ? { catalogItemId: opts.catalogItemId } : { refUnitPrice: '23800.00' }) },
  ]
  const { rfxEventId } = ok(await createRfx(proc(), { kind: 'RFQ', title: 'เหล็กข้ออ้อย DB12', description: 'ขอราคา', allowVatInclusiveBids: true, source: { kind: 'NEED', categoryCode: 'STEEL', lines } }, key()))
  for (const p of parties) ok(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: p.supplier.id }, key()))
  ok(await setScorecard(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: [{ code: 'PRICE', nameTh: 'ราคา', weightBp: 10000, kind: 'PRICE' }], evaluatorMemberIds: [] }, key()))
  ok(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: CLOSES, ...(parties.length < 3 ? { fewerInvitesReason: 'ผู้ขายในตลาดมีน้อยราย' } : {}) }, key()))
  const ids = (await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })).map((l) => l.id)
  return { rfxEventId, lines: ids }
}
const send = async (p: Awaited<ReturnType<typeof party>>, rfxEventId: string, lines: string[], unit: string, opts: { vat?: boolean; brand?: string; note?: string } = {}) =>
  ok(await submitBid(p.ctx(), { rfxEventId, priceIncludesVat: opts.vat ?? false, ...(opts.note ? { note: opts.note } : {}), lines: lines.map((rfxLineId) => ({ rfxLineId, offered: true, unitPrice: unit, ...(opts.brand ? { brand: opts.brand } : {}) })) }, key())).bidId

describe('[FR-SRC-202/AC5] [GC-SRC-01] scene 9\'s table: amounts before VAT by compareBids, sealed before the close', () => {
  it('three bids, one with VAT: the table is core\'s compareBids, with its tags; nothing before the close', async () => {
    const ps = [await party('SP0023 ชลบุรีภัณฑ์'), await party('SP0029 สหมิตร'), await party('SP0024 เหล็กไทย')]
    const { rfxEventId, lines } = await rfq(ps)
    const bids = [await send(ps[0]!, rfxEventId, lines, '23150.00'), await send(ps[1]!, rfxEventId, lines, '23500.00'), await send(ps[2]!, rfxEventId, lines, '25000.00', { vat: true })]
    const sealed = ok(await rfxComparison(proc(), rfxEventId))
    expect(sealed).toMatchObject({ sealed: true, bids: [] })
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    const table = ok(await rfxComparison(proc(AFTER), rfxEventId))
    expect(table.sealed).toBe(false)
    const byBid = new Map(table.bids.map((b) => [b.bidId, b]))
    expect(byBid.get(bids[0]!)).toMatchObject({ net: '300950.00', vat: '21066.50', gross: '322016.50', lowest: true, partial: false, tags: [] })
    expect(byBid.get(bids[1]!)).toMatchObject({ net: '305500.00', vat: '21385.00', gross: '326885.00', lowest: false })
    expect(byBid.get(bids[2]!)).toMatchObject({ net: '303738.32', vat: '21261.68', gross: '325000.00', lowest: false, tags: ['VAT_INCLUDED'] })
    expect(byBid.get(bids[2]!)!.lines.map((l) => [l.quotedUnitPrice, l.lineNet])).toEqual([
      ['25000.00', '186915.89'],
      ['25000.00', '116822.43'],
    ])
    expect(byBid.get(bids[0]!)!.lines.every((l) => l.lowest)).toBe(true)
    // the same numbers as core's compareBids on the stored prices (INV-RFX-05)
    const core = compareBids(
      lines.map((ref, i) => ({ ref, quantity: ['8', '5'][i]! })),
      bids.map((ref, i) => ({ ref, priceIncludesVat: i === 2, vatRateBp: 700, unitPrices: Object.fromEntries(lines.map((l) => [l, amountToSatang(['23150.00', '23500.00', '25000.00'][i]!)])) })),
    )
    for (const c of core.bids) expect(byBid.get(c.ref)).toMatchObject({ net: satangToAmount(c.net), vat: satangToAmount(c.vat), gross: satangToAmount(c.gross), partial: c.partial })
    // BR-RFX-11 with the typed reference of 23,800.00 (MANUAL): all within ±20% — and the bid with VAT through its line's net
    expect(byBid.get(bids[0]!)!.lines[0]).toMatchObject({ reference: { unitPrice: '23800.00', source: 'MANUAL' }, deviationBp: -273, flag: null })
    expect(byBid.get(bids[2]!)!.lines[0]).toMatchObject({ reference: { source: 'MANUAL' }, deviationBp: -182, flag: null })
  })

  it('[sourcing.view] a member who does not read the RFx\'s prices is refused; the auditor reads them', async () => {
    const p = await party('ผู้ขายเดียว')
    const { rfxEventId, lines } = await rfq([p])
    await send(p, rfxEventId, lines, '23000.00')
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    expect(await rfxComparison(org.ctxOf('req_con', AFTER), rfxEventId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await exportComparison(org.ctxOf('req_con', AFTER), { rfxEventId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(ok(await rfxComparison(org.ctxOf('auditor', AFTER), rfxEventId)).bids).toHaveLength(1)
  })
})

describe('[FR-SRC-203/AC4] [GC-SRC-31] [GC-SRC-32] the reference of each line and bid, and its one flag', () => {
  it('the catalogue\'s 23,800.00 flags HIGH and LOW beyond ±20%; the bidder\'s own agreed price flags ABOVE_AGREEMENT first; the others compare with it as AGREEMENT_OTHER', async () => {
    const item = await prisma.catalogItem.create({ data: { organizationId: org.organizationId, code: `DB12-${randomUUID().slice(0, 4)}`, nameTh: 'เหล็กข้ออ้อย DB12', uom: 'ตัน', categoryCode: 'STEEL', refUnitPriceSatang: 2380000n } })
    const ps = [await party('ราคาปกติ'), await party('ราคาสูง'), await party('ราคาต่ำ'), await party('มีราคาตกลง')]
    const { rfxEventId, lines } = await rfq(ps.slice(0, 3), { catalogItemId: item.id })
    const flags = async (unit: string, i: number) => {
      const bidId = await send(ps[i]!, rfxEventId, lines, unit)
      return bidId
    }
    const bidIds = [await flags('23150.00', 0), await flags('30000.00', 1), await flags('18000.00', 2)]
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    const table = ok(await rfxComparison(proc(AFTER), rfxEventId))
    const line0 = (bidId: string) => table.bids.find((b) => b.bidId === bidId)!.lines[0]!
    expect(line0(bidIds[0]!)).toMatchObject({ reference: { unitPrice: '23800.00', source: 'CATALOG' }, deviationBp: -273, flag: null })
    expect(line0(bidIds[1]!)).toMatchObject({ deviationBp: 2605, flag: 'HIGH' })
    expect(line0(bidIds[2]!)).toMatchObject({ deviationBp: -2436, flag: 'LOW' })

    // an agreed price of 22,560.00 for the fourth supplier, in force on the day the RFx opens
    await prisma.priceAgreement.create({ data: { organizationId: org.organizationId, catalogItemId: item.id, supplierId: ps[3]!.supplier.id, unitPriceSatang: 2256000n, validFrom: new Date('2026-01-01T00:00:00Z'), validTo: new Date('2027-01-01T00:00:00Z') } })
    const second = await rfq([ps[3]!, ps[0]!], { catalogItemId: item.id })
    const agreed = await send(ps[3]!, second.rfxEventId, second.lines, '23000.00')
    const other = await send(ps[0]!, second.rfxEventId, second.lines, '23150.00')
    await closeRfxAt(org.organizationId, second.rfxEventId, CLOSES, AFTER)
    const t2 = ok(await rfxComparison(proc(AFTER), second.rfxEventId))
    expect(t2.bids.find((b) => b.bidId === agreed)!.lines[0]).toMatchObject({ reference: { unitPrice: '22560.00', source: 'AGREEMENT' }, deviationBp: 195, flag: 'ABOVE_AGREEMENT' })
    expect(t2.bids.find((b) => b.bidId === other)!.lines[0]).toMatchObject({ reference: { unitPrice: '22560.00', source: 'AGREEMENT_OTHER' }, deviationBp: 261, flag: null })
  })
})

describe('[BR-AI-32] the facts: numbers and codes, no supplier\'s text or contact, an individual by code; RISK\'s tag', () => {
  it('the brand and the note of a bid, the line descriptions and the contacts are not in the facts; an individual is "ผู้ขายบุคคลธรรมดา <code>"', async () => {
    const person = await party('นายสมชาย ใจดี', { individual: true })
    const company = await party('บริษัท ใจดีเหล็ก จำกัด')
    const { rfxEventId, lines } = await rfq([person, company])
    await send(person, rfxEventId, lines, '23000.00', { brand: 'ตราช้างพิเศษ', note: 'โทรหาผม 081-234-5678' })
    await send(company, rfxEventId, lines, '23200.00')
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    const facts = comparisonFacts(ok(await rfxComparison(proc(AFTER), rfxEventId)))
    const text = JSON.stringify(facts)
    expect(facts.bids.map((b) => b.supplier).sort()).toEqual([`ผู้ขายบุคคลธรรมดา ${person.supplier.code}`, 'บริษัท ใจดีเหล็ก จำกัด'].sort())
    for (const hidden of ['นายสมชาย', 'ตราช้างพิเศษ', '081-234-5678', person.contact.email, company.contact.email, 'DB12 ไซต์']) expect(text).not.toContain(hidden)
    expect(facts.bids.every((b) => b.risk === null)).toBe(true)
  })

  it('with RISK on, each bidder carries its tier and whether S11\'s gate would stop a PO (a mock provider); with RISK off, none', async () => {
    registerSupplierRiskProvider(async (_tx, _org, supplierId) => ({ tier: supplierId.endsWith('0') ? 'HIGH' : 'LOW', blocked: supplierId.endsWith('0') }))
    const p = await party('ผู้ขายความเสี่ยง')
    const { rfxEventId, lines } = await rfq([p])
    await send(p, rfxEventId, lines, '23000.00')
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    expect(ok(await rfxComparison(proc(AFTER), rfxEventId)).bids[0]!.risk).toBeNull()
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'RISK', enabled: true, enabledAt: new Date('2026-01-01T00:00:00Z'), contractRef: 'TEST-S10', reason: 'ทดสอบป้ายความเสี่ยง' } })
    try {
      const risk = ok(await rfxComparison(proc(AFTER), rfxEventId)).bids[0]!.risk
      expect(risk).toEqual({ tier: p.supplier.id.endsWith('0') ? 'HIGH' : 'LOW', blocked: p.supplier.id.endsWith('0') })
    } finally {
      await prisma.orgModule.deleteMany({ where: { organizationId: org.organizationId, module: 'RISK' } })
    }
  })
})

describe('[FR-SRC-202/AC5] the Excel export of the table carries its sha256', () => {
  it('a file of the table\'s rows, its checksum recorded on the export and in its event; refused while sealed', async () => {
    const ps = [await party('ส่งออก ก'), await party('ส่งออก ข')]
    const { rfxEventId, lines } = await rfq(ps)
    await send(ps[0]!, rfxEventId, lines, '23150.00')
    await send(ps[1]!, rfxEventId, lines, '23500.00')
    expect(await exportComparison(proc(), { rfxEventId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'SEALED' } } })
    await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
    const out = ok(await exportComparison(proc(AFTER), { rfxEventId }, key()))
    expect(out.rowCount).toBe(4)
    const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: out.exportJobId } })
    expect(job).toMatchObject({ kind: 'REPORT', status: 'COMPLETED', checksum: out.checksum, params: { reportCode: 'RFX_COMPARISON', rfxEventId } })
    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: out.fileId } })
    expect(createHash('sha256').update(await readObject(file.storageKey)).digest('hex')).toBe(out.checksum)
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, aggregateId: out.exportJobId, type: 'export.generated' } })).toBe(1)
  })
})
