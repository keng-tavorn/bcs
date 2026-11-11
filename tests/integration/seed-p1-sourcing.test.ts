import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { businessMinutesBetween } from '@/core/sla'
import { sourcingSettingsOf } from '@/lib/org-settings'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { forTenant } from '@/server/db/tenant'
import { seedAccountCodes } from '@/server/seed/account-codes'
import { parseApProfile, seedApProfile } from '@/server/seed/ap-profile'
import { seedBudget } from '@/server/seed/budget'
import { linkHistoryToCatalog, seedCatalog } from '@/server/seed/catalog'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { P1_SEED_MODULES, seedP1Modules } from '@/server/seed/p1-modules'
import { seedDevPins } from '@/server/seed/pins'
import { parseBudget, parseCatalogItems, parseCostCenters, parseGlAccounts, parseHistory, parseSites, parseSuppliers } from '@/server/seed/sheets'
import { parseSourcing, type SourcingSheets } from '@/server/seed/sourcing'
import { parseSupplierPortal, seedSupplierPortalBase } from '@/server/seed/supplier-portal'
import { seedSuppliers } from '@/server/seed/suppliers'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { INPUT_WORKBOOKS, loadInputWorkbook } from '@/server/seed/workbook'
import { budgetKeyLines, seedDemoHistory } from '@/server/services/demo-history'
import { seedSourcingHistory } from '@/server/services/demo-seed/sourcing'
import { seedSupplierPortalHistory } from '@/server/services/demo-seed/supplier-portal'
import { TEST_PIN } from '../support/pin'

// S10-14 (docs/sub-specs/S10.md "การอ่านชีตของไฟล์ระยะ 1"): the phase-1 workbook seeds sourcing — SOURCING on after the DOA
// with RA-01 to RA-03, its settings from sheet Settings, the foreign supplier of sheet RFx_Suppliers approved through S7's
// application (FR-INT-201), and the four RFx of sheet RFx_Scenarios played with the real commands back in time in the
// order they open (RFX-…-00001 to 00004): the RFP of a need awarded to SP0142 with an agreed price and no PO, the
// concrete RFQ awarded above its baseline, the RFI concluded, the steel RFQ of H187 H217 left OPEN for the demo. The same
// functions as pnpm db:reset:p1, under another organization code and e-mail addresses, with the history of the two
// pool requests only (the whole history is tests/support/seed-p1.ts's).

const NOW = new Date('2026-11-11T05:00:00Z') // Wednesday 12:00 in Bangkok
const TIMEOUT = 600_000
const DAY_MINUTES = 540

let organizationId: string
let sheets: SourcingSheets

beforeAll(async () => {
  execSync('pnpm exec tsx scripts/storage-init.ts', { stdio: 'ignore' })
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const code = `SRC${randomUUID().slice(0, 6).toUpperCase()}`
  const renamed = { ...input, org: { ...input.org, code }, users: input.users.map((u) => ({ ...u, email: `${code.toLowerCase()}.${u.email}` })) }
  await seedTaxRates()
  organizationId = (await seedDemoOrganization(renamed, { password: 'seed-p1-sourcing-pass-01', now: NOW })).organizationId
  await seedOrgStructure(organizationId, renamed.users, parseOrgStructureInput(workbook), NOW)
  await seedP1Modules(organizationId, NOW)
  const budget = parseBudget(workbook)
  await seedBudget(organizationId, budget, NOW, parseCostCenters(workbook))
  await seedSuppliers(organizationId, { suppliers: parseSuppliers(workbook), sites: parseSites(workbook) }, NOW)
  await seedAccountCodes(organizationId, parseGlAccounts(workbook))
  await seedCatalog(organizationId, parseCatalogItems(workbook), NOW)
  await seedApProfile(organizationId, parseApProfile(workbook), NOW)
  await seedDevPins(organizationId, TEST_PIN, NOW)
  const portal = parseSupplierPortal(workbook)!
  await seedSupplierPortalBase(organizationId, portal, NOW)
  const history = parseHistory(workbook)
  await seedDemoHistory(organizationId, history.filter((r) => r.ref === 'H187' || r.ref === 'H217'), NOW, { pin: TEST_PIN, budgetKeys: budgetKeyLines(budget) })
  await linkHistoryToCatalog(organizationId)
  await seedSupplierPortalHistory(organizationId, portal, NOW)
  sheets = parseSourcing(workbook)!
  await seedSourcingHistory(organizationId, sheets, NOW, { pin: TEST_PIN, historyTitles: new Map(history.map((r) => [r.ref, r.title])) })
}, TIMEOUT)

