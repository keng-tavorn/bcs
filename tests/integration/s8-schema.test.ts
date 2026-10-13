import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { makeCtx, systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { recordSensitiveAccess } from '@/server/services/audit/sensitive-access'
import { issueDocumentNumber } from '@/server/services/numbering'
import { saveOrgSettings } from '@/server/services/organization/settings'
import { createMember, createOrg } from '../support/factory'

// S8-01 (docs/sub-specs/S8.md "Entity และ migration"): the database refuses negative money and an invoice whose
// payable is not gross − retention (INV-AP-04), keeps one document per withholding-tax row, one live supplier number
// (INV-AP-06) and one open change per PO, and SensitiveAccessLog is insert-only for the app role. References into
// another organization are refused by the generated tenant test (tests/generated/tenant-isolation.test.ts).

let orgId: string
let memberId: string
let supplierId: string
let poId: string

beforeAll(async () => {
  const org = await createOrg()
  orgId = org.id
  memberId = (await createMember(orgId)).id
  supplierId = (await prisma.supplier.create({ data: { organizationId: orgId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'ผู้ขายทดสอบ', isForeign: true } })).id
  poId = (await prisma.purchaseOrder.create({ data: { organizationId: orgId, supplierId, status: 'SENT', number: `PO-${randomUUID().slice(0, 8)}` } })).id
})

const invoiceData = (over: Record<string, unknown> = {}) => ({ organizationId: orgId, poId, supplierId, channel: 'UPLOAD' as const, ...over })

describe('[INV-AP-04] Invoice money CHECKs', () => {
  it('accepts a draft at zero and an invoice whose payable is gross − retention', async () => {
    await expect(prisma.invoice.create({ data: invoiceData() })).resolves.toBeTruthy()
    const inv = await prisma.invoice.create({
      data: invoiceData({ netSatang: 100_000n, statedVatSatang: 7_000n, grossSatang: 107_000n, retentionBp: 500, retentionSatang: 5_000n, payableSatang: 102_000n, expectedWhtSatang: 3_000n }),
    })
    expect(inv.payableSatang).toBe(102_000n)
  })

  it.each([
    ['negative amount before VAT', { netSatang: -1n, grossSatang: -1n, payableSatang: -1n }],
    ['negative retention', { netSatang: 100n, grossSatang: 100n, retentionSatang: -1n, payableSatang: 101n }],
    ['gross is not net + stated VAT', { netSatang: 100n, statedVatSatang: 7n, grossSatang: 108n, payableSatang: 108n }],
    ['payable is not gross − retention', { netSatang: 100n, grossSatang: 100n, retentionSatang: 5n, payableSatang: 100n }],
    ['expected WHT above payable', { netSatang: 100n, grossSatang: 100n, payableSatang: 100n, expectedWhtSatang: 101n }],
    ['retention rate above 100%', { retentionBp: 10_001 }],
    ['a normalized number with a space', { supplierInvoiceNoNormalized: 'INV 1' }],
  ])('refuses %s', async (_label, over) => {
    await expect(prisma.invoice.create({ data: invoiceData(over) })).rejects.toThrow()
  })

  it('refuses a submitted invoice without its number, supplier number or date', async () => {
    await expect(prisma.invoice.create({ data: invoiceData({ status: 'READY_FOR_PAYMENT' }) })).rejects.toThrow()
  })
})

describe('[INV-AP-06] one live invoice per (supplier, normalized number); drafts may repeat it', () => {
  it('lets drafts share a number and refuses a second live one', async () => {
    const no = `INV${randomUUID().slice(0, 6).toUpperCase()}`
    const live = { supplierInvoiceNo: no, supplierInvoiceNoNormalized: no, invoiceDate: new Date('2026-10-01'), status: 'READY_FOR_PAYMENT' as const }
    await prisma.invoice.create({ data: invoiceData({ supplierInvoiceNo: no, supplierInvoiceNoNormalized: no }) })
    await prisma.invoice.create({ data: invoiceData({ supplierInvoiceNo: no, supplierInvoiceNoNormalized: no }) })
    await prisma.invoice.create({ data: invoiceData({ ...live, number: `AP-${randomUUID()}` }) })
    await expect(prisma.invoice.create({ data: invoiceData({ ...live, number: `AP-${randomUUID()}` }) })).rejects.toThrow()
    // a rejected one does not count
    await expect(prisma.invoice.create({ data: invoiceData({ ...live, status: 'REJECTED', number: `AP-${randomUUID()}` }) })).resolves.toBeTruthy()
  })
})

describe('S8 tables refuse negative money', () => {
  it('InvoiceLine, MatchException, Retention, WithholdingTax, WhtCertificate, PoChange', async () => {
    const inv = await prisma.invoice.create({ data: invoiceData() })
    const fy = await prisma.fiscalYear.create({ data: { organizationId: orgId, code: `FY-${randomUUID().slice(0, 6)}`, startsOn: new Date('2025-10-01'), endsOn: new Date('2026-09-30') } })
    const dept = await prisma.department.create({ data: { organizationId: orgId, code: `D-${randomUUID().slice(0, 6)}`, nameTh: 'แผนก', kind: 'DEPARTMENT', parentId: null } }).catch(async () => prisma.department.findFirstOrThrow({ where: { organizationId: orgId } }))
    const cc = await prisma.costCenter.create({ data: { organizationId: orgId, code: `CC-${randomUUID().slice(0, 6)}`, nameTh: 'cc', departmentId: dept.id } })
    const bl = await prisma.budgetLine.create({ data: { organizationId: orgId, fiscalYearId: fy.id, departmentId: dept.id, costCenterId: cc.id, code: `B-${randomUUID().slice(0, 6)}`, nameTh: 'งบ', plannedSatang: 0n } })
    const poLine = await prisma.poLine.create({ data: { organizationId: orgId, poId, lineNo: Math.floor(Math.random() * 1e6) + 1, description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPriceSatang: 100n, netSatang: 100n, budgetLineId: bl.id } })
    const line = (over: Record<string, unknown>) => prisma.invoiceLine.create({ data: { organizationId: orgId, invoiceId: inv.id, lineNo: 1, poLineId: poLine.id, description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPriceSatang: 100n, ...over } })
    await expect(line({ unitPriceSatang: -1n })).rejects.toThrow()
    await expect(line({ quantity: '0' })).rejects.toThrow()
    await expect(line({ overSatang: -1n })).rejects.toThrow()
    const match = await prisma.invoiceMatch.create({ data: { organizationId: orgId, invoiceId: inv.id, runNo: 1, ranAt: new Date(), result: 'EXCEPTION', policy: {}, snapshot: {}, triggeredBy: 'USER' } })
    await expect(prisma.matchException.create({ data: { organizationId: orgId, invoiceId: inv.id, invoiceMatchId: match.id, type: 'PRICE_OVER', amountSatang: -1n, assigneeRole: 'PROCUREMENT' } })).rejects.toThrow()
    await expect(prisma.retention.create({ data: { organizationId: orgId, invoiceId: inv.id, poId, supplierId, amountSatang: -1n } })).rejects.toThrow()
    const wht = { organizationId: orgId, supplierId, payeeType: 'JURISTIC' as const, incomeTypeCode: 'SERVICE', form: 'PND53' as const, rateBp: 300, paidOn: new Date('2026-10-10') }
    await expect(prisma.withholdingTax.create({ data: { ...wht, invoiceId: inv.id, baseSatang: -1n, taxSatang: 0n } })).rejects.toThrow()
    await expect(prisma.whtCertificate.create({ data: { organizationId: orgId, number: `W-${randomUUID()}`, supplierId, form: 'PND53', paidOn: new Date('2026-10-10'), totalBaseSatang: 0n, totalTaxSatang: -1n, payeeSnapshot: {}, payerSnapshot: {}, issuedAt: new Date() } })).rejects.toThrow()
    const change = { organizationId: orgId, poId, changeNo: 1, oldNetSatang: 100n, oldVatSatang: 7n, oldGrossSatang: 107n, newNetSatang: 100n, newVatSatang: 7n, newGrossSatang: 107n, createdById: memberId }
    await expect(prisma.poChange.create({ data: { ...change, newNetSatang: -100n, newGrossSatang: -93n } })).rejects.toThrow()
    await expect(prisma.poChange.create({ data: { ...change, newGrossSatang: 108n } })).rejects.toThrow()
  })

  it('[BR-WHT-10] a withholding-tax row names an invoice or a retention, never both or neither', async () => {
    const inv = await prisma.invoice.create({ data: invoiceData() })
    const ret = await prisma.retention.create({ data: { organizationId: orgId, invoiceId: inv.id, poId, supplierId, amountSatang: 100n } })
    const wht = { organizationId: orgId, supplierId, payeeType: 'JURISTIC' as const, incomeTypeCode: 'SERVICE', form: 'PND53' as const, rateBp: 300, baseSatang: 100n, taxSatang: 3n, paidOn: new Date('2026-10-10') }
    await expect(prisma.withholdingTax.create({ data: wht })).rejects.toThrow()
    await expect(prisma.withholdingTax.create({ data: { ...wht, invoiceId: inv.id, retentionId: ret.id } })).rejects.toThrow()
    await expect(prisma.withholdingTax.create({ data: { ...wht, invoiceId: inv.id } })).resolves.toBeTruthy()
    await expect(prisma.withholdingTax.create({ data: { ...wht, retentionId: ret.id } })).resolves.toBeTruthy()
  })

  it('[BR-WHT-03] the member who confirms a rate is not the one who changed it last', async () => {
    const other = await createMember(orgId)
    const type = { organizationId: orgId, nameTh: 'ค่าบริการ', rateBp: 300, form: 'PND3_53' as const, updatedById: memberId }
    await expect(prisma.whtIncomeType.create({ data: { ...type, code: `A-${randomUUID()}`, confirmedById: memberId, confirmedAt: new Date() } })).rejects.toThrow()
    await expect(prisma.whtIncomeType.create({ data: { ...type, code: `B-${randomUUID()}`, confirmedById: other.id, confirmedAt: new Date() } })).resolves.toBeTruthy()
  })
})

describe('one open change per PO (PO_CHANGE_OPEN)', () => {
  it('refuses a second DRAFT or PENDING_APPROVAL change and allows one after the first is decided', async () => {
    const po = await prisma.purchaseOrder.create({ data: { organizationId: orgId, supplierId, status: 'SENT', number: `PO-${randomUUID().slice(0, 8)}` } })
    const change = (changeNo: number, status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED') =>
      prisma.poChange.create({ data: { organizationId: orgId, poId: po.id, changeNo, status, oldNetSatang: 0n, oldVatSatang: 0n, oldGrossSatang: 0n, newNetSatang: 0n, newVatSatang: 0n, newGrossSatang: 0n, createdById: memberId } })
    const first = await change(1, 'DRAFT')
    await expect(change(2, 'PENDING_APPROVAL')).rejects.toThrow()
    await prisma.poChange.update({ where: { id: first.id }, data: { status: 'APPROVED' } })
    await expect(change(2, 'DRAFT')).resolves.toBeTruthy()
  })
})

describe('[NFR-PRIV-03] SensitiveAccessLog', () => {
  it('records who opened which fields, never the value, and the app role cannot change or remove a row', async () => {
    const ctx = makeCtx({ organizationId: orgId, actor: { type: 'USER', memberId }, channel: 'WEB', now: new Date('2026-10-13T03:00:00Z') })
    const subjectId = randomUUID()
    await forTenant(orgId).$transaction((tx) => recordSensitiveAccess(tx, ctx, { subjectType: 'WhtCertificate', subjectId, fields: ['payeeTaxId'], purpose: 'wht.revealTaxId' }))
    const rows = await prisma.sensitiveAccessLog.findMany({ where: { organizationId: orgId, subjectId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ memberId, subjectType: 'WhtCertificate', fields: ['payeeTaxId'], purpose: 'wht.revealTaxId', at: new Date('2026-10-13T03:00:00Z') })
    await expect(prisma.sensitiveAccessLog.updateMany({ where: { id: rows[0]!.id }, data: { purpose: 'x' } })).rejects.toThrow(/permission denied/)
    await expect(prisma.sensitiveAccessLog.deleteMany({ where: { id: rows[0]!.id } })).rejects.toThrow(/permission denied/)
  })

  it('is written by a member only', async () => {
    await expect(
      forTenant(orgId).$transaction((tx) => recordSensitiveAccess(tx, systemCtx(orgId, new Date()), { subjectType: 'WhtCertificate', subjectId: randomUUID(), fields: ['payeeTaxId'], purpose: 'x' })),
    ).rejects.toThrow()
  })
})

describe('[FR-AP-102/AC2] the matching, withholding-tax and AP settings have no command in the app (BR-MATCH-13)', () => {
  it.each(['matching', 'wht', 'ap'])('saving section %s is VALIDATION_FAILED', async (section) => {
    const admin = await createMember(orgId, 'ผู้ดูแล')
    await prisma.roleAssignment.create({ data: { organizationId: orgId, memberId: admin.id, role: 'ORG_ADMIN', grantedAt: new Date() } })
    const ctx = makeCtx({ organizationId: orgId, actor: { type: 'USER', memberId: admin.id }, channel: 'WEB', now: new Date() })
    const result = await saveOrgSettings(ctx, { section: section as 'numbering', value: {} }, { idempotencyKey: randomUUID() })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'section' } } })
  })
})

describe('numbering.AP and numbering.WHT_CERT', () => {
  it('an organization without the S8 rules issues numbers of the OQ-12 default form; a saved rule wins', async () => {
    const org = await createOrg()
    const settings = parseYaml(readFileSync('prisma/seed/org-settings.demo.yaml', 'utf8')) as Record<string, unknown>
    await prisma.organization.update({ where: { id: org.id }, data: { settings: settings as object } })
    const ctx = systemCtx(org.id, new Date('2026-10-13T03:00:00Z'))
    const issue = (document: 'AP' | 'WHT_CERT') => forTenant(org.id).$transaction((tx) => issueDocumentNumber(tx, ctx, { document }))
    expect(await issue('AP')).toBe('AP-2569-00001')
    expect(await issue('AP')).toBe('AP-2569-00002')
    expect(await issue('WHT_CERT')).toBe('2569/00001')
    const numbering = { ...(settings.numbering as object), AP: { pattern: 'INV{YY}-{SEQ4}', reset: 'YEARLY' } }
    await prisma.organization.update({ where: { id: org.id }, data: { settings: { ...settings, numbering } as object } })
    // the yearly counter goes on under the new pattern (BR-NUM-03)
    expect(await issue('AP')).toBe('INV69-0003')
  })
})
