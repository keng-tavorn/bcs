import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { seedWorkflow } from '@/server/seed/workflow'
import { configPackageChecksum, exportConfigPackage, importConfigPackage, readConfigPackage } from '@/server/services/config-packages'
import { createSandbox } from '@/server/services/platform/sandbox'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { createDraft } from '../support/requests'

// S6-21 (FR-PLT-101 · BR-UAT-01 to BR-UAT-04 · ADR-110 · OQ-108): UAT sandboxes and configuration packages against
// Postgres. The BCS team makes an empty sandbox of a production organization under its contract — no structure, member
// or DOA comes with it, and the command has nothing to ask for one; an ORG_ADMIN cannot make one. A package exported
// from the sandbox (forms, workflow, DOA, catalogue) imports into production as drafts only — nothing is published,
// the catalogue comes in inactive — and a package edited after export, of another schema version, or naming a position
// production does not have is refused with nothing created. PLATFORM_ADMIN neither imports nor exports. INV-TEN-01: the
// sandbox reaches none of production's rows.

const NOW = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let production: DoaOrg
let sandbox: DoaOrg
let platform: (organizationId: string) => ReturnType<typeof makeCtx>

/** What production has published or active, to compare before and after an import */
async function published(organizationId: string) {
  const db = forTenant(organizationId)
  return {
    workflows: await db.workflowVersion.count({ where: { status: 'PUBLISHED' } }),
    doa: await db.doaVersion.count({ where: { status: 'PUBLISHED' } }),
    forms: await db.formVersion.count({ where: { status: 'PUBLISHED' } }),
    activeItems: await db.catalogItem.count({ where: { active: true } }),
  }
}

