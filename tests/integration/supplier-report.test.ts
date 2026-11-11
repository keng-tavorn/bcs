import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { runReport, supplierReport } from '@/server/services/reports'
import { reportCatalog } from '@/server/services/reports/screens'
import { inviteSupplier } from '@/server/services/suppliers/applications'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S7-16 (BR-SUP ข้อ 13 · §11.4 G-7 · GC-SUP-30 to 33): /reports/suppliers counts the new applications approved in the
// period by their decision, each in business days from its invitation on the organization's calendar (the golden's:
// Monday to Friday 08:30–17:30, 13 and 23 October off), the lower median of all of them, of the ones the supplier
// filled in and of the ones procurement filled in for it; an existing supplier's invitation, a rejected one and one
// decided outside the period are not counted. A head reads the applications the members of their departments invited;
// a member without report.view is refused; an organization without SUPPLIER has no such report. The Excel file has the
// same rows (SUP_G7).

const NOW = new Date('2026-11-02T03:00:00Z')
const PERIOD = { from: '2026-10-01', to: '2026-10-31' }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
let org: DoaOrg
const ids: Record<string, string> = {}

function taxId(): string {
  const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? 0 : Math.floor(Math.random() * 10)))
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0)
  return digits.join('') + String((11 - (sum % 11)) % 10)
}

/** An application invited by procurement, then set to how the approval left it (its route is not this test's) */
async function application(name: string, invitedAt: string, then: { status: 'APPROVED' | 'REJECTED' | 'DRAFT'; decidedAt?: string; onBehalf?: boolean; escalatedAt?: string }) {
  const r = await inviteSupplier(org.ctxOf('proc_officer', new Date(invitedAt)), { kind: 'NEW', nameTh: `บริษัท ${name} ${randomUUID().slice(0, 6)} จำกัด`, taxId: taxId(), branchCode: '00000', payeeType: 'JURISTIC', contact: { nameTh: 'ผู้ติดต่อ', email: `g7-${randomUUID().slice(0, 8)}@supplier.test` } }, key())
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  await prisma.supplierApplication.update({
    where: { id: r.data.applicationId },
    data: {
      status: then.status,
      invitedAt: new Date(invitedAt),
      ...(then.decidedAt ? { decidedAt: new Date(then.decidedAt) } : {}),
      ...(then.onBehalf ? { filledOnBehalfById: org.member.proc_officer } : {}),
      ...(then.escalatedAt ? { escalatedAt: new Date(then.escalatedAt) } : {}),
    },
  })
  return r.data.applicationId
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await prisma.holiday.createMany({ data: ['2026-10-13', '2026-10-23'].map((d) => ({ organizationId: org.organizationId, date: new Date(`${d}T00:00:00Z`), nameTh: 'วันหยุดทดสอบ' })), skipDuplicates: true })
  // GC-SUP-30's first three: 2.1 (self) · 8.8 (on behalf) · 3.6 (self)
  ids.a = await application('จีเจ็ดหนึ่ง', '2026-10-05T02:00:00Z', { status: 'APPROVED', decidedAt: '2026-10-07T03:00:00Z' })
  ids.b = await application('จีเจ็ดสอง', '2026-10-05T02:00:00Z', { status: 'APPROVED', decidedAt: '2026-10-16T09:00:00Z', onBehalf: true })
  ids.c = await application('จีเจ็ดสาม', '2026-10-09T03:00:00Z', { status: 'APPROVED', decidedAt: '2026-10-15T08:30:00Z' })
  // not counted: rejected, decided before the period
  await application('ไม่อนุมัติ', '2026-10-05T02:00:00Z', { status: 'REJECTED', decidedAt: '2026-10-08T03:00:00Z' })
  await application('ก่อนช่วง', '2026-09-21T02:00:00Z', { status: 'APPROVED', decidedAt: '2026-09-30T03:00:00Z' })
  // waiting past its escalation now
  ids.late = await application('ค้าง', '2026-10-01T02:00:00Z', { status: 'DRAFT', escalatedAt: '2026-10-15T02:00:00Z' })
})

describe('[BR-SUP-13] G-7 on /reports/suppliers (S7-16)', () => {
  it('[GC-SUP-30] [GC-SUP-32] the three approved in October: 2.1 · 8.8 · 3.6 business days, median 3.6; self 2.1 (lower of two); on behalf 8.8', async () => {
    const r = await supplierReport(org.ctxOf('proc_officer', NOW), PERIOD)
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect(r.data.scope).toBe('ORG')
    expect(r.data.approved.map((a) => [a.applicationId, a.businessDays, a.filledOnBehalf])).toEqual([
      [ids.a, '2.1', false],
      [ids.c, '3.6', false],
      [ids.b, '8.8', true],
    ])
    expect(r.data.median).toEqual({ all: '3.6', self: '2.1', onBehalf: '8.8' })
    expect(r.data.overdue.map((o) => o.applicationId)).toContain(ids.late)
  })

  it('[GC-SUP-33] a period with no approval: no median, no row', async () => {
    const r = await supplierReport(org.ctxOf('proc_officer', NOW), { from: '2026-08-01', to: '2026-08-31' })
    expect(r).toMatchObject({ ok: true, data: { median: { all: null, self: null, onBehalf: null }, approved: [] } })
  })

  it('[FR-VIS-002/AC3] a head reads only what members of their departments invited; a member without report.view is refused', async () => {
    const head = await supplierReport(org.ctxOf('dm_con', NOW), PERIOD)
    expect(head).toMatchObject({ ok: true, data: { scope: 'DEPT', approved: [], overdue: [] } })
    expect(await supplierReport(org.ctxOf('req_con', NOW), PERIOD)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await supplierReport(org.ctxOf('proc_officer', NOW), { from: '2026-10-31', to: 'x' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('[FR-VIS-002/AC1] the Excel report SUP_G7 has the same rows; it is offered only where SUPPLIER is on', async () => {
    const file = await runReport(org.ctxOf('proc_officer', NOW), 'SUP_G7', PERIOD)
    if (!file.ok) throw new Error(JSON.stringify(file.error))
    expect(file.data.rows.map((x) => [x.businessDays, x.filledByCode])).toEqual([
      ['2.1', 'SELF'],
      ['3.6', 'SELF'],
      ['8.8', 'ON_BEHALF'],
    ])
    const catalog = await reportCatalog(org.ctxOf('proc_officer', NOW))
    expect(catalog.ok && catalog.data.reports.map((r) => r.code)).toContain('SUP_G7')

    const off = await createP2Org({ modules: ['PAY'] })
    await prisma.roleAssignment.create({ data: { organizationId: off.organizationId, memberId: off.member.proc_officer!, role: 'PROCUREMENT', grantedAt: NOW } }).catch(() => undefined)
    expect(await supplierReport(off.ctxOf('proc_officer', NOW), PERIOD)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    const offCatalog = await reportCatalog(off.ctxOf('proc_officer', NOW))
    expect(offCatalog.ok && offCatalog.data.reports.map((r) => r.code)).not.toContain('SUP_G7')
    expect(await runReport(off.ctxOf('proc_officer', NOW), 'SUP_G7', PERIOD)).toMatchObject({ ok: true, data: { rows: [] } })
  })
})
