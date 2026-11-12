import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { portalRfx } from '@/server/portal/queries-rfx'
import { portalCtx } from '@/server/portal/session'
import { amendRfx, createRfx, inviteToRfx, openRfx, saveBid, setScorecard, submitBid, updateRfx } from '@/server/services/sourcing'
import { textIn } from '@/app/portal/[org]/rfx/_lib/words'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { thaiTaxId } from '../support/tax-id'

// S10-17 (FR-INT-201 AC2 AC3 AC4 · BR-FORM-11 · ADR-208 · OQ-205 OQ-211) on real Postgres: an RFx that invites a foreign
// supplier or an English-reading contact is in Thai and English (TH_EN) and opens only with all its English; a line's
// English starts from its catalogue item's English name; the contact reads the English, or the Thai marked "(TH)"; an RFx
// and a bid are in baht only — another currency is refused, never converted (NG-9).

const MON = new Date('2026-11-02T02:00:00Z') // Monday 09:00 Bangkok
const CLOSES = '2026-11-20T10:00:00Z'
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const PRICE_ONLY = [{ code: 'PRICE', nameTh: 'ราคา', weightBp: 10000, kind: 'PRICE' as const }]

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  for (const m of ['SUPPLIER', 'SOURCING'] as const) {
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: m, enabled: true, enabledAt: new Date('2026-01-01T00:00:00Z'), contractRef: 'TEST-S10', reason: 'องค์กรทดสอบจัดหา' } })
  }
}, 120_000)

const proc = () => org.ctxOf('proc_officer', MON)
const version = async (id: string) => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id } })).version