const rfxOf = (title: string) => forTenant(organizationId).rfxEvent.findFirstOrThrow({ where: { title }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
const titleOf = (ref: string) => sheets.scenarios.find((s) => s.ref === ref)!.title
/** The rule of a document's route and who decided its tasks */
async function approverOf(subjectType: 'AWARD_DECISION' | 'SUPPLIER_APPLICATION', subjectId: string) {
  const route = await forTenant(organizationId).approvalRoute.findFirstOrThrow({
    where: { subjectType, subjectId },
    select: { ruleCode: true, steps: { select: { tasks: { select: { status: true, assignee: { select: { employeeCode: true } } } } } } },
  })
  return { rule: route.ruleCode, approvers: route.steps.flatMap((s) => s.tasks.map((t) => [t.assignee.employeeCode, t.status])) }
}

describe('[FR-SRC-201/AC1] S10-14 the phase-1 seed of sourcing', () => {
  it('SOURCING is on after SUPPLIER, its DOA has RA-01 to RA-03, its settings from sheet Settings', async () => {
    const db = forTenant(organizationId)
    expect(P1_SEED_MODULES.indexOf('SOURCING')).toBeGreaterThan(P1_SEED_MODULES.indexOf('SUPPLIER'))
    expect((await db.orgModule.findMany({ where: { enabled: true }, select: { module: true } })).map((m) => m.module)).toEqual(expect.arrayContaining(['SUPPLIER', 'SOURCING']))
    expect((await db.doaRule.findMany({ where: { documentType: 'RFX_AWARD' }, select: { code: true }, orderBy: { code: 'asc' } })).map((r) => r.code)).toEqual(['RA-01', 'RA-02', 'RA-03'])
    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
    expect(sourcingSettingsOf(org.settings)).toMatchObject({ minOpenBusinessDays: { RFQ: 3, RFP: 10, RFI: 5 }, minInvitesThresholdGross: '100000.00', allowVatInclusiveBids: true, sealedBids: true, minEvaluators: 2 })
    expect((org.settings as { numbering: Record<string, unknown> }).numbering).toMatchObject({ RFX: { pattern: 'RFX-{BE}-{SEQ5}' }, AWD: { pattern: 'AWD-{BE}-{SEQ5}' } })
  })

  it('[FR-INT-201/AC5] the foreign supplier approved through the application of S7: isForeign, no tax id, a contact who reads English', async () => {
    const db = forTenant(organizationId)
    const row = sheets.suppliers[0]!
    const contact = await db.supplierContact.findFirstOrThrow({ where: { email: row.contactEmail }, select: { locale: true, supplier: { select: { isForeign: true, taxId: true, payeeType: true, status: true, nameEn: true } } } })
    expect(contact).toEqual({ locale: 'en', supplier: { isForeign: true, taxId: null, payeeType: 'FOREIGN', status: 'ACTIVE', nameEn: 'Nordic Firewall AS' } })
    const app = await db.supplierApplication.findFirstOrThrow({ where: { contacts: { some: { email: row.contactEmail } } }, select: { id: true, status: true, decidedAt: true, payeeType: true, taxId: true } })
    expect(app).toMatchObject({ status: 'APPROVED', payeeType: 'FOREIGN', taxId: null })
    expect(await approverOf('SUPPLIER_APPLICATION', app.id)).toEqual({ rule: 'SA-01', approvers: [['dm_proc', 'APPROVED']] })
    // decided long before the RFP opened and outside the 90 days of the G-7 report (S7 scene 7 keeps its median)
    const rfp = await rfxOf(titleOf('RFX-IT-FIREWALL'))
    expect(app.decidedAt!.getTime()).toBeLessThan(rfp.openedAt!.getTime())
    expect(NOW.getTime() - app.decidedAt!.getTime()).toBeGreaterThan(90 * 86_400_000)
  })

  it('four RFx numbered in the order they open, in the status of the sheet; the opening and closing business days hold', async () => {
    const db = forTenant(organizationId)
    const all = await db.rfxEvent.findMany({ orderBy: { openedAt: 'asc' }, select: { title: true, number: true, status: true, openedAt: true, closesAt: true, kind: true } })
    const byOpen = [...sheets.scenarios].sort((a, b) => b.openBusinessDaysAgo - a.openBusinessDaysAgo)
    expect(all.map((r) => r.title)).toEqual(byOpen.map((s) => s.title))
    expect(all.map((r) => r.number)).toEqual(byOpen.map((s) => s.expectedNumber))
    expect(all.map((r) => r.status)).toEqual(['AWARDED', 'AWARDED', 'CONCLUDED', 'OPEN'])
    const calendar = await db.$transaction((tx) => loadBusinessCalendar(tx, organizationId))
    const minimum = { RFQ: 3, RFP: 10, RFI: 5 } as const
    for (const r of all) expect(businessMinutesBetween(r.openedAt!, r.closesAt!, calendar), r.title).toBeGreaterThanOrEqual(minimum[r.kind] * DAY_MINUTES)
    // the steel RFQ is open for the demo: opened today, closing after it
    const steel = all.at(-1)!
    expect(steel.openedAt!.getTime()).toBeLessThanOrEqual(NOW.getTime())
    expect(steel.closesAt!.getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('[FR-SRC-201/AC2] the steel RFQ holds the two pool lines of H187 and H217 (STEEL), three invited, nothing bid or scored yet', async () => {
    const db = forTenant(organizationId)
    const steel = await rfxOf(titleOf('RFX-STEEL-DB12'))
    expect(steel).toMatchObject({ categoryCode: 'STEEL', sourceKind: 'REQUEST_LINES', minInvites: 3, estimatedNetSatang: 30_940_000n, allowVatInclusiveBids: true, sealed: true })
    expect(steel.lines.map((l) => [l.quantity.toString(), l.refUnitPriceSatang])).toEqual([
      ['8', 2_380_000n],
      ['5', 2_380_000n],
    ])
    expect(await db.requestLine.count({ where: { rfxEventId: steel.id } })).toBe(2)
    expect(await db.rfxInvite.count({ where: { rfxEventId: steel.id } })).toBe(3)
    expect(await db.bid.count({ where: { rfxEventId: steel.id } })).toBe(0)
    // its invitations wait for the job to e-mail the suppliers' contacts (scene 9 is played live)
    expect(await db.supplierNotice.count({ where: { subjectId: steel.id, status: 'PENDING', templateKey: 'rfx.invited' } })).toBe(3)
  })

  it('[FR-SRC-204/AC2] [FR-SRC-204/AC9] the RFP of a need: SP0142 wins on scores at 177,000.00 (189,390.00 with VAT) through RA-01 to dm_proc; an agreed price, no PO', async () => {
    const db = forTenant(organizationId)
    const rfp = await rfxOf(titleOf('RFX-IT-FIREWALL'))
    const award = await db.awardDecision.findFirstOrThrow({ where: { rfxEventId: rfp.id }, include: { lines: { include: { supplier: { select: { code: true } } } } } })
    expect(award).toMatchObject({ status: 'APPROVED', netSatang: 17_700_000n, vatSatang: 1_239_000n, grossSatang: 18_939_000n })
    expect(new Set(award.lines.map((l) => l.supplier.code))).toEqual(new Set(['SP0142']))
    expect(award.reason).toBeTruthy()
    expect(await approverOf('AWARD_DECISION', award.id)).toEqual({ rule: 'RA-01', approvers: [['dm_proc', 'APPROVED']] })
    expect(await db.purchaseOrder.count({ where: { rfxEventId: rfp.id } })).toBe(0)
    const agreement = await db.priceAgreement.findFirstOrThrow({ where: { sourceRef: { startsWith: 'AWD-' }, catalogItem: { code: 'ITM-006' } }, select: { unitPriceSatang: true, supplier: { select: { code: true } } } })
    expect(agreement).toEqual({ unitPriceSatang: 8_250_000n, supplier: { code: 'SP0142' } })
    // the question of SP0142 answered to everyone before the cutoff (BR-RFX-04)
    expect(await db.rfxQuestion.count({ where: { rfxEventId: rfp.id, answeredAt: { not: null } } })).toBe(1)
    // 13.7 business days from its opening to the approval (G-8 · BR-RFX-15)
    const calendar = await db.$transaction((tx) => loadBusinessCalendar(tx, organizationId))
    expect(Math.round((businessMinutesBetween(rfp.openedAt!, award.decidedAt!, calendar) * 10) / DAY_MINUTES) / 10).toBe(13.7)
  })

  it('[FR-SRC-204/AC6] [FR-SRC-204/AC8] the concrete RFQ awarded above its baseline (101,500.00 against 100,000.00); the winners preferred in their categories', async () => {
    const db = forTenant(organizationId)
    const rfq = await rfxOf(titleOf('RFX-CONCRETE'))
    const award = await db.awardDecision.findFirstOrThrow({ where: { rfxEventId: rfq.id }, select: { status: true, netSatang: true, grossSatang: true, decidedAt: true, lines: { select: { supplier: { select: { code: true } } } } } })
    expect(award).toMatchObject({ status: 'APPROVED', netSatang: 10_150_000n, grossSatang: 10_860_500n })
    expect(award.lines.map((l) => l.supplier.code)).toEqual(['SP0033'])
    // the baseline of a need is its reference (40 × 2,500.00): savings −1,500.00
    expect(rfq.estimatedNetSatang! - award.netSatang).toBe(-150_000n)
    const calendar = await db.$transaction((tx) => loadBusinessCalendar(tx, organizationId))
    expect(Math.round((businessMinutesBetween(rfq.openedAt!, award.decidedAt!, calendar) * 10) / DAY_MINUTES) / 10).toBe(6.7)
    const preferred = await db.preferredSupplier.findMany({ select: { categoryCode: true, supplier: { select: { code: true } } }, orderBy: { categoryCode: 'asc' } })
    expect(preferred.map((p) => [p.categoryCode, p.supplier.code])).toEqual([
      ['IT', 'SP0142'],
      ['RMC', 'SP0033'],
    ])
  })

  it('the RFI concluded with its summary, no award; no e-mail of the past waits for the job', async () => {
    const db = forTenant(organizationId)
    const rfi = await rfxOf(titleOf('RFX-SUB-RFI'))
    expect(rfi).toMatchObject({ status: 'CONCLUDED', kind: 'RFI' })
    expect(await db.awardDecision.count({ where: { rfxEventId: rfi.id } })).toBe(0)
    expect(await db.rfxInvite.count({ where: { rfxEventId: rfi.id } })).toBe(5)
    const past = await db.rfxEvent.findMany({ where: { status: { not: 'OPEN' } }, select: { id: true } })
    expect(await db.supplierNotice.count({ where: { status: 'PENDING', subjectId: { in: past.map((r) => r.id) } } })).toBe(0)
  })

  it('a second seed adds nothing', async () => {
    const db = forTenant(organizationId)
    const before = [await db.rfxEvent.count(), await db.bid.count(), await db.awardDecision.count(), await db.supplierApplication.count()]
    expect(await seedSourcingHistory(organizationId, sheets, NOW, { pin: TEST_PIN, historyTitles: new Map() })).toMatchObject({ seeded: false })
    expect([await db.rfxEvent.count(), await db.bid.count(), await db.awardDecision.count(), await db.supplierApplication.count()]).toEqual(before)
  })
}, TIMEOUT)
