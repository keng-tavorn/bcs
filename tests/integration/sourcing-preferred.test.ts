import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { getRequestView } from '@/server/queries/requests'
import { createCatalogItem, createPriceAgreement } from '@/server/services/catalog'
import { listPool } from '@/server/services/procurement/pool-view'
import { getNewRequestForm } from '@/server/services/requests/form-view'
import { createPreferredSupplier, endPreferredSupplier, preferredSuppliersFor, registerSupplierRiskProvider, runPreferredSupplierExpiry } from '@/server/services/sourcing'
import { upsertPreferredFromAward } from '@/server/services/sourcing/preferred'
import { preferredRowStatus, preferredSupplierPage } from '@/server/services/sourcing/preferred-view'
import { createPreferredFromScreen, endPreferredFromScreen } from '@/app/(workspace)/suppliers/preferred/commands'
import { createDraft, editRequest, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S10-13 (ADR-207 · BR-RFX-14 · BR-FORM-12 · §8.12 FR-SRC-204 AC6 AC7 · OQ-210) against Postgres, through the services
// the pages call. A preferred supplier of a category is in effect over [validFrom, validTo), Thai days: an approved award
// makes one per winner from the day of its approval for 365 days (GC-SRC-29 30 38) and extends a pair still in effect;
// PROCUREMENT sets one itself (MANUAL, with a reason) and ends one early; FINANCE and ORG_ADMIN cannot; a daily job warns
// PROCUREMENT 30 days before its end, once. The request form fills the category's preferred supplier, and a request sent
// to another (or none) needs the requester's reason (PREFERRED_OVERRIDE_REASON), which its approver and the pool read —
// beside the reason of BR-PRC-06 in a field of its own — unless, with RISK on, the preferred one is one S11 would stop
// (OVERDUE, REASSESS_REQUIRED, CEASED, VAT_CANCELLED). On the §7.4 fixture: proc_officer is PROCUREMENT, req_con a
// requester, and this file makes fin_officer FINANCE and admin ORG_ADMIN.

const NOW = new Date('2026-11-09T04:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let s1: string
let s2: string
let s3: string
let cement: string
const as = (code: string, at = NOW) => org.ctxOf(code, at)
const moduleRow = (name: 'SOURCING' | 'RISK') => ({ organizationId: org.organizationId, module: name, enabled: true, enabledAt: new Date('2026-01-01T00:00:00Z'), contractRef: 'TEST-S10-13', reason: 'ทดสอบผู้ขายที่แนะนำ' })
const supplier = async (name: string) => (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-PRF-${randomUUID().slice(0, 6)}`, nameTh: name, isForeign: true } })).id

/** An award of an RFx of `categoryCode`, as the rows an approved award leaves (its RFx and decision · BR-RFX-14 needs one) */
async function awardOf(categoryCode: string): Promise<{ id: string; number: string }> {
  const rfx = await prisma.rfxEvent.create({
    data: { organizationId: org.organizationId, kind: 'RFQ', title: `RFQ ${categoryCode}`, description: 'ทดสอบ', categoryCode, sourceKind: 'NEED', requestingDepartmentId: org.department.PROC!, createdById: org.member.proc_officer!, minInvites: 1 },
  })
  const number = `AWD-2569-${String(Math.floor(Math.random() * 90000) + 10000)}`
  const award = await prisma.awardDecision.create({ data: { organizationId: org.organizationId, rfxEventId: rfx.id, number, netSatang: 100n, vatSatang: 7n, grossSatang: 107n, createdById: org.member.proc_officer! } })
  return { id: award.id, number }
}

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.orgModule.create({ data: moduleRow('SOURCING') })
  // the §7.4 fixture gives only proc_officer a role: the refusals below are of real FINANCE and ORG_ADMIN members
  const at = new Date('2026-01-01T00:00:00Z')
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: at } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: at } })
  s1 = await supplier('ผู้ขายที่แนะนำ')
  s2 = await supplier('ผู้ขายรายอื่น')
  s3 = await supplier('ผู้ขายรายที่สาม')
  cement = ok(await createCatalogItem(as('proc_officer'), { code: 'PRF-001', nameTh: 'ปูนซีเมนต์ ถุง 50 กก.', uom: 'ถุง', categoryCode: 'PRF-MAT', isService: false, refUnitPrice: '180.00' }, key())).catalogItemId
}, 180_000)

afterAll(async () => {
  // a test that switched RISK on leaves it off, with no provider answering
  registerSupplierRiskProvider(async () => null)
})

describe('[FR-SRC-204/AC6] an award prefers its winner over [the Thai day of the approval, +365) (GC-SRC-29 30 38)', () => {
  const cases = [
    { id: 'GC-SRC-29', category: 'PRF-29', approvedAt: '2026-11-09T04:00:00Z', validFrom: '2026-11-09', validTo: '2027-11-09', days: { '2026-11-08': false, '2026-11-09': true, '2027-11-08': true, '2027-11-09': false } },
    { id: 'GC-SRC-30', category: 'PRF-30', approvedAt: '2026-11-09T23:30:00Z', validFrom: '2026-11-10', validTo: '2027-11-10', days: { '2026-11-09': false, '2026-11-10': true } },
    { id: 'GC-SRC-38', category: 'PRF-38', approvedAt: '2027-03-01T03:00:00Z', validFrom: '2027-03-01', validTo: '2028-02-29', days: { '2028-02-28': true, '2028-02-29': false } },
  ] as const
  for (const c of cases) {
    it(`${c.id}: ${c.validFrom} to ${c.validTo} (not included), read by the day`, async () => {
      const award = await awardOf(c.category)
      const at = new Date(c.approvedAt)
      const made = await forTenant(org.organizationId).$transaction((tx) => upsertPreferredFromAward(tx, as('proc_officer', at), { awardDecisionId: award.id, categoryCode: c.category, supplierIds: [s1] }))
      const row = await prisma.preferredSupplier.findUniqueOrThrow({ where: { id: made.preferredSupplierIds[0]! } })
      expect([row.validFrom.toISOString().slice(0, 10), row.validTo.toISOString().slice(0, 10), row.source]).toEqual([c.validFrom, c.validTo, 'SOURCING'])
      for (const [day, inEffect] of Object.entries(c.days)) {
        const found = await preferredSuppliersFor(as('req_con', at), c.category, day)
        expect(found.map((p) => [p.supplierId, p.awardNumber]), `${c.id} ${day}`).toEqual(inEffect ? [[s1, award.number]] : [])
      }
    })
  }

  it('the same pair approved again while in effect is extended, not made twice; another winner of the category stands beside it', async () => {
    const first = await awardOf('PRF-EXT')
    const a = await forTenant(org.organizationId).$transaction((tx) => upsertPreferredFromAward(tx, as('proc_officer'), { awardDecisionId: first.id, categoryCode: 'PRF-EXT', supplierIds: [s1] }))
    const later = await awardOf('PRF-EXT')
    const b = await forTenant(org.organizationId).$transaction((tx) => upsertPreferredFromAward(tx, as('proc_officer', new Date('2027-02-01T04:00:00Z')), { awardDecisionId: later.id, categoryCode: 'PRF-EXT', supplierIds: [s1, s2] }))
    expect(b.preferredSupplierIds[0]).toBe(a.preferredSupplierIds[0])
    expect(b.events.map((e) => [e.type, e.data])).toEqual([
      ['preferred_supplier.extended', { categoryCode: 'PRF-EXT', supplierId: s1, from: '2027-11-09', to: '2028-02-01', awardDecisionId: later.id }],
      ['preferred_supplier.created', { categoryCode: 'PRF-EXT', supplierId: s2, validFrom: '2027-02-01', validTo: '2028-02-01', source: 'SOURCING', awardDecisionId: later.id }],
    ])
    // both in effect; the latest validFrom first (the one the form fills, BR-FORM-12)
    expect((await preferredSuppliersFor(as('req_con'), 'PRF-EXT', '2027-06-01')).map((p) => p.supplierId)).toEqual([s2, s1])
  })
})

describe('[FR-SRC-204/AC6] PROCUREMENT sets a preferred supplier itself and ends one early (sourcing.preferred.manage)', () => {
  let manual: string

  it('MANUAL with a reason, from today for preferredSupplierDays; the same pair over the same days is refused (PREFERRED_OVERLAP)', async () => {
    const made = ok(await createPreferredSupplier(as('proc_officer'), { categoryCode: 'PRF-MAT', supplierId: s1, note: 'ผู้ขายหลักของปูนตามสัญญาปี 2570' }, key()))
    manual = made.preferredSupplierId
    expect(made).toMatchObject({ validFrom: '2026-11-09', validTo: '2027-11-09' })
    expect(await prisma.preferredSupplier.findUniqueOrThrow({ where: { id: manual } })).toMatchObject({ source: 'MANUAL', note: 'ผู้ขายหลักของปูนตามสัญญาปี 2570', createdById: org.member.proc_officer, awardDecisionId: null })
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'preferred_supplier.created', aggregateId: manual } })).data).toEqual({ categoryCode: 'PRF-MAT', supplierId: s1, validFrom: '2026-11-09', validTo: '2027-11-09', source: 'MANUAL' })
    expect(await createPreferredSupplier(as('proc_officer'), { categoryCode: 'PRF-MAT', supplierId: s1, validFrom: '2027-06-01', note: 'ซ้ำ' }, key())).toMatchObject({ ok: false, error: { code: 'PREFERRED_OVERLAP', details: { validTo: '2027-11-09', lastDay: '2027-11-08', preferredSupplierId: manual } } })
    // after its end the pair may start again; days in the past, an empty period, an unknown category or supplier are refused
    ok(await createPreferredSupplier(as('proc_officer'), { categoryCode: 'PRF-MAT', supplierId: s1, validFrom: '2027-11-09', validTo: '2028-01-01', note: 'ต่ออายุ' }, key()))
    expect(await createPreferredSupplier(as('proc_officer'), { categoryCode: 'PRF-MAT', supplierId: s3, validFrom: '2026-11-08', note: 'ย้อนหลัง' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'validFrom', reason: 'PERIOD_PAST' } } })
    expect(await createPreferredSupplier(as('proc_officer'), { categoryCode: 'PRF-MAT', supplierId: s3, validFrom: '2026-12-01', validTo: '2026-12-01', note: 'ว่าง' }, key())).toMatchObject({ ok: false, error: { details: { field: 'validTo', reason: 'PERIOD' } } })
    expect(await createPreferredSupplier(as('proc_officer'), { categoryCode: 'NO-SUCH', supplierId: s3, note: 'ไม่มีหมวด' }, key())).toMatchObject({ ok: false, error: { details: { field: 'categoryCode', reason: 'UNKNOWN' } } })
    expect(await createPreferredSupplier(as('proc_officer'), { categoryCode: 'PRF-MAT', supplierId: randomUUID(), note: 'ไม่มีผู้ขาย' }, key())).toMatchObject({ ok: false, error: { details: { field: 'supplierId', reason: 'UNKNOWN' } } })
  })

  it('FINANCE, ORG_ADMIN and a requester are refused both, and nothing is written', async () => {
    const before = await prisma.preferredSupplier.count({ where: { organizationId: org.organizationId } })
    for (const code of ['fin_officer', 'admin', 'req_con']) {
      expect(await createPreferredSupplier(as(code), { categoryCode: 'PRF-MAT', supplierId: s3, note: 'ไม่มีสิทธิ์' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await endPreferredSupplier(as(code), { preferredSupplierId: manual, reason: 'ไม่มีสิทธิ์' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await prisma.preferredSupplier.count({ where: { organizationId: org.organizationId } })).toBe(before)
    expect(await prisma.preferredSupplier.findUniqueOrThrow({ where: { id: manual } })).toMatchObject({ endedAt: null })
  })

  it('ended early with its reason it is no longer in effect; ending it again or after its end is refused', async () => {
    const other = ok(await createPreferredSupplier(as('proc_officer'), { categoryCode: 'PRF-MAT', supplierId: s3, note: 'ทดลองผู้ขายใหม่' }, key())).preferredSupplierId
    expect((await preferredSuppliersFor(as('req_con'), 'PRF-MAT', '2026-11-10')).map((p) => p.supplierId).sort()).toEqual([s1, s3].sort())
    ok(await endPreferredSupplier(as('proc_officer'), { preferredSupplierId: other, reason: 'ผู้ขายส่งของไม่ทัน' }, key()))
    expect(await prisma.preferredSupplier.findUniqueOrThrow({ where: { id: other } })).toMatchObject({ endedById: org.member.proc_officer, endReason: 'ผู้ขายส่งของไม่ทัน' })
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'preferred_supplier.ended', aggregateId: other } })).data).toEqual({ categoryCode: 'PRF-MAT', supplierId: s3, validTo: '2027-11-09', reason: 'ผู้ขายส่งของไม่ทัน' })
    expect((await preferredSuppliersFor(as('req_con'), 'PRF-MAT', '2026-11-10')).map((p) => p.supplierId)).toEqual([s1])
    expect(await endPreferredSupplier(as('proc_officer'), { preferredSupplierId: other, reason: 'อีกครั้ง' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'ALREADY_ENDED' } } })
    expect(await endPreferredSupplier(as('proc_officer', new Date('2027-11-10T04:00:00Z')), { preferredSupplierId: manual, reason: 'หมดแล้ว' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'EXPIRED' } } })
  })

  it('with SOURCING off no new one is set, yet the rows set before still fill the request form (BR-RFX-16)', async () => {
    await prisma.orgModule.updateMany({ where: { organizationId: org.organizationId, module: 'SOURCING' }, data: { enabled: false } })
    try {
      expect(await createPreferredSupplier(as('proc_officer'), { categoryCode: 'PRF-MAT', supplierId: s2, note: 'ปิดโมดูล' }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
      const form = ok(await getNewRequestForm(as('req_con'), 'BUY_GOODS', 'th'))
      expect(form.preferredSuppliers.filter((p) => p.categoryCode === 'PRF-MAT')).toEqual([
        { id: manual, categoryCode: 'PRF-MAT', supplierId: s1, supplierCode: expect.stringMatching(/^S-PRF-/), supplierName: 'ผู้ขายที่แนะนำ', awardNumber: null, validTo: '2027-11-09', risk: null, riskExempt: false },
      ])
      expect(await runPreferredSupplierExpiry(org.organizationId, NOW)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    } finally {
      await prisma.orgModule.updateMany({ where: { organizationId: org.organizationId, module: 'SOURCING' }, data: { enabled: true } })
    }
  })
})

describe('[FR-SRC-204/AC6] job preferred-supplier-expiry warns PROCUREMENT 30 days before the end, once (DIGEST)', () => {
  it('a row ending within 30 days is warned once; the next day nothing is due; extended, it is warned again before its new end', async () => {
    const award = await awardOf('PRF-EXP')
    const ended = new Date('2026-01-10T04:00:00Z') // validTo 2027-01-10: 30 days after 2026-12-11
    const made = await forTenant(org.organizationId).$transaction((tx) => upsertPreferredFromAward(tx, as('proc_officer', ended), { awardDecisionId: award.id, categoryCode: 'PRF-EXP', supplierIds: [s2] }))
    const id = made.preferredSupplierIds[0]!
    const warnedOf = () => prisma.event.findMany({ where: { type: 'preferred_supplier.expiring', aggregateId: id }, select: { data: true } })
    // 31 days before: not yet (the other rows of this organization end later)
    await runPreferredSupplierExpiry(org.organizationId, new Date('2026-12-10T01:00:00Z'))
    expect(await warnedOf()).toEqual([])
    const day = new Date('2026-12-11T01:00:00Z')
    ok(await runPreferredSupplierExpiry(org.organizationId, day))
    expect(await warnedOf()).toEqual([{ data: { categoryCode: 'PRF-EXP', supplierId: s2, validTo: '2027-01-10' } }])
    const notices = await prisma.notification.findMany({ where: { organizationId: org.organizationId, templateKey: 'preferred_supplier.expiring', subjectId: id } })
    expect(notices.map((n) => [n.recipientMemberId, n.urgency])).toEqual([[org.member.proc_officer, 'DIGEST']])
    // the same day again repeats nothing; the next day nothing is due
    ok(await runPreferredSupplierExpiry(org.organizationId, day))
    expect(await runPreferredSupplierExpiry(org.organizationId, new Date('2026-12-12T01:00:00Z'))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await warnedOf()).toHaveLength(1)
    // another award of the pair extends it a year: warned again 30 days before the new end
    const again = await awardOf('PRF-EXP')
    await forTenant(org.organizationId).$transaction((tx) => upsertPreferredFromAward(tx, as('proc_officer', new Date('2026-12-20T04:00:00Z')), { awardDecisionId: again.id, categoryCode: 'PRF-EXP', supplierIds: [s2] }))
    ok(await runPreferredSupplierExpiry(org.organizationId, new Date('2027-11-20T01:00:00Z')))
    expect((await warnedOf()).map((e) => (e.data as { validTo: string }).validTo)).toEqual(['2027-01-10', '2027-12-20'])
  })
})

describe('[FR-SRC-204/AC7] the request form fills the preferred supplier; another one needs the reason (BR-FORM-12)', () => {
  const line = (over: Record<string, unknown> = {}) => ({ description: 'ปูนซีเมนต์ ถุง 50 กก.', quantity: '10', uom: 'ถุง', unitPrice: '180.00', catalogItemId: cement, categoryCode: 'PRF-MAT', ...over })
  const draft = (input: Record<string, unknown>, at = NOW) => createDraft(as('req_con', at), { requestTypeCode: 'BUY_GOODS', title: 'ปูนสำหรับงานฐานราก', ...input } as never, key())
  const overridden = (requestId: string) => prisma.event.findMany({ where: { type: 'request.preferred_overridden', aggregateId: requestId }, select: { data: true } })
  let preferredId: string

  beforeAll(async () => {
    preferredId = (await prisma.preferredSupplier.findFirstOrThrow({ where: { organizationId: org.organizationId, categoryCode: 'PRF-MAT', supplierId: s1, endedAt: null }, orderBy: { validFrom: 'asc' } })).id
  })

  it('the form offers the category\'s preferred supplier; the requester who chooses it is asked nothing, and no reason stays', async () => {
    const form = ok(await getNewRequestForm(as('req_con'), 'BUY_GOODS', 'th'))
    expect(form.preferredSuppliers.find((p) => p.categoryCode === 'PRF-MAT')).toMatchObject({ id: preferredId, supplierId: s1 })
    const saved = ok(await draft({ suggestedSupplierId: s1, preferredSupplierOverrideReason: 'เหลือจากตอนเลือกรายอื่น', lines: [line()] }))
    ok(await submitRequest(as('req_con'), { requestId: saved.requestId }, key()))
    expect(await overridden(saved.requestId)).toEqual([])
    expect(await prisma.request.findUniqueOrThrow({ where: { id: saved.requestId } })).toMatchObject({ preferredSupplierOverrideReason: null })
  })

  it('another supplier, or none, is refused at submit without the reason; with it the request goes, recorded for its approver', async () => {
    for (const suggestedSupplierId of [s2, null]) {
      const saved = ok(await draft({ ...(suggestedSupplierId ? { suggestedSupplierId } : {}), lines: [line()] }))
      expect(await submitRequest(as('req_con'), { requestId: saved.requestId }, key())).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED', details: { field: 'preferredSupplierOverrideReason', reason: 'PREFERRED_OVERRIDE_REASON', categoryCode: 'PRF-MAT', preferredSupplierId: preferredId } },
      })
      expect(await prisma.request.findUniqueOrThrow({ where: { id: saved.requestId } })).toMatchObject({ status: 'DRAFT', number: null })
      ok(await editRequest(as('req_con'), { requestId: saved.requestId, preferredSupplierOverrideReason: 'ผู้ขายที่แนะนำไม่มีของในเดือนนี้' }, key()))
      ok(await submitRequest(as('req_con'), { requestId: saved.requestId }, key()))
      const [event] = await overridden(saved.requestId)
      const data = event!.data as { reasonCommentId: string }
      expect(data).toEqual({ supplierId: suggestedSupplierId, overrides: [{ categoryCode: 'PRF-MAT', preferredSupplierId: preferredId, riskExempt: false }], reasonCommentId: expect.any(String) })
      expect(await prisma.comment.findUniqueOrThrow({ where: { id: data.reasonCommentId } })).toMatchObject({ subjectType: 'Request', subjectId: saved.requestId, body: 'ผู้ขายที่แนะนำไม่มีของในเดือนนี้', authorMemberId: org.member.req_con })
      // its approver reads the reason with the supplier (the facts of the request's task)
      const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST', subjectId: saved.requestId } } } })
      const approver = Object.entries(org.member).find(([, id]) => id === task.assigneeMemberId)![0]
      expect((await getRequestView(as(approver), saved.requestId))?.preferredSupplierOverrideReason).toBe('ผู้ขายที่แนะนำไม่มีของในเดือนนี้')
    }
  })

  it('a line typed freely, or of a category without one in effect, asks nothing', async () => {
    const free = ok(await draft({ suggestedSupplierId: s2, lines: [line({ catalogItemId: null, categoryCode: undefined, description: 'ทรายหยาบ' })] }))
    ok(await submitRequest(as('req_con'), { requestId: free.requestId }, key()))
    const other = ok(await draft({ suggestedSupplierId: s2, lines: [line({ catalogItemId: null, categoryCode: 'PRF-NONE' })] }))
    ok(await submitRequest(as('req_con'), { requestId: other.requestId }, key()))
    expect([...(await overridden(free.requestId)), ...(await overridden(other.requestId))]).toEqual([])
  })

  it('beside BR-PRC-06: an item agreed with the preferred supplier sent to another needs both reasons, each in its own field', async () => {
    const tape = ok(await createCatalogItem(as('proc_officer'), { code: 'PRF-002', nameTh: 'เหล็กเส้น', uom: 'เส้น', categoryCode: 'PRF-MAT', isService: false, refUnitPrice: '120.00' }, key())).catalogItemId
    ok(await createPriceAgreement(as('proc_officer'), { catalogItemId: tape, supplierId: s1, unitPrice: '115.00', validFrom: '2026-11-01', validTo: '2027-11-01' }, key()))
    const saved = ok(await draft({ suggestedSupplierId: s2, lines: [line({ catalogItemId: tape, description: 'เหล็กเส้น', uom: 'เส้น', unitPrice: '125.00' })] }))
    expect(await submitRequest(as('req_con'), { requestId: saved.requestId }, key())).toMatchObject({ ok: false, error: { details: { reason: 'AGREEMENT_OFF', field: 'offAgreementReason' } } })
    ok(await editRequest(as('req_con'), { requestId: saved.requestId, offAgreementReason: 'ราคาตกลงไม่รวมค่าขนส่ง' }, key()))
    expect(await submitRequest(as('req_con'), { requestId: saved.requestId }, key())).toMatchObject({ ok: false, error: { details: { reason: 'PREFERRED_OVERRIDE_REASON', field: 'preferredSupplierOverrideReason' } } })
    ok(await editRequest(as('req_con'), { requestId: saved.requestId, preferredSupplierOverrideReason: 'ผู้ขายรายนี้ส่งถึงไซต์ได้เร็วกว่า' }, key()))
    ok(await submitRequest(as('req_con'), { requestId: saved.requestId }, key()))
    expect(await prisma.request.findUniqueOrThrow({ where: { id: saved.requestId } })).toMatchObject({ offAgreementReason: 'ราคาตกลงไม่รวมค่าขนส่ง', preferredSupplierOverrideReason: 'ผู้ขายรายนี้ส่งถึงไซต์ได้เร็วกว่า' })
  })

  it('procurement reads the reason in the pool once the request is approved', async () => {
    const flow = p2p(org, NOW)
    const saved = ok(await draft({ suggestedSupplierId: s2, preferredSupplierOverrideReason: 'ต้องการผู้ขายในพื้นที่', lines: [line()] }))
    ok(await submitRequest(as('req_con'), { requestId: saved.requestId }, key()))
    await flow.approveAll(saved.requestId)
    const pool = ok(await listPool(as('proc_officer')))
    expect(pool.find((l) => l.requestId === saved.requestId)).toMatchObject({ preferredSupplierOverrideReason: 'ต้องการผู้ขายในพื้นที่', categoryCode: 'PRF-MAT' })
  })
})

describe('[FR-SRC-204/AC7] [BR-RFX-14] RISK on: a preferred supplier S11 would stop asks no reason (both ways)', () => {
  const line = { description: 'ปูนซีเมนต์ ถุง 50 กก.', quantity: '10', uom: 'ถุง', unitPrice: '180.00', catalogItemId: '', categoryCode: 'PRF-MAT' }
  const send = async () => {
    const saved = ok(await createDraft(as('req_con'), { requestTypeCode: 'BUY_GOODS', title: 'ปูนเพิ่ม', suggestedSupplierId: s2, lines: [{ ...line, catalogItemId: cement }] } as never, key()))
    return { id: saved.requestId, result: await submitRequest(as('req_con'), { requestId: saved.requestId }, key()) }
  }
  const risk = (status: string | null) => registerSupplierRiskProvider(async (_tx, _org, supplierId) => (supplierId === s1 ? { tier: 'HIGH', blocked: status !== 'CURRENT', status } : { tier: 'LOW', blocked: false, status: 'CURRENT' }))

  afterAll(async () => {
    await prisma.orgModule.deleteMany({ where: { organizationId: org.organizationId, module: 'RISK' } })
    await prisma.supplier.update({ where: { id: s1 }, data: { registryFlag: 'NONE' } })
    registerSupplierRiskProvider(async () => null)
  })

  it('RISK off: the reason is asked even when the preferred supplier is overdue at S11', async () => {
    risk('OVERDUE')
    expect((await send()).result).toMatchObject({ ok: false, error: { details: { reason: 'PREFERRED_OVERRIDE_REASON' } } })
    expect(ok(await getNewRequestForm(as('req_con'), 'BUY_GOODS', 'th')).preferredSuppliers.find((p) => p.supplierId === s1)).toMatchObject({ risk: null, riskExempt: false })
  })

  it('RISK on: OVERDUE, REASSESS_REQUIRED, CEASED or VAT_CANCELLED → sent without a reason, recorded as exempt; CURRENT → asked', async () => {
    await prisma.orgModule.create({ data: moduleRow('RISK') })
    for (const status of ['OVERDUE', 'REASSESS_REQUIRED']) {
      risk(status)
      const sent = await send()
      ok(sent.result)
      expect((await prisma.event.findFirstOrThrow({ where: { type: 'request.preferred_overridden', aggregateId: sent.id } })).data).toEqual({ supplierId: s2, overrides: [{ categoryCode: 'PRF-MAT', preferredSupplierId: expect.any(String), riskExempt: true }] })
    }
    risk('CURRENT')
    expect((await send()).result).toMatchObject({ ok: false, error: { details: { reason: 'PREFERRED_OVERRIDE_REASON' } } })
    expect(ok(await getNewRequestForm(as('req_con'), 'BUY_GOODS', 'th')).preferredSuppliers.find((p) => p.supplierId === s1)).toMatchObject({ risk: { tier: 'HIGH', status: 'CURRENT', registryFlag: 'NONE' }, riskExempt: false })
    for (const flag of ['CEASED', 'VAT_CANCELLED'] as const) {
      await prisma.supplier.update({ where: { id: s1 }, data: { registryFlag: flag } })
      ok((await send()).result)
      expect(ok(await getNewRequestForm(as('req_con'), 'BUY_GOODS', 'th')).preferredSuppliers.find((p) => p.supplierId === s1)).toMatchObject({ risk: { registryFlag: flag }, riskExempt: true })
    }
    await prisma.supplier.update({ where: { id: s1 }, data: { registryFlag: 'NOT_FOUND' } })
    expect((await send()).result).toMatchObject({ ok: false, error: { details: { reason: 'PREFERRED_OVERRIDE_REASON' } } })
  })
})

describe('[FR-SRC-204/AC6] the page /suppliers/preferred and its commands (sourcing.preferred.manage)', () => {
  it('ended first, then over, still to come, and in effect — ending soon within 30 days of validTo', () => {
    const row = (validFrom: string, validTo: string, endedAt: Date | null = null) => preferredRowStatus({ validFrom, validTo, endedAt }, '2026-11-09')
    expect(row('2026-01-01', '2027-01-01', new Date())).toEqual({ status: 'ENDED', daysLeft: null })
    expect(row('2025-11-09', '2026-11-09')).toEqual({ status: 'EXPIRED', daysLeft: null })
    expect(row('2026-11-10', '2027-11-10')).toEqual({ status: 'UPCOMING', daysLeft: null })
    expect(row('2026-11-09', '2027-11-09')).toEqual({ status: 'IN_EFFECT', daysLeft: 365 })
    expect(row('2025-12-09', '2026-12-09')).toEqual({ status: 'ENDING_SOON', daysLeft: 30 })
    expect(row('2025-12-10', '2026-12-10')).toEqual({ status: 'IN_EFFECT', daysLeft: 31 })
  })

  it('every member reads it; only PROCUREMENT may set and end; procurement\'s words only for who reads the register in full', async () => {
    const proc = ok(await preferredSupplierPage(as('proc_officer'), { category: 'PRF-MAT', show: 'all' }))
    expect(proc).toMatchObject({ canManage: true, sourcingOn: true, category: 'PRF-MAT', today: '2026-11-09' })
    expect(proc.categories).toContain('PRF-MAT')
    expect(proc.suppliers.map((s) => s.id)).toEqual(expect.arrayContaining([s1, s2, s3]))
    const ended = proc.rows.find((r) => r.supplierId === s3)!
    expect(ended).toMatchObject({ status: 'ENDED', canEnd: false, ended: { reason: 'ผู้ขายส่งของไม่ทัน' }, note: 'ทดลองผู้ขายใหม่' })
    const current = proc.rows.find((r) => r.supplierId === s1 && r.validFrom === '2026-11-09')!
    expect(current).toMatchObject({ status: 'IN_EFFECT', lastDay: '2027-11-08', validTo: '2027-11-09', canEnd: true, source: 'MANUAL', award: null })
    // the current view leaves out what ended or is over, keeps what starts later
    const now = ok(await preferredSupplierPage(as('proc_officer'), { category: 'PRF-MAT', show: 'current' }))
    expect(now.rows.map((r) => [r.supplierId, r.status])).toEqual([
      [s1, 'UPCOMING'],
      [s1, 'IN_EFFECT'],
    ])
    for (const code of ['req_con', 'admin']) {
      const page = ok(await preferredSupplierPage(as(code), { category: 'PRF-MAT', show: 'all' }))
      expect(page).toMatchObject({ canManage: false, suppliers: [] })
      expect(page.rows.every((r) => !r.canEnd && r.note === null && (r.ended === null || r.ended.reason === null))).toBe(true)
    }
    const finance = ok(await preferredSupplierPage(as('fin_officer'), { category: 'PRF-MAT', show: 'all' }))
    expect(finance).toMatchObject({ canManage: false })
    expect(finance.rows.find((r) => r.supplierId === s3)).toMatchObject({ note: 'ทดลองผู้ขายใหม่', ended: { reason: 'ผู้ขายส่งของไม่ทัน' } })
  })

  it('the screen sends a first and last day: the last one included becomes validTo the day after; a bad key or field is refused', async () => {
    const made = await createPreferredFromScreen(as('proc_officer'), { categoryCode: 'PRF-MAT', supplierId: s2, validFrom: '2026-12-01', lastDay: '2027-05-31', note: 'ผู้ขายสำรองช่วงหน้าแล้ง' }, randomUUID())
    expect(made.ok).toBe(true)
    const row = await prisma.preferredSupplier.findUniqueOrThrow({ where: { id: (made as { preferredSupplierId: string }).preferredSupplierId } })
    expect([row.validFrom.toISOString().slice(0, 10), row.validTo.toISOString().slice(0, 10)]).toEqual(['2026-12-01', '2027-06-01'])
    expect(await createPreferredFromScreen(as('proc_officer'), { categoryCode: 'PRF-MAT', supplierId: s2, validFrom: '2026-12-01', lastDay: '', note: 'ซ้ำ' }, randomUUID())).toMatchObject({ ok: false, code: 'PREFERRED_OVERLAP', validTo: '2027-06-01' })
    expect(await createPreferredFromScreen(as('proc_officer'), { categoryCode: 'PRF-MAT', supplierId: s2, validFrom: '2026-12-01', lastDay: '', note: 'x' }, 'not-a-key')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect(await createPreferredFromScreen(as('proc_officer'), { categoryCode: 'PRF-MAT', supplierId: s2, validFrom: '1-12-2026', lastDay: '', note: 'วันผิดรูป' }, randomUUID())).toMatchObject({ ok: false, field: 'validFrom' })
    expect(await endPreferredFromScreen(as('fin_officer'), { preferredSupplierId: row.id, reason: 'ไม่มีสิทธิ์' }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await endPreferredFromScreen(as('proc_officer'), { preferredSupplierId: row.id, reason: 'ไม่ใช้แล้ว', extra: 1 }, randomUUID())).toMatchObject({ ok: false, field: 'extra' })
    expect((await endPreferredFromScreen(as('proc_officer'), { preferredSupplierId: row.id, reason: 'ไม่ใช้แล้ว' }, randomUUID())).ok).toBe(true)
  })
})