beforeAll(async () => {
  production = await createDoaOrg()
  sandbox = await createDoaOrg()
  await prisma.organization.update({ where: { id: sandbox.organizationId }, data: { kind: 'SANDBOX', sandboxOfOrganizationId: production.organizationId } })
  for (const o of [production, sandbox]) await prisma.roleAssignment.create({ data: { organizationId: o.organizationId, memberId: o.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  // What the customer tried on the sandbox: a workflow and a catalogue item
  await seedWorkflow(
    sandbox.organizationId,
    {
      code: 'WF-UAT',
      rules: [{ code: 'RV-01', requestTypeCodes: ['BUY_GOODS'], when: {}, reviewers: [{ kind: 'POSITION_AT', position: 'DM', department: 'CON' }], fallback: null, mode: 'ALL', quorumCount: null, slaBusinessMinutes: 480, sortOrder: 1, descriptionTh: 'ฝ่ายก่อสร้างตรวจทุกคำขอซื้อ' }],
    },
    NOW,
  )
  await prisma.catalogItem.create({ data: { organizationId: sandbox.organizationId, code: `UAT-${randomUUID().slice(0, 6)}`, nameTh: 'หมวกนิรภัย', uom: 'ใบ', categoryCode: 'SAFETY', refUnitPriceSatang: 25_000n } })
  const admin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
  platform = (organizationId) => makeCtx({ organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: admin.id }, channel: 'WEB', now: NOW })
})

describe('[FR-PLT-101/AC2] a configuration package from the sandbox imports into production as drafts only', () => {
  it('exports with a checksum, and imports drafts: nothing published, the catalogue inactive', async () => {
    const exported = ok(await exportConfigPackage(sandbox.ctxOf('admin', NOW), { sections: ['FORMS', 'WORKFLOW', 'DOA', 'CATALOG'] }, key()))
    const read = readConfigPackage(exported.file)
    expect(read).toMatchObject({ ok: true, checksum: exported.checksum })
    const content = read.ok ? read.content : null
    expect(content?.workflows?.map((w) => w.code)).toEqual(['WF-UAT'])
    // No request, budget or person comes with it
    expect(exported.file).not.toMatch(/budget|requestId|@demo\.bcs\.local/i)

    const before = await published(production.organizationId)
    const imported = ok(await importConfigPackage(production.ctxOf('admin', NOW), { file: exported.file, effectiveDate: '2026-10-20', changeReason: 'นำเข้าจากระบบทดลองหลังทดสอบแล้ว' }, key()))
    expect(await published(production.organizationId)).toEqual(before)
    const db = forTenant(production.organizationId)
    expect(await db.workflowVersion.findMany({ where: { id: { in: imported.created.workflows! } }, select: { code: true, status: true } })).toEqual([{ code: 'WF-UAT', status: 'DRAFT' }])
    expect(await db.doaVersion.findMany({ where: { id: { in: imported.created.doa! } }, select: { status: true } })).toEqual([{ status: 'DRAFT' }])
    expect((await db.formVersion.findMany({ where: { id: { in: imported.created.forms! } }, select: { status: true } })).every((f) => f.status === 'DRAFT')).toBe(true)
    expect(await db.catalogItem.findMany({ where: { id: { in: imported.created.catalog! } }, select: { active: true } })).toEqual([{ active: false }])
    expect(await db.configPackage.count({ where: { direction: 'IMPORT' } })).toBe(1)
  })

  it('a package changed after export, or of another schema version, is CONFIG_PACKAGE_INVALID', async () => {
    const exported = ok(await exportConfigPackage(sandbox.ctxOf('admin', NOW), { sections: ['WORKFLOW'] }, key()))
    const edited = exported.file.replace('ฝ่ายก่อสร้างตรวจทุกคำขอซื้อ', 'ฝ่ายก่อสร้างตรวจ')
    const input = (file: string) => ({ file, effectiveDate: '2026-10-20', changeReason: 'นำเข้าจากระบบทดลอง' })
    expect(await importConfigPackage(production.ctxOf('admin', NOW), input(edited), key())).toMatchObject({ ok: false, error: { code: 'CONFIG_PACKAGE_INVALID', details: { reason: 'CHECKSUM' } } })
    const parsed = JSON.parse(exported.file) as Record<string, unknown>
    const { checksum: _checksum, ...content } = parsed
    const v2 = { ...content, schemaVersion: 2 }
    const otherVersion = JSON.stringify({ ...v2, checksum: configPackageChecksum(v2 as never) })
    expect(await importConfigPackage(production.ctxOf('admin', NOW), input(otherVersion), key())).toMatchObject({ ok: false, error: { code: 'CONFIG_PACKAGE_INVALID', details: { reason: 'SCHEMA_VERSION' } } })
    expect(await importConfigPackage(production.ctxOf('admin', NOW), input('not json'), key())).toMatchObject({ ok: false, error: { code: 'CONFIG_PACKAGE_INVALID', details: { reason: 'NOT_JSON' } } })
  })

  it('a position production does not have: its row is reported and nothing is created', async () => {
    const exported = ok(await exportConfigPackage(sandbox.ctxOf('admin', NOW), { sections: ['WORKFLOW', 'CATALOG'] }, key()))
    const read = readConfigPackage(exported.file)
    if (!read.ok) throw new Error(read.reason)
    const content = { ...read.content, workflows: read.content.workflows!.map((w) => ({ ...w, code: 'WF-OTHER', rules: w.rules.map((r) => ({ ...r, reviewers: [{ kind: 'POSITION_AT' as const, position: 'DM', department: 'LAB' }] })) })) }
    const file = JSON.stringify({ ...content, checksum: configPackageChecksum(content) })
    const db = forTenant(production.organizationId)
    const versions = await db.workflowVersion.count()
    const result = await importConfigPackage(production.ctxOf('admin', NOW), { file, effectiveDate: '2026-10-20', changeReason: 'นำเข้าจากระบบทดลอง' }, key())
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'CONFIG_PACKAGE_ROWS', rows: expect.arrayContaining([{ section: 'WORKFLOW', ref: 'WF-OTHER/RV-01/DM@LAB', reason: 'POSITION_NOT_FOUND' }, expect.objectContaining({ section: 'CATALOG', reason: 'CATALOG_CODE_EXISTS' })]) } } })
    expect(await db.workflowVersion.count()).toBe(versions)
  })

  it('agreed prices are checked as priceAgreement.create checks them: above zero, not over, no overlap (S6-22 review)', async () => {
    const exported = ok(await exportConfigPackage(sandbox.ctxOf('admin', NOW), { sections: ['CATALOG'] }, key()))
    const read = readConfigPackage(exported.file)
    if (!read.ok) throw new Error(read.reason)
    const supplier = await prisma.supplier.create({ data: { organizationId: production.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'ผู้ขายราคาตกลง', taxId: '0999999000012' }, select: { code: true } })
    const agreement = (unitPrice: string, validFrom: string, validTo: string) => ({ supplierCode: supplier.code, unitPrice, validFrom, validTo })
    const catalog = read.content.catalog!.map((i) => ({
      ...i,
      code: `NEW-${randomUUID().slice(0, 6)}`,
      agreements: [agreement('100.00', '2026-11-01', '2027-01-01'), agreement('90.00', '2026-12-01', '2027-02-01'), agreement('0.00', '2027-03-01', '2027-04-01'), agreement('80.00', '2026-01-01', '2026-10-01')],
    }))
    const content = { ...read.content, catalog }
    const file = JSON.stringify({ ...content, checksum: configPackageChecksum(content) })
    const db = forTenant(production.organizationId)
    const agreements = await db.priceAgreement.count()
    const result = await importConfigPackage(production.ctxOf('admin', NOW), { file, effectiveDate: '2026-10-20', changeReason: 'นำเข้าจากระบบทดลอง' }, key())
    const ref = (from: string) => `${catalog[0]!.code}/${supplier.code}@${from}`
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'CONFIG_PACKAGE_ROWS' } } })
    const rows = result.ok ? [] : ((result.error as { details: { rows: Array<{ ref: string; reason: string }> } }).details.rows)
    expect(rows.filter((r) => r.reason === 'AGREEMENT_INVALID').map((r) => r.ref)).toEqual([ref('2026-12-01'), ref('2027-03-01'), ref('2026-01-01')])
    expect(await db.priceAgreement.count()).toBe(agreements)
  })

  it('PLATFORM_ADMIN neither exports nor imports (NG-12); a requester neither', async () => {
    const exported = ok(await exportConfigPackage(sandbox.ctxOf('admin', NOW), { sections: ['WORKFLOW'] }, key()))
    const input = { file: exported.file, effectiveDate: '2026-10-20', changeReason: 'นำเข้าจากระบบทดลอง' }
    expect(await importConfigPackage(platform(production.organizationId), input, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await exportConfigPackage(platform(sandbox.organizationId), { sections: ['WORKFLOW'] }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await importConfigPackage(production.ctxOf('req_con', NOW), input, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-PLT-101/AC1] the sandbox of a customer', () => {
  it('the BCS team makes it empty under the contract; it copies nothing and cannot be asked to; an ORG_ADMIN cannot make one', async () => {
    const code = `UAT-${randomUUID().slice(0, 6).toUpperCase()}`
    const made = ok(await createSandbox(platform(production.organizationId), { code, contractRef: 'CT-2026-001', reason: 'ลูกค้าขอระบบทดลองตามสัญญา' }, key()))
    const row = await prisma.organization.findUniqueOrThrow({ where: { id: made.sandboxOrganizationId } })
    expect(row).toMatchObject({ code, kind: 'SANDBOX', sandboxOfOrganizationId: production.organizationId })
    const db = forTenant(made.sandboxOrganizationId)
    expect({ departments: await db.department.count(), positions: await db.position.count(), members: await db.member.count(), doa: await db.doaVersion.count(), workflows: await db.workflowVersion.count(), modules: await db.orgModule.count({ where: { enabled: true } }) }).toEqual({
      departments: 0,
      positions: 0,
      members: 0,
      doa: 0,
      workflows: 0,
      modules: 1,
    })
    expect(await createSandbox(platform(production.organizationId), { code: `${code}2`, contractRef: 'CT-2026-001', reason: 'ขอคัดลอกผัง', copyStructure: true } as never, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await createSandbox(production.ctxOf('admin', NOW), { code: `${code}3`, contractRef: 'CT-2026-001', reason: 'ผู้ดูแลลองสร้างเอง' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // A sandbox has no sandbox of its own
    expect(await createSandbox(platform(made.sandboxOrganizationId), { code: `${code}4`, contractRef: 'CT-2026-001', reason: 'ระบบทดลองซ้อน' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NOT_PRODUCTION' } } })
  })

  it('INV-TEN-01: the sandbox reaches none of production rows', async () => {
    const draft = ok(await createDraft(production.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ของจริงของ production', lines: [{ description: 'ปูน', quantity: '1', uom: 'ถุง', unitPrice: '100.00' }] }, key()))
    expect(await forTenant(sandbox.organizationId).request.findFirst({ where: { id: draft.requestId } })).toBeNull()
    expect(await forTenant(sandbox.organizationId).request.count({ where: { title: 'ของจริงของ production' } })).toBe(0)
  })
})
