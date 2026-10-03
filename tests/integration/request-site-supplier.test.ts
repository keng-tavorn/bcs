import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { createDraft, editRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S4-02 (FR-INT-003 AC1, BR-CONS-01): a draft carries where the goods go and, optionally, the supplier the requester
// suggests; the site must be an active one of the organization and the supplier an active one; an edit may change or
// clear both. The form fills them in (BR-FORM-02) on top of this.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let site: string
let closedSite: string
let supplier: string
let blocked: string

beforeAll(async () => {
  org = await createDoaOrg()
  site = (await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: 'SITE-A', nameTh: 'ไซต์ A' } })).id
  closedSite = (await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: 'SITE-X', nameTh: 'ไซต์ปิด', active: false } })).id
  supplier = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายหนึ่ง', taxId: '0999999000012' } })).id
  blocked = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S9', nameTh: 'ผู้ขายเลิกใช้', taxId: '0999999000021', status: 'INACTIVE' } })).id
})

const draft = (extra: Record<string, unknown>) =>
  createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', lines: [{ description: 'ปูน', quantity: '1', uom: 'ถุง', unitPrice: '100.00' }], ...extra }, key())

describe('[FR-INT-003/AC1] a draft carries its delivery site and the suggested supplier', () => {
  it('stores both, and an edit changes or clears them', async () => {
    const created = await draft({ deliverySiteId: site, suggestedSupplierId: supplier })
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    expect(await prisma.request.findUniqueOrThrow({ where: { id: created.data.requestId } })).toMatchObject({ deliverySiteId: site, suggestedSupplierId: supplier })
    expect(await editRequest(org.ctxOf('req_con', NOW), { requestId: created.data.requestId, deliverySiteId: null }, key())).toMatchObject({ ok: true })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: created.data.requestId } })).toMatchObject({ deliverySiteId: null, suggestedSupplierId: supplier })
    expect(await editRequest(org.ctxOf('req_con', NOW), { requestId: created.data.requestId, deliverySiteId: site, suggestedSupplierId: null }, key())).toMatchObject({ ok: true })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: created.data.requestId } })).toMatchObject({ deliverySiteId: site, suggestedSupplierId: null })
  })

  it('refuses a site that is closed or unknown and a supplier that is not active, changing nothing', async () => {
    expect(await draft({ deliverySiteId: closedSite })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'deliverySiteId', reason: 'UNKNOWN' } } })
    expect(await draft({ deliverySiteId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'deliverySiteId' } } })
    expect(await draft({ suggestedSupplierId: blocked })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'suggestedSupplierId', reason: 'UNKNOWN' } } })
    const created = await draft({})
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    expect(await editRequest(org.ctxOf('req_con', NOW), { requestId: created.data.requestId, suggestedSupplierId: blocked }, key())).toMatchObject({ ok: false, error: { details: { field: 'suggestedSupplierId' } } })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: created.data.requestId } })).toMatchObject({ suggestedSupplierId: null, version: 0 })
  })
})
