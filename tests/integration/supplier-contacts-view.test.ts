import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { getSupplierPortalForScreen, listSupplierContactsForScreen, listSupplierPoAcknowledgementsForScreen } from '@/server/services/suppliers/contacts-view'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S7-09 (FR-SUP-101 AC6 · docs/sub-specs/S7.md "หน้าจอ" /suppliers/[id]): the reads behind the contacts, PO
// acknowledgement and portal tabs. Module SUPPLIER and supplier.view in full are needed (§2.4: PROCUREMENT FINANCE
// AUDITOR — contacts are not a basic detail); a contact's e-mail and phone leave the server for supplier.contact.manage
// (PROCUREMENT) only; the POs need po.view over the organization.

const NOW = new Date('2026-11-08T03:00:00Z')
const hex = () => randomUUID().replace(/-/g, '').padEnd(64, '0')

let org: DoaOrg
let supplierId: string
let primaryId: string
let otherId: string
const as = (code: string) => org.ctxOf(code, NOW)

beforeAll(async () => {
  org = await createP2Org()
  const organizationId = org.organizationId
  const grantedAt = new Date('2026-01-01T00:00:00Z')
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt },
      { organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt },
    ],
  })
  supplierId = (await prisma.supplier.create({ data: { organizationId, code: 'SCV-01', nameTh: 'บริษัท มุมมองผู้ติดต่อ จำกัด', taxId: null, isForeign: true, portalEnabled: true } })).id
  otherId = (
    await prisma.supplierContact.create({
      data: { organizationId, supplierId, nameTh: 'ผู้ติดต่อรอง', email: `second-${randomUUID().slice(0, 6)}@supplier.test`, phone: '021234567', roleLabel: 'ฝ่ายบัญชี', isPrimary: false, firstSignedInAt: new Date('2026-11-01T03:00:00Z') },
    })
  ).id
  primaryId = (await prisma.supplierContact.create({ data: { organizationId, supplierId, nameTh: 'ผู้ติดต่อหลัก', email: `primary-${randomUUID().slice(0, 6)}@supplier.test`, phone: '029999999', isPrimary: true } })).id
  await prisma.supplierContact.create({ data: { organizationId, supplierId, nameTh: 'ผู้ติดต่อที่ปิดแล้ว', email: `closed-${randomUUID().slice(0, 6)}@supplier.test`, status: 'DEACTIVATED', deactivatedAt: new Date('2026-11-02T03:00:00Z') } })
  const session = (lastSeenAt: Date, extra: { revokedAt?: Date; expiresAt?: Date } = {}) => ({
    organizationId,
    contactId: otherId,
    sessionHash: hex(),
    csrfTokenHash: hex(),
    lastSeenAt,
    expiresAt: extra.expiresAt ?? new Date('2099-01-01T00:00:00Z'),
    revokedAt: extra.revokedAt ?? null,
    revokedReason: extra.revokedAt ? ('LOGOUT' as const) : null,
    userAgentHash: hex(),
    ipHash: hex(),
  })
  // one live session, one revoked later in the day, one past its end: the last use is the latest of all three
  await prisma.portalSession.createMany({
    data: [
      session(new Date('2026-11-07T02:00:00Z')),
      session(new Date('2026-11-07T05:00:00Z'), { revokedAt: new Date('2026-11-07T06:00:00Z') }),
      session(new Date('2026-11-03T02:00:00Z'), { expiresAt: new Date('2026-11-04T00:00:00Z') }),
    ],
  })
})

const data = <T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

