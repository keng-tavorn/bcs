import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { businessMinutesBetween } from '@/core/sla'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { forTenant } from '@/server/db/tenant'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { P1_SEED_MODULES, seedP1Modules } from '@/server/seed/p1-modules'
import { parseSites, parseSuppliers } from '@/server/seed/sheets'
import { seedSupplierPortalHistory } from '@/server/services/demo-seed/supplier-portal'
import { parseSupplierPortal, seedSupplierPortalBase, type SupplierPortalSheets } from '@/server/seed/supplier-portal'
import { seedSuppliers } from '@/server/seed/suppliers'
import { INPUT_WORKBOOKS, loadInputWorkbook } from '@/server/seed/workbook'
import { supplierSettingsOf } from '@/lib/org-settings'

// S7-13 (docs/sub-specs/S7.md "การอ่านชีตของไฟล์ระยะ 1"): the phase-1 workbook seeds the supplier portal — SUPPLIER on
// after the DOA with SA-01, the six document types, a contact who may sign in for every supplier, the documents on file
// as the sheet says (12 suppliers reminded within 30 days, 5 expired), and nine applications played with the real
// commands back in time, the three approved ones by dm_proc exactly 2.1, 8.8 and 3.6 business days after their
// invitation (G-7 · BR-SUP ข้อ 13); the settings of sheet Settings; a second seed adds nothing. The same functions as
// pnpm db:reset:p1, under another organization code and e-mail addresses.

const NOW = new Date('2026-11-09T03:00:00Z')
const TIMEOUT = 600_000

let organizationId: string
let sheets: SupplierPortalSheets

beforeAll(async () => {
  execSync('pnpm exec tsx scripts/storage-init.ts', { stdio: 'ignore' })
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const code = `SP${randomUUID().slice(0, 6).toUpperCase()}`
  const renamed = { ...input, org: { ...input.org, code }, users: input.users.map((u) => ({ ...u, email: `${code.toLowerCase()}.${u.email}` })) }
  organizationId = (await seedDemoOrganization(renamed, { password: 'seed-p1-supplier-portal-01', now: NOW })).organizationId
  await seedOrgStructure(organizationId, renamed.users, parseOrgStructureInput(workbook), NOW)
  await seedP1Modules(organizationId, NOW)
  await seedSuppliers(organizationId, { suppliers: parseSuppliers(workbook), sites: parseSites(workbook) }, NOW)
  sheets = parseSupplierPortal(workbook)!
  await seedSupplierPortalBase(organizationId, sheets, NOW)
  await seedSupplierPortalHistory(organizationId, sheets, NOW)
}, TIMEOUT)

