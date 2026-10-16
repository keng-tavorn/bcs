import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { createCatalogItem, createPriceAgreement } from '@/server/services/catalog'
import { createDraft, submitRequest } from '../support/requests'
import { manageFollowers } from '@/server/services/requests/followers'
import { renewRequestLine, reorderRequest } from '@/server/services/requests/repeat'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S6-12 (FR-INT-101 AC1 AC3 · BR-FORM-07): reorder against Postgres, in an organization without the module CONTRACTS.
// The requester's sent request becomes a new draft with its lines (an agreed price in effect replaces the old one),
// its delivery site and suggested supplier — never its files, quotations or budget line. A follower and the head of
// the paying department are refused; a draft is edited, not reordered; only a service line is renewed.

const NOW = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let sourceId: string
let supplier: string
let cement: string

beforeAll(async () => {
  org = await createDoaOrg()
  expect(await prisma.orgModule.count({ where: { organizationId: org.organizationId, module: 'CONTRACTS', enabled: true } })).toBe(0)
  supplier = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S-RE', nameTh: 'ผู้ขายปูน', isForeign: true } })).id
  cement = ok(await createCatalogItem(org.ctxOf('proc_officer', NOW), { code: 'MAT-004', nameTh: 'ปูนซีเมนต์ ถุง 50 กก.', uom: 'ถุง', categoryCode: 'MAT', isService: false, refUnitPrice: '180.00' }, key())).catalogItemId
  const kit = p2p(org, NOW)
  const line = await kit.fundedLine(500_000n)
  const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: 'SITE-RE', nameTh: 'ไซต์ขอซ้ำ', address: 'ถนนทดสอบ' } })
  const draft = ok(
    await createDraft(
      org.ctxOf('req_con', NOW),
      {
        requestTypeCode: 'BUY_GOODS',
        title: 'ปูนรอบที่แล้ว',
        budgetLineId: line,
        deliverySiteId: site.id,
        suggestedSupplierId: supplier,
        lines: [
          { description: 'ปูนซีเมนต์ ถุง 50 กก.', quantity: '100', uom: 'ถุง', unitPrice: '185.00', catalogItemId: cement },
          { description: 'ทรายหยาบ', quantity: '5', uom: 'คิว', unitPrice: '650.00' },
        ],
      },
      key(),
    ),
  )
  const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
  await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  sourceId = draft.requestId
  // After the request was sent, the cement got an agreed price with the same supplier
  ok(await createPriceAgreement(org.ctxOf('proc_officer', NOW), { catalogItemId: cement, supplierId: supplier, unitPrice: '177.00', validFrom: '2026-10-01', validTo: '2027-01-01' }, key()))
}, 120_000)

describe('[FR-INT-101/AC1] reorder makes a new draft of what the current form still asks (BR-FORM-07, GC-FORM-20, GC-FORM-21)', () => {
  it('copies the lines at today\'s agreed price, the site and the supplier; not the files, the quotations or the budget line', async () => {
    const draft = ok(await reorderRequest(org.ctxOf('req_con', NOW), { requestId: sourceId }, key()))
    const row = await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId }, include: { lines: { orderBy: { lineNo: 'asc' } }, quotations: true } })
    const source = await prisma.request.findUniqueOrThrow({ where: { id: sourceId } })
    expect(row).toMatchObject({ status: 'DRAFT', sourceRequestId: sourceId, number: null, budgetLineId: null, deliverySiteId: source.deliverySiteId, suggestedSupplierId: supplier, title: source.title })
    expect(row.lines.map((l) => [l.description, l.quantity.toString(), l.unitPriceSatang, l.catalogItemId, l.serviceEndDate])).toEqual([
      ['ปูนซีเมนต์ ถุง 50 กก.', '100', 17_700n, cement, null],
      ['ทรายหยาบ', '5', 65_000n, null, null],
    ])
    expect(row.lines[0]!.priceAgreementId).not.toBeNull()
    expect(row.quotations).toHaveLength(0)
    expect(await prisma.fileLink.count({ where: { subjectType: 'Request', subjectId: draft.requestId } })).toBe(0)
    expect(await prisma.event.findFirst({ where: { type: 'request.drafted', aggregateId: draft.requestId } })).toMatchObject({ data: { source: 'REORDER' } })
  })

  it('a follower and the head of the paying department are refused; a draft is not reordered', async () => {
    ok(await manageFollowers(org.ctxOf('req_con', NOW), { requestId: sourceId, memberId: org.member.dm_con!, follow: true }, key()))
    for (const code of ['dm_con', 'vp_ops', 'proc_officer']) {
      expect(await reorderRequest(org.ctxOf(code, NOW), { requestId: sourceId }, key()), code).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    const draft = await prisma.request.findFirstOrThrow({ where: { organizationId: org.organizationId, status: 'DRAFT', sourceRequestId: sourceId } })
    expect(await reorderRequest(org.ctxOf('req_con', NOW), { requestId: draft.id }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await reorderRequest(org.ctxOf('req_con', NOW), { requestId: randomUUID() }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('only a service line with an end date is renewed, and only by its requester', async () => {
    const lines = await prisma.requestLine.findMany({ where: { requestId: sourceId }, orderBy: { lineNo: 'asc' } })
    expect(await renewRequestLine(org.ctxOf('req_con', NOW), { requestLineId: lines[0]!.id }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NOT_A_SERVICE_LINE' } } })
    expect(await renewRequestLine(org.ctxOf('vp_ops', NOW), { requestLineId: lines[0]!.id }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})
