import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { inviteSupplier } from '@/server/services/suppliers/applications'
import { canSeeApplicationList, getSupplierApplicationForScreen, listInvitableSuppliers, listSupplierApplicationsForScreen } from '@/server/services/suppliers/applications-view'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S7-09 (docs/sub-specs/S7.md "/suppliers/applications" · FR-SUP-101 AC5 AC6): what the workspace shows of applications —
// the list for the ORG readers of supplier.application.view with the overdue mark (BR-SUP ข้อ 12), a sole proprietor named
// by number in the list (BR-NOTI ข้อ 10), the page for them and the approver of its task, never for anyone else; the
// account number never, its last four only (BR-SUP ข้อ 07); the suppliers offered for an invitation to PROCUREMENT only.

const NOW = new Date('2026-11-08T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
let org: DoaOrg

function taxId(first = 0): string {
  const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? first : Math.floor(Math.random() * 10)))
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0)
  return digits.join('') + String((11 - (sum % 11)) % 10)
}

async function invited(payeeType: 'JURISTIC' | 'INDIVIDUAL' = 'JURISTIC') {
  const r = await inviteSupplier(org.ctxOf('proc_officer', NOW), { kind: 'NEW', nameTh: payeeType === 'INDIVIDUAL' ? 'นายสมชาย ใจดี' : `บริษัท มุมมอง ${randomUUID().slice(0, 6)} จำกัด`, taxId: taxId(payeeType === 'INDIVIDUAL' ? 3 : 0), payeeType, contact: { nameTh: 'ผู้ติดต่อ', email: `av-${randomUUID().slice(0, 8)}@supplier.test` } }, key())
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data.applicationId
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: NOW } })
})

describe('[FR-SUP-101/AC5] the applications on the workspace', () => {
  it('the list: PROCUREMENT sees every application with its state and the overdue mark; a sole proprietor by number only', async () => {
    const juristic = await invited()
    const individual = await invited('INDIVIDUAL')
    await prisma.supplierApplication.update({ where: { id: juristic }, data: { escalatedAt: NOW } })
    const r = await listSupplierApplicationsForScreen(org.ctxOf('proc_officer', NOW))
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect(r.data.canInvite).toBe(true)
    expect(r.data.rows.find((x) => x.id === juristic)).toMatchObject({ status: 'INVITED', overdue: true })
    expect(r.data.rows.find((x) => x.id === individual)?.label).not.toContain('สมชาย')
    expect(r.data.overdue).toBeGreaterThanOrEqual(1)
    const only = await listSupplierApplicationsForScreen(org.ctxOf('proc_officer', NOW), { overdue: true })
    expect(only.ok && only.data.rows.every((x) => x.overdue)).toBe(true)
    expect(await canSeeApplicationList(org.ctxOf('proc_officer', NOW))).toBe(true)
  })

  it('FINANCE reads the list but may not invite; a member with no role is FORBIDDEN and has no tab', async () => {
    const r = await listSupplierApplicationsForScreen(org.ctxOf('fin_officer', NOW))
    expect(r).toMatchObject({ ok: true, data: { canInvite: false } })
    expect(await listSupplierApplicationsForScreen(org.ctxOf('req_con', NOW))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await canSeeApplicationList(org.ctxOf('req_con', NOW))).toBe(false)
    expect(await listInvitableSuppliers(org.ctxOf('fin_officer', NOW))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await listInvitableSuppliers(org.ctxOf('proc_officer', NOW))).toMatchObject({ ok: true })
  })
})

describe('[FR-SUP-101/AC6] one application', () => {
  it('PROCUREMENT sees the fields with their source, the last four of the account, the timeline and what it may do; others are FORBIDDEN', async () => {
    const id = await invited()
    await prisma.supplierApplication.update({ where: { id }, data: { bankCode: '004', accountNoEnc: 'sealed-value', accountNoLast4: '7890' } })
    const r = await getSupplierApplicationForScreen(org.ctxOf('proc_officer', NOW), id)
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect(r.data).toMatchObject({ status: 'INVITED', fields: { accountNoLast4: '7890' }, can: { fillOnBehalf: true, route: true, invite: true } })
    expect(r.data.missing).toContain('address')
    expect(r.data.timeline.map((e) => e.type)).toContain('supplier_application.invited')
    expect(JSON.stringify(r.data)).not.toContain('sealed-value')
    expect(await getSupplierApplicationForScreen(org.ctxOf('req_con', NOW), id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getSupplierApplicationForScreen(org.ctxOf('proc_officer', NOW), randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('the module off: MODULE_DISABLED', async () => {
    const off = await createP2Org({ modules: ['PAY'] })
    expect(await listSupplierApplicationsForScreen(off.ctxOf('proc_officer', NOW))).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})