describe('[FR-SUP-101/AC1] S7-13 the phase-1 seed of the supplier portal', () => {
  it('SUPPLIER is on with the other modules of phase 1, its settings from sheet Settings', async () => {
    const db = forTenant(organizationId)
    expect(P1_SEED_MODULES).toContain('SUPPLIER')
    expect((await db.orgModule.findMany({ where: { enabled: true }, select: { module: true } })).map((m) => m.module).sort()).toEqual(expect.arrayContaining(['PAY', 'SUPPLIER']))
    const settings = supplierSettingsOf((await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })).settings)
    expect(settings).toMatchObject({ otpChannel: 'EMAIL', otpMinutes: 10, applicationReminderBusinessDays: 3, applicationEscalateBusinessDays: 10, portalInvoice: true, selfRegistration: false })
  })

  it('the six document types, a primary contact of every supplier who may sign in, the documents on file by the sheet', async () => {
    const db = forTenant(organizationId)
    expect((await db.supplierDocumentType.findMany({ select: { code: true }, orderBy: { sortOrder: 'asc' } })).map((t) => t.code)).toEqual(['COMPANY_CERT', 'VAT_CERT', 'BANK_BOOK', 'ID_CARD', 'INCORPORATION_FOREIGN', 'ISO_CERT'])
    expect(await db.supplierDocumentType.findFirst({ where: { code: 'ISO_CERT' }, select: { linkedRiskQuestionCodes: true, singleInstance: true } })).toEqual({ linkedRiskQuestionCodes: ['RQ-IS-01', 'RQ-PRM-02'], singleInstance: false })
    const suppliers = await db.supplier.count()
    expect(await db.supplierContact.count({ where: { supplierId: { not: null }, isPrimary: true } })).toBeGreaterThanOrEqual(suppliers)
    expect(await db.supplier.count({ where: { portalEnabled: false } })).toBe(0)
    expect(await db.supplierDocument.count({ where: { supplierId: { not: null }, applicationId: null } })).toBe(sheets.documents.length)
    expect(await db.supplierDocument.count({ where: { supplierId: { not: null }, file: { scanStatus: { not: 'CLEAN' } } } })).toBe(0)
    // the counts the demo names: within 30 days of expiry and expired, by supplier (scene 4)
    const today = new Date(NOW.getTime() + 7 * 3_600_000).toISOString().slice(0, 10)
    const in30 = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000)
    const expiring = await db.supplierDocument.findMany({ where: { supplierId: { not: null }, status: { in: ['VERIFIED', 'PENDING'] }, expiresOn: { gte: new Date(`${today}T00:00:00Z`), lte: in30 } }, select: { supplierId: true }, distinct: ['supplierId'] })
    expect(expiring).toHaveLength(12)
    expect(await db.supplierDocument.findMany({ where: { status: 'EXPIRED' }, select: { supplierId: true }, distinct: ['supplierId'] })).toHaveLength(5)
    const iso = await db.supplierDocument.findFirstOrThrow({ where: { supplier: { code: 'SP0141' }, scope: 'ISO 27001' }, select: { status: true, issuedOn: true, expiresOn: true } })
    expect(iso).toEqual({ status: 'VERIFIED', issuedOn: new Date('2024-04-01'), expiresOn: new Date('2027-03-31') })
    expect(await db.supplierDocument.count({ where: { status: 'SUPERSEDED', supersededById: null } })).toBe(0)
  })

  it('[FR-SUP-104/AC1] nine applications in the states of the sheet; the approved ones by dm_proc after 2.1 8.8 3.6 business days', async () => {
    const db = forTenant(organizationId)
    const apps = await db.supplierApplication.findMany({ select: { taxId: true, status: true, invitedAt: true, decidedAt: true, number: true, supplierId: true, escalatedAt: true, filledOnBehalfById: true } })
    const byTax = new Map(apps.map((a) => [a.taxId, a]))
    for (const row of sheets.applications) expect(byTax.get(row.taxId)?.status, row.ref).toBe(row.status)
    const calendar = await db.$transaction((tx) => loadBusinessCalendar(tx, organizationId))
    const g7 = sheets.applications
      .filter((r) => r.status === 'APPROVED')
      .map((r) => {
        const a = byTax.get(r.taxId)!
        expect(a.supplierId, r.ref).not.toBeNull()
        return Math.round((businessMinutesBetween(a.invitedAt, a.decidedAt!, calendar) / 540) * 10) / 10
      })
    expect(g7).toEqual(sheets.applications.filter((r) => r.status === 'APPROVED').map((r) => r.expectedG7Days))
    expect([...g7].sort((a, b) => a - b)[1]).toBe(3.6)
    // the one procurement filled in for its supplier, and the one waiting past its escalation (scene 2)
    expect(apps.filter((a) => a.filledOnBehalfById !== null && a.status === 'APPROVED')).toHaveLength(1)
    const stuck = byTax.get(sheets.applications.find((r) => r.ref === 'SA-06')!.taxId)!
    expect(stuck).toMatchObject({ status: 'DRAFT', escalatedAt: expect.any(Date) })
    expect(await db.event.count({ where: { type: 'supplier_application.approved' } })).toBe(3)
  })

  it('a second seed adds nothing', async () => {
    const db = forTenant(organizationId)
    const before = [await db.supplierContact.count(), await db.supplierDocument.count(), await db.supplierApplication.count()]
    expect(await seedSupplierPortalBase(organizationId, sheets, NOW)).toEqual({ types: 0, contacts: 0 })
    expect(await seedSupplierPortalHistory(organizationId, sheets, NOW)).toMatchObject({ seeded: false })
    expect([await db.supplierContact.count(), await db.supplierDocument.count(), await db.supplierApplication.count()]).toEqual(before)
  })
}, TIMEOUT)
