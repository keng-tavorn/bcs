import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { prisma } from '@/server/db/client'
import { createCatalogItem, createPriceAgreement, endPriceAgreement, updateCatalogItem } from '@/server/services/catalog'
import { getCatalogManage, listCatalog } from '@/server/services/catalog/view'
import { createDraft, editRequest, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S6-10 (FR-INT-102 · BR-PRC-06 · OQ-114): the catalogue and its agreed prices against Postgres, through the services
// the pages call. PROCUREMENT keeps the catalogue (every change an event; other roles refused), every member searches
// it, and a request line from the catalogue takes the agreed price of its supplier — checked on every save and again
// at submit — or names a reason for another supplier. On the §7.4 fixture: `proc_officer` is PROCUREMENT.

const NOW = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let s1: string
let s2: string
let cement: string
let agreement: string
const as = (code: string, at = NOW) => org.ctxOf(code, at)

beforeAll(async () => {
  org = await createDoaOrg()
  s1 = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S-CAT-1', nameTh: 'ผู้ขายปูน', taxId: '0999999000012' } })).id
  s2 = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S-CAT-2', nameTh: 'ผู้ขายอื่น', isForeign: true } })).id
})

describe('[FR-INT-102/AC3] PROCUREMENT keeps the catalogue and its agreed prices, each change an event', () => {
  it('adds an item and an agreed price for this year; the same period again overlaps (GC-PRC-01)', async () => {
    cement = ok(await createCatalogItem(as('proc_officer'), { code: 'MAT-004', nameTh: 'ปูนซีเมนต์ ถุง 50 กก.', uom: 'ถุง', categoryCode: 'MAT', isService: false, refUnitPrice: '180.00' }, key())).catalogItemId
    agreement = ok(await createPriceAgreement(as('proc_officer'), { catalogItemId: cement, supplierId: s1, unitPrice: '177.00', validFrom: '2026-01-01', validTo: '2027-01-01', sourceRef: 'สัญญา 2569' }, key())).priceAgreementId
    expect(await createPriceAgreement(as('proc_officer'), { catalogItemId: cement, supplierId: s1, unitPrice: '170.00', validFrom: '2026-06-01', validTo: '2027-06-01' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'AGREEMENT_OVERLAP' } } })
    // The next year meets this one on a day and does not overlap (GC-PRC-02)
    ok(await createPriceAgreement(as('proc_officer'), { catalogItemId: cement, supplierId: s1, unitPrice: '182.00', validFrom: '2027-01-01', validTo: '2028-01-01' }, key()))
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: { in: ['catalog_item.created', 'price_agreement.created'] } } })).toBe(3)
  })

  it('edits an item with an event naming the fields; nothing changed is refused', async () => {
    ok(await updateCatalogItem(as('proc_officer'), { catalogItemId: cement, refUnitPrice: '181.50', nameEn: 'Cement 50 kg' }, key()))
    expect(await prisma.event.findFirst({ where: { type: 'catalog_item.updated', aggregateId: cement } })).toMatchObject({ data: { code: 'MAT-004', fields: ['nameEn', 'refUnitPrice'] } })
    expect(await prisma.catalogItem.findUniqueOrThrow({ where: { id: cement } })).toMatchObject({ refUnitPriceSatang: amountToSatang('181.50') })
    expect(await updateCatalogItem(as('proc_officer'), { catalogItemId: cement, refUnitPrice: '181.50' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NO_CHANGE' } } })
  })

  it('every other role is refused, and nothing is written', async () => {
    const before = await prisma.catalogItem.count({ where: { organizationId: org.organizationId } })
    for (const code of ['req_con', 'fin_officer', 'admin', 'dm_con']) {
      expect(await createCatalogItem(as(code), { code: `X-${code.toUpperCase().replace("_", "-")}`, nameTh: 'อื่น', uom: 'ชิ้น', categoryCode: 'MAT', isService: false, refUnitPrice: '1.00' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await updateCatalogItem(as(code), { catalogItemId: cement, active: false }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await createPriceAgreement(as(code), { catalogItemId: cement, supplierId: s2, unitPrice: '1.00', validFrom: '2026-01-01', validTo: '2027-01-01' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await endPriceAgreement(as(code), { priceAgreementId: agreement }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await getCatalogManage(as(code))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await prisma.catalogItem.count({ where: { organizationId: org.organizationId } })).toBe(before)
  })
})

describe('[FR-INT-102/AC1] every member searches the catalogue with its reference price and today\'s agreed prices', () => {
  it('a requester finds the item by name or code with the agreed price of this year only', async () => {
    const found = ok(await listCatalog(as('req_con'), { q: 'ปูน' }))
    expect(found.canManage).toBe(false)
    expect(found.items.map((i) => i.code)).toEqual(['MAT-004'])
    expect(found.items[0]).toMatchObject({ refUnitPriceSatang: '18150', agreements: [{ supplierCode: 'S-CAT-1', unitPriceSatang: '17700', inEffect: true }] })
    expect(ok(await listCatalog(as('req_con'), { q: 'mat-004' })).items).toHaveLength(1)
    // The manage page also lists next year's agreement
    expect(ok(await getCatalogManage(as('proc_officer'))).items[0]!.agreements.map((a) => [a.unitPriceSatang, a.inEffect])).toEqual([
      ['17700', true],
      ['18200', false],
    ])
  })
})

describe('[FR-INT-102/AC2] a request line from the catalogue takes the agreed price (BR-PRC-06)', () => {
  const line = (unitPrice: string) => ({ description: 'ปูนซีเมนต์ ถุง 50 กก.', quantity: '100', uom: 'ถุง', unitPrice, catalogItemId: cement })
  const draft = (input: Record<string, unknown>) => createDraft(as('req_con'), { requestTypeCode: 'BUY_GOODS', title: 'ปูนสำหรับงานฐานราก', ...input } as never, key())

  it('saving another price than the agreed one with its supplier is refused (GC-PRC-03); the agreed price is kept with its agreement', async () => {
    expect(await draft({ suggestedSupplierId: s1, lines: [line('185.00')] })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'AGREEMENT_PRICE_LOCKED', field: 'lines.0.unitPrice' } } })
    const saved = ok(await draft({ suggestedSupplierId: s1, lines: [line('177.00')] }))
    expect(await prisma.requestLine.findFirstOrThrow({ where: { requestId: saved.requestId } })).toMatchObject({ catalogItemId: cement, priceAgreementId: agreement })
    // An edit to another price is refused too, and prices that include VAT cannot take an agreed price
    expect(await editRequest(as('req_con'), { requestId: saved.requestId, lines: [{ ...line('190.00'), id: saved.lineIds[0]! }] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'AGREEMENT_PRICE_LOCKED' } } })
    expect(await editRequest(as('req_con'), { requestId: saved.requestId, priceIncludesVat: true, lines: [{ ...line('177.00'), id: saved.lineIds[0]! }] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'AGREEMENT_PRICE_BEFORE_VAT' } } })
    ok(await submitRequest(as('req_con'), { requestId: saved.requestId }, key()))
  })

  it('another supplier needs a reason at submit (GC-PRC-04, GC-PRC-05); the line then has no agreement', async () => {
    const saved = ok(await draft({ suggestedSupplierId: s2, lines: [line('180.00')] }))
    expect(await submitRequest(as('req_con'), { requestId: saved.requestId }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'AGREEMENT_OFF', field: 'offAgreementReason' } } })
    ok(await editRequest(as('req_con'), { requestId: saved.requestId, offAgreementReason: 'ผู้ขายรายเดิมส่งไม่ทัน' }, key()))
    ok(await submitRequest(as('req_con'), { requestId: saved.requestId }, key()))
    expect(await prisma.requestLine.findFirstOrThrow({ where: { requestId: saved.requestId } })).toMatchObject({ catalogItemId: cement, priceAgreementId: null })
  })

  it('the submit checks again with the agreements of its day: an agreement made after the save locks the price', async () => {
    const tape = ok(await createCatalogItem(as('proc_officer'), { code: 'MAT-090', nameTh: 'เทปพันสายไฟ', uom: 'ม้วน', categoryCode: 'MAT', isService: false, refUnitPrice: '25.00' }, key())).catalogItemId
    const saved = ok(await draft({ suggestedSupplierId: s1, lines: [{ description: 'เทปพันสายไฟ', quantity: '10', uom: 'ม้วน', unitPrice: '30.00', catalogItemId: tape }] }))
    ok(await createPriceAgreement(as('proc_officer'), { catalogItemId: tape, supplierId: s1, unitPrice: '24.00', validFrom: '2026-10-01', validTo: '2027-10-01' }, key()))
    expect(await submitRequest(as('req_con'), { requestId: saved.requestId }, key())).toMatchObject({ ok: false, error: { details: { reason: 'AGREEMENT_PRICE_LOCKED' } } })
    // An inactive item cannot be chosen any more
    ok(await updateCatalogItem(as('proc_officer'), { catalogItemId: tape, active: false }, key()))
    expect(await draft({ lines: [{ description: 'เทปพันสายไฟ', quantity: '1', uom: 'ม้วน', unitPrice: '24.00', catalogItemId: tape }] })).toMatchObject({ ok: false, error: { details: { reason: 'UNKNOWN', field: 'lines.0.catalogItemId' } } })
  })
})

describe('[FR-INT-102/AC3] ending an agreed price', () => {
  it('today becomes its last day; one not started yet cannot be ended', async () => {
    expect(ok(await endPriceAgreement(as('proc_officer'), { priceAgreementId: agreement }, key()))).toMatchObject({ validTo: '2026-10-07' })
    expect(await prisma.event.findFirst({ where: { type: 'price_agreement.ended', aggregateId: agreement } })).toMatchObject({ data: { validTo: '2026-10-07' } })
    // Tomorrow the item has no agreed price with this supplier: any price goes
    const tomorrow = new Date('2026-10-07T03:00:00Z')
    ok(await createDraft(as('req_con', tomorrow), { requestTypeCode: 'BUY_GOODS', title: 'ปูนเพิ่ม', suggestedSupplierId: s1, lines: [{ description: 'ปูน', quantity: '1', uom: 'ถุง', unitPrice: '185.00', catalogItemId: cement }] }, key()))
    const next = await prisma.priceAgreement.findFirstOrThrow({ where: { catalogItemId: cement, validFrom: new Date('2027-01-01T00:00:00Z') } })
    expect(await endPriceAgreement(as('proc_officer'), { priceAgreementId: next.id }, key())).toMatchObject({ ok: false, error: { details: { reason: 'AGREEMENT_NOT_STARTED' } } })
  })
})