describe('[FR-SUP-101/AC6] the contacts tab: who reads it, and who sees how to reach a contact', () => {
  it('PROCUREMENT (supplier.contact.manage) sees every contact with e-mail and phone: the primary first, the closed one last, sign-ins counted as of now', async () => {
    const v = data(await listSupplierContactsForScreen(as('proc_officer'), supplierId))
    expect(v).toMatchObject({ canManage: true, seesAddresses: true })
    expect(v.rows.map((r) => r.nameTh)).toEqual(['ผู้ติดต่อหลัก', 'ผู้ติดต่อรอง', 'ผู้ติดต่อที่ปิดแล้ว'])
    expect(v.rows[0]).toMatchObject({ id: primaryId, isPrimary: true, email: expect.stringMatching(/^primary-.+@supplier\.test$/), phone: '029999999', lastSeenAt: null, liveSessions: 0 })
    expect(v.rows[1]).toMatchObject({ id: otherId, roleLabel: 'ฝ่ายบัญชี', phone: '021234567', firstSignedInAt: '2026-11-01T03:00:00.000Z', lastSeenAt: '2026-11-07T05:00:00.000Z', liveSessions: 1 })
    expect(v.rows[2]).toMatchObject({ status: 'DEACTIVATED', deactivatedAt: '2026-11-02T03:00:00.000Z' })
  })

  it('FINANCE and AUDITOR (supplier.view in full, no supplier.contact.manage) see the contacts but no e-mail or phone', async () => {
    for (const code of ['fin_officer', 'auditor']) {
      const v = data(await listSupplierContactsForScreen(as(code), supplierId))
      expect(v).toMatchObject({ canManage: false, seesAddresses: false })
      expect(v.rows).toHaveLength(3)
      expect(v.rows.every((r) => r.email === null && r.phone === null)).toBe(true)
      expect(JSON.stringify(v)).not.toContain('@supplier.test')
    }
  })

  it('a member who sees the register only in part is FORBIDDEN; a member without supplier.view at all is FORBIDDEN', async () => {
    expect(await listSupplierContactsForScreen(as('req_con'), supplierId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'BASIC_FIELDS_ONLY' } } })
    const gone = (await prisma.member.create({ data: { organizationId: org.organizationId, displayNameTh: 'ผู้ใช้ที่ออกแล้ว', email: `gone-${randomUUID()}@test.bcs.local`, status: 'DEACTIVATED', primaryDepartmentId: org.department.CON! } })).id
    const ctx = { ...as('req_con'), actor: { type: 'USER' as const, memberId: gone } }
    expect(await listSupplierContactsForScreen(ctx, supplierId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { capability: 'supplier.view' } } })
    expect(await getSupplierPortalForScreen(ctx, supplierId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await listSupplierPoAcknowledgementsForScreen(ctx, supplierId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('an unknown supplier is NOT_FOUND; with module SUPPLIER off every read is MODULE_DISABLED (the tabs are not shown)', async () => {
    expect(await listSupplierContactsForScreen(as('proc_officer'), randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await listSupplierContactsForScreen(as('proc_officer'), 'not-a-uuid')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    const off = await createP2Org({ modules: ['PAY'] })
    const s = await prisma.supplier.create({ data: { organizationId: off.organizationId, code: 'SCV-OFF', nameTh: 'ปิด', taxId: null, isForeign: true } })
    const proc = off.ctxOf('proc_officer', NOW)
    expect(await listSupplierContactsForScreen(proc, s.id)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await listSupplierPoAcknowledgementsForScreen(proc, s.id)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await getSupplierPortalForScreen(proc, s.id)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})

describe('[FR-SUP-101/AC6] the PO acknowledgement and portal tabs', () => {
  it('no PO sent yet: an empty list for a reader of every PO; a reader who sees the register in part is FORBIDDEN', async () => {
    expect(data(await listSupplierPoAcknowledgementsForScreen(as('proc_officer'), supplierId))).toMatchObject({ rows: [], total: 0 })
    expect(await listSupplierPoAcknowledgementsForScreen(as('req_con'), supplierId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('the portal: the supplier may use it, the sign-in address names the organization in lower case, the active contacts only', async () => {
    const orgCode = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId }, select: { code: true } })).code
    const v = data(await getSupplierPortalForScreen(as('proc_officer'), supplierId))
    expect(v).toMatchObject({ portalEnabled: true, supplierStatus: 'ACTIVE', canManage: true })
    expect(v.loginUrl.endsWith(`/portal/${orgCode.toLowerCase()}/login`)).toBe(true)
    expect(v.contacts.map((c) => c.id)).toEqual([primaryId, otherId])
    const fin = data(await getSupplierPortalForScreen(as('fin_officer'), supplierId))
    expect(fin.canManage).toBe(false)
    expect(fin.contacts.every((c) => c.email === null)).toBe(true)
  })
})