/** A supplier with its primary contact: Thai (a tax id), or foreign without one; the contact reads Thai or English */
async function party(name: string, opts: { foreign?: boolean; locale?: 'th' | 'en' } = {}) {
  const foreign = opts.foreign ?? false
  const s = await prisma.supplier.create({
    data: { organizationId: org.organizationId, code: `BI-${randomUUID().slice(0, 6)}`, nameTh: name, taxId: foreign ? null : thaiTaxId(), isForeign: foreign, isVatRegistered: !foreign, payeeType: foreign ? 'FOREIGN' : 'JURISTIC', branchCode: '00000', portalEnabled: true },
  })
  const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: s.id, nameTh: `ติดต่อ ${name}`, email: `bi-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true, locale: opts.locale ?? 'th' } })
  return { supplier: s, contact, ctx: () => portalCtx(org.organizationId, contact, MON) }
}

async function draft(extra: { titleEn?: string; descriptionEn?: string; locale?: 'TH' | 'TH_EN'; catalogItemId?: string } = {}) {
  const { catalogItemId, ...head } = extra
  const { rfxEventId } = ok(
    await createRfx(
      proc(),
      {
        kind: 'RFP',
        title: 'ไฟร์วอลล์สำนักงาน',
        description: 'ขอข้อเสนอไฟร์วอลล์ 2 ไซต์',
        ...head,
        source: { kind: 'NEED', categoryCode: 'IT', lines: [{ description: 'ไฟร์วอลล์พร้อมติดตั้ง', quantity: '2', uom: 'ชุด', refUnitPrice: '150000.00', ...(catalogItemId ? { catalogItemId } : {}) }] },
      },
      key(),
    ),
  )
  ok(await setScorecard(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: PRICE_ONLY, evaluatorMemberIds: [] }, key()))
  return rfxEventId
}

const invite = async (rfxEventId: string, supplierId: string) => inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId }, key())
const open = async (rfxEventId: string) => openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: CLOSES, fewerInvitesReason: 'ผู้ขายในหมวดนี้มีน้อย' }, key())

describe('[FR-INT-201/AC2] an RFx that invites a foreign supplier or an English-reading contact is TH_EN and opens with all its English', () => {
  it('LOCALE_REQUIRED for a foreign supplier or an English contact on a Thai-only RFx; TH_EN takes them; a Thai invitee needs nothing', async () => {
    const rfx = await draft()
    expect((await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfx } })).locale).toBe('TH')
    const thai = await party('สยามเน็ตเวิร์ก')
    ok(await invite(rfx, thai.supplier.id))
    const nordic = await party('Nordic Firewall AS', { foreign: true, locale: 'en' })
    expect(await invite(rfx, nordic.supplier.id)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'LOCALE_REQUIRED', required: 'TH_EN' } } })
    const englishReader = await party('บางกอกซิเคียว', { locale: 'en' })
    expect(await invite(rfx, englishReader.supplier.id)).toMatchObject({ ok: false, error: { details: { reason: 'LOCALE_REQUIRED' } } })
    expect(await prisma.rfxInvite.count({ where: { rfxEventId: rfx } })).toBe(1)
    // the draft becomes TH_EN while its English is still being typed: the invite is taken now, the English checked at the open
    ok(await updateRfx(proc(), { rfxEventId: rfx, expectedVersion: await version(rfx), locale: 'TH_EN' }, key()))
    ok(await invite(rfx, nordic.supplier.id))
    ok(await invite(rfx, englishReader.supplier.id))
    // and back to Thai only is refused while an English reader is invited
    expect(await updateRfx(proc(), { rfxEventId: rfx, expectedVersion: await version(rfx), locale: 'TH' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'LOCALE_REQUIRED' } } })
  })

  it('a TH_EN RFx does not open without its English title, description and each line’s description and unit; with them it opens', async () => {
    const rfx = await draft({ locale: 'TH_EN', titleEn: 'Office firewall' })
    const nordic = await party('Nordic Firewall AS', { foreign: true, locale: 'en' })
    ok(await invite(rfx, nordic.supplier.id))
    expect(await open(rfx)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'LOCALE_REQUIRED', missing: ['descriptionEn', 'lines.1.descriptionEn', 'lines.1.uomEn'] } } })
    expect((await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfx } })).status).toBe('DRAFT')
    const line = await prisma.rfxLine.findFirstOrThrow({ where: { rfxEventId: rfx } })
    ok(await updateRfx(proc(), { rfxEventId: rfx, expectedVersion: await version(rfx), descriptionEn: 'Firewalls for two sites', lines: [{ rfxLineId: line.id, descriptionEn: 'Firewall with installation', uomEn: 'set' }] }, key()))
    expect(await prisma.rfxLine.findUniqueOrThrow({ where: { id: line.id } })).toMatchObject({ descriptionEn: 'Firewall with installation', uomEn: 'set', description: 'ไฟร์วอลล์พร้อมติดตั้ง', uom: 'ชุด' })
    expect((await prisma.event.findFirstOrThrow({ where: { aggregateId: rfx, type: 'rfx.updated' }, orderBy: { id: 'desc' } })).data).toMatchObject({ fields: ['descriptionEn'], lineNos: [1] })
    ok(await open(rfx))
    // an open TH_EN RFx keeps its English: an amendment that clears it is refused
    expect(await amendRfx(proc(), { rfxEventId: rfx, expectedVersion: await version(rfx), summary: 'ลบชื่ออังกฤษ', titleEn: null }, key())).toMatchObject({ ok: false, error: { details: { reason: 'LOCALE_REQUIRED', missing: ['titleEn'] } } })
  })

  it('a line of a catalogue item starts with the item’s English name (BR-FORM-10 · nothing translated); a line of another RFx is not found', async () => {
    const item = await prisma.catalogItem.create({ data: { organizationId: org.organizationId, code: `FW-${randomUUID().slice(0, 6)}`, nameTh: 'ไฟร์วอลล์รุ่น A', nameEn: 'Firewall model A', uom: 'ชุด', categoryCode: 'IT', refUnitPriceSatang: 15_000_000n } })
    const rfx = await draft({ catalogItemId: item.id })
    expect(await prisma.rfxLine.findFirstOrThrow({ where: { rfxEventId: rfx } })).toMatchObject({ descriptionEn: 'Firewall model A', uomEn: null })
    const other = await draft()
    const otherLine = await prisma.rfxLine.findFirstOrThrow({ where: { rfxEventId: other } })
    expect(await updateRfx(proc(), { rfxEventId: rfx, expectedVersion: await version(rfx), lines: [{ rfxLineId: otherLine.id, descriptionEn: 'Firewall', uomEn: 'set' }] }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('inviting a foreign supplier after the open needs the English complete already (a Thai-only open RFx refuses it)', async () => {
    const rfx = await draft()
    ok(await invite(rfx, (await party('ไทยเน็ต')).supplier.id))
    ok(await open(rfx))
    const nordic = await party('Nordic Firewall AS', { foreign: true, locale: 'en' })
    expect(await invite(rfx, nordic.supplier.id)).toMatchObject({ ok: false, error: { details: { reason: 'LOCALE_REQUIRED', required: 'TH_EN' } } })
  })
})

describe('[FR-INT-201/AC3] the portal reads the contact’s language: the RFx’s English, or its Thai marked (TH)', () => {
  it('an English contact gets the English of the RFx and its lines; where there is none the Thai is shown with (TH), never blank', async () => {
    const rfx = await draft({ locale: 'TH_EN', titleEn: 'Office firewall', descriptionEn: 'Firewalls for two sites' })
    const line = await prisma.rfxLine.findFirstOrThrow({ where: { rfxEventId: rfx } })
    ok(await updateRfx(proc(), { rfxEventId: rfx, expectedVersion: await version(rfx), lines: [{ rfxLineId: line.id, descriptionEn: 'Firewall with installation', uomEn: 'set' }] }, key()))
    const nordic = await party('Nordic Firewall AS', { foreign: true, locale: 'en' })
    ok(await invite(rfx, nordic.supplier.id))
    ok(await open(rfx))
    const seen = (await portalRfx(nordic.ctx(), rfx))!
    expect(seen).toMatchObject({ title: 'ไฟร์วอลล์สำนักงาน', titleEn: 'Office firewall', descriptionEn: 'Firewalls for two sites' })
    expect(textIn('en', seen.title, seen.titleEn)).toBe('Office firewall')
    expect(textIn('en', seen.lines[0]!.uom, seen.lines[0]!.uomEn)).toBe('set')
    expect(textIn('en', 'รายละเอียด', null)).toBe('รายละเอียด (TH)')
    expect(textIn('en', 'รายละเอียด', '  ')).toBe('รายละเอียด (TH)')
    expect(textIn('th', seen.title, seen.titleEn)).toBe('ไฟร์วอลล์สำนักงาน')
  })
})

describe('[FR-INT-201/AC4] baht only (NG-9): another currency is refused on the RFx and on the bid, never converted', () => {
  it('CURRENCY for an RFx or a bid in USD; THB is taken and the bid is in baht with VAT 0 for the foreign supplier', async () => {
    expect(
      await createRfx(proc(), { kind: 'RFQ', title: 'x', description: 'y', currency: 'USD', source: { kind: 'NEED', categoryCode: 'IT', lines: [{ description: 'a', quantity: '1', uom: 'ชุด' }] } }, key()),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'CURRENCY' } } })
    const rfx = await draft({ locale: 'TH_EN', titleEn: 'Office firewall', descriptionEn: 'Firewalls for two sites' })
    expect(await updateRfx(proc(), { rfxEventId: rfx, expectedVersion: await version(rfx), currency: 'EUR', title: 'ใหม่' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CURRENCY' } } })
    const line = await prisma.rfxLine.findFirstOrThrow({ where: { rfxEventId: rfx } })
    ok(await updateRfx(proc(), { rfxEventId: rfx, expectedVersion: await version(rfx), lines: [{ rfxLineId: line.id, descriptionEn: 'Firewall', uomEn: 'set' }] }, key()))
    const nordic = await party('Nordic Firewall AS', { foreign: true, locale: 'en' })
    ok(await invite(rfx, nordic.supplier.id))
    ok(await open(rfx))
    const lines = [{ rfxLineId: line.id, offered: true, unitPrice: '140000.00' }]
    expect(await saveBid(nordic.ctx(), { rfxEventId: rfx, currency: 'USD', lines }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'CURRENCY' } } })
    expect(await submitBid(nordic.ctx(), { rfxEventId: rfx, currency: 'NOK', lines }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CURRENCY' } } })
    expect(ok(await submitBid(nordic.ctx(), { rfxEventId: rfx, currency: 'THB', lines }, key()))).toMatchObject({ net: '280000.00', vat: '0.00', gross: '280000.00' })
    expect((await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfx } })).currency).toBe('THB')
  })
})
