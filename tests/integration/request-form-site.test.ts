import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { getRequestView } from '@/server/queries/requests'
import { createDraft, editRequest } from '@/server/services/requests'
import { getNewRequestForm, getRequestForEdit } from '@/server/services/requests/form-view'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// FR-INT-003 AC1 (owned by S4-02), BR-FORM-02: a new purchase form starts with the delivery site of the requester's
// latest request — or the organization's only site — and the requester may change it; it offers the active suppliers of
// the register to suggest, with their basic details only (§2.4 supplier.view). The draft keeps both, and the request's
// page shows them. Real Postgres, never mocked.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
const site: Record<string, string> = {}
const supplier: Record<string, string> = {}

const as = (who: string) => org.ctxOf(who, NOW)
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const draft = async (who: string, extra: Record<string, unknown>) =>
  ok(await createDraft(as(who), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', lines: [{ description: 'ปูน', quantity: '1', uom: 'ถุง', unitPrice: '100.00' }], ...extra }, key())).requestId

beforeAll(async () => {
  org = await createDoaOrg()
  for (const [code, nameTh, active] of [['SITE-B', 'ไซต์ B', true], ['SITE-A', 'ไซต์ A', true], ['SITE-X', 'ไซต์ปิดแล้ว', false]] as const) {
    site[code] = (await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code, nameTh, address: `ที่อยู่ ${code}`, active } })).id
  }
  for (const [code, nameTh, status] of [['S2', 'บริษัท ข ทดสอบ จำกัด', 'ACTIVE'], ['S1', 'บริษัท ก ทดสอบ จำกัด', 'ACTIVE'], ['S9', 'บริษัท เลิกใช้ จำกัด', 'INACTIVE']] as const) {
    supplier[code] = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code, nameTh, taxId: code === 'S1' ? '0999999000012' : code === 'S2' ? '0999999000021' : '0999999000039', status, expressVendorCode: 'V-SECRET', email: 'sales@supplier.test' } })).id
  }
})

describe('[FR-INT-003/AC1] a new form starts with the delivery site of the requester’s latest request, and the requester may change it', () => {
  it('offers the active sites and suppliers (basic details only); with no history and several sites, nothing is chosen for them', async () => {
    const form = ok(await getNewRequestForm(as('asst_con'), 'BUY_GOODS', 'th'))
    expect(form.deliverySites).toEqual([
      { id: site['SITE-A'], code: 'SITE-A', name: 'ไซต์ A', address: 'ที่อยู่ SITE-A' },
      { id: site['SITE-B'], code: 'SITE-B', name: 'ไซต์ B', address: 'ที่อยู่ SITE-B' },
    ])
    expect(form.defaultDeliverySiteId).toBeNull()
    // Only the name and code: no tax id, Express code or e-mail reaches a requester's form
    expect(form.suppliers).toEqual([
      { id: supplier.S1, code: 'S1', name: 'บริษัท ก ทดสอบ จำกัด' },
      { id: supplier.S2, code: 'S2', name: 'บริษัท ข ทดสอบ จำกัด' },
    ])
  })

  it('takes the site of the latest request that names one still in use, whatever its type or status', async () => {
    const first = await draft('req_con', { deliverySiteId: site['SITE-B'] })
    expect(ok(await getNewRequestForm(as('req_con'), 'BUY_GOODS', 'th')).defaultDeliverySiteId).toBe(site['SITE-B'])
    const later = await draft('req_con', { deliverySiteId: site['SITE-A'] })
    expect(ok(await getNewRequestForm(as('req_con'), 'BUY_GOODS', 'th')).defaultDeliverySiteId).toBe(site['SITE-A'])
    // Work on an older request (here its title; an approver's decision or a cancel alike) does not bring its site back
    ok(await editRequest(as('req_con'), { requestId: first, title: 'วัสดุ (แก้ชื่อ)' }, key()))
    expect(ok(await getNewRequestForm(as('req_con'), 'BUY_GOODS', 'th')).defaultDeliverySiteId).toBe(site['SITE-A'])
    // Another type's form starts from the same latest site; a request without a site does not count
    await draft('req_con', {})
    expect(ok(await getNewRequestForm(as('req_con'), 'IT_PURCHASE', 'th')).defaultDeliverySiteId).toBe(site['SITE-A'])
    // Changing the site of the latest request changes the latest choice
    ok(await editRequest(as('req_con'), { requestId: later, deliverySiteId: site['SITE-B'] }, key()))
    expect(ok(await getNewRequestForm(as('req_con'), 'BUY_GOODS', 'th')).defaultDeliverySiteId).toBe(site['SITE-B'])
    // A site closed since then is skipped: here the only site still in use is offered instead
    await prisma.deliverySite.update({ where: { id: site['SITE-B'] }, data: { active: false } })
    try {
      const form = ok(await getNewRequestForm(as('req_con'), 'BUY_GOODS', 'th'))
      expect(form.deliverySites.map((s) => s.code)).toEqual(['SITE-A'])
      expect(form.defaultDeliverySiteId).toBe(site['SITE-A'])
    } finally {
      await prisma.deliverySite.update({ where: { id: site['SITE-B'] }, data: { active: true } })
    }
  })

  it('a draft opens with the site and the supplier it saved, and the request’s page shows them', async () => {
    const requestId = await draft('dm_con', { deliverySiteId: site['SITE-A'], suggestedSupplierId: supplier.S1 })
    expect(ok(await getRequestForEdit(as('dm_con'), requestId, 'th')).draft).toMatchObject({ deliverySiteId: site['SITE-A'], suggestedSupplierId: supplier.S1 })
    const view = await getRequestView(as('dm_con'), requestId)
    expect(view).toMatchObject({ deliverySite: { code: 'SITE-A', name: 'ไซต์ A', address: 'ที่อยู่ SITE-A' }, suggestedSupplier: { code: 'S1', name: { th: 'บริษัท ก ทดสอบ จำกัด', en: null } } })
    // Changed to nothing: the page says neither
    ok(await editRequest(as('dm_con'), { requestId, deliverySiteId: null, suggestedSupplierId: null }, key()))
    expect(await getRequestView(as('dm_con'), requestId)).toMatchObject({ deliverySite: null, suggestedSupplier: null })
  })

  it('only the requester opens their draft with its context (request.create OWN)', async () => {
    const requestId = await draft('req_con', { deliverySiteId: site['SITE-A'] })
    expect(await getRequestForEdit(as('asst_con'), requestId, 'th')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('a new-supplier request has no delivery site and no suggested supplier', async () => {
    const form = ok(await getNewRequestForm(as('req_con'), 'NEW_SUPPLIER', 'th'))
    expect(form).toMatchObject({ deliverySites: [], defaultDeliverySiteId: null, suppliers: [] })
  })
})

describe('[FR-INT-003/AC1] an organization with one delivery site starts every form with it', () => {
  it('uses the only active site when the requester has none of their own yet', async () => {
    const single = await createDoaOrg()
    const only = (await prisma.deliverySite.create({ data: { organizationId: single.organizationId, code: 'HQ-STORE', nameTh: 'คลังสำนักงานใหญ่' } })).id
    expect(ok(await getNewRequestForm(single.ctxOf('req_con', NOW), 'BUY_GOODS', 'en')).defaultDeliverySiteId).toBe(only)
  })
})
