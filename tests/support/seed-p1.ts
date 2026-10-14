import { execSync } from 'node:child_process'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { taxDateOf } from '@/core/vat'
import { MS_PER_DAY } from '@/lib/constants'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { seedBudget } from '@/server/seed/budget'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { seedDevPins } from '@/server/seed/pins'
import { seedAccountCodes } from '@/server/seed/account-codes'
import { parseApProfile, registryFlagOf, seedApProfile } from '@/server/seed/ap-profile'
import { seedP1Modules } from '@/server/seed/p1-modules'
import { parseBudget, parseCostCenters, parseGlAccounts, parseHistory, parseSites, parseSuppliers } from '@/server/seed/sheets'
import { seedSuppliers } from '@/server/seed/suppliers'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { INPUT_WORKBOOKS, loadInputWorkbook } from '@/server/seed/workbook'
import { budgetKeyLines, seedDemoHistory, type DemoHistoryReport } from '@/server/services/demo-history'

// P1-02: `pnpm db:reset:p1` seeds the synthetic workbook of phase 1 (docs/inputs/BCS_inputs_p1.xlsx) — the organization,
// its users, budget of two fiscal years, cost centers, suppliers and the requests of sheet Request_History through the
// real services. This runs the same seed functions as prisma/seed.ts at a given clock, under another organization code
// and e-mail addresses so the test files that call it never meet each other, and checks the result against the sheets
// read here with ExcelJS directly, not through the loader under test.

const PASSWORD = 'seed-p1-test-password-0001'
const TOTP_KEY = 'seed-p1-test-totp-key-000000000001'
/** The transaction PIN the seed gives the approvers (a PIN the rules of FR-AUTH-005 AC1 accept) */
const PIN = '739164'
/** Seeding 240 requests through the services takes about two minutes on this machine */
const SEED_TIMEOUT_MS = 900_000
/** FR-INT-101 reminds 60 and 30 days before a service line ends */
const RENEWAL_WINDOW_DAYS = 60

type Row = Readonly<Record<string, string>>

/** A table sheet: keys on row 1, Thai labels on row 2, data from row 3 to the first row whose first cell is empty */
function sheetRows(workbook: ExcelJS.Workbook, name: string): Row[] {
  const sheet = workbook.getWorksheet(name)
  if (!sheet) throw new Error(`sheet ${name} is missing`)
  const keys = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? '').trim())
  const rows: Row[] = []
  for (let r = 3; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r)
    if (String(row.getCell(1).value ?? '').trim() === '') break
    const values: Record<string, string> = {}
    keys.forEach((key, col) => {
      if (key) values[key] = String(row.getCell(col).value ?? '').trim()
    })
    rows.push(values)
  }
  return rows
}

/** The Bangkok calendar day of an instant */
const dayOf = (at: Date) => taxDateOf(at)

export interface SeedP1Clock {
  /** What the clock stands for, in the test names */
  readonly label: string
  readonly now: Date
  /** Organization code the test seeds under (the sheet's SIMEC is left to pnpm db:reset:p1) */
  readonly orgCode: string
  /** Fiscal years the requests must use at this clock */
  readonly fiscalYears: readonly string[]
}

/** Registers the tests of one seed of the phase-1 workbook at `clock.now` */
export function describeP1Seed(clock: SeedP1Clock): void {
  let organizationId: string
  let report: DemoHistoryReport
  let sheets: { users: Row[]; departments: Row[]; budget: Row[]; costCenters: Row[]; suppliers: Row[]; sites: Row[]; items: Row[]; history: Row[]; supplierPayment: Row[] }

  beforeAll(async () => {
    const raw = new ExcelJS.Workbook()
    await raw.xlsx.readFile(INPUT_WORKBOOKS.p1)
    const read = (name: string) => sheetRows(raw, name)
    sheets = {
      users: read('Users'),
      departments: read('Departments'),
      budget: read('Budget'),
      costCenters: read('CostCenters'),
      suppliers: read('Suppliers'),
      sites: read('Sites'),
      items: read('Items'),
      history: read('Request_History'),
      supplierPayment: read('SupplierPayment'),
    }

    // The history stores quotations, DPAs and PO PDFs: the bucket must exist (as tests/integration/files.test.ts does)
    execSync('pnpm exec tsx scripts/storage-init.ts', { stdio: 'ignore' })
    const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
    const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
    const prefix = `${clock.orgCode.toLowerCase()}.`
    const renamed = { ...input, org: { ...input.org, code: clock.orgCode }, users: input.users.map((u) => ({ ...u, email: `${prefix}${u.email}` })) }
    await seedTaxRates()
    const org = await seedDemoOrganization(renamed, { password: PASSWORD, totpKey: TOTP_KEY, now: clock.now })
    organizationId = org.organizationId
    await seedOrgStructure(organizationId, renamed.users, parseOrgStructureInput(workbook), clock.now)
    // As pnpm db:reset:p1 seeds it (seedDemoBase): PAY AI BCS_GO on, and the account codes of sheet GL_Accounts (S8-04)
    await seedP1Modules(organizationId, clock.now)
    const budget = parseBudget(workbook)
    await seedBudget(organizationId, budget, clock.now, parseCostCenters(workbook))
    await seedSuppliers(organizationId, { suppliers: parseSuppliers(workbook), sites: parseSites(workbook) }, clock.now)
    await seedAccountCodes(organizationId, parseGlAccounts(workbook))
    await seedApProfile(organizationId, parseApProfile(workbook), clock.now)
    await seedDevPins(organizationId, PIN, clock.now)
    report = await seedDemoHistory(organizationId, parseHistory(workbook), clock.now, { pin: PIN, budgetKeys: budgetKeyLines(budget) })
  }, SEED_TIMEOUT_MS)

  describe(`[FR-PLT-001/AC1] P1-02 seed of the phase-1 workbook ${clock.label}`, () => {
    it('makes the organization, its users, departments, budget of two fiscal years, cost centers named by sheet CostCenters, suppliers and sites, one per row', async () => {
      const db = forTenant(organizationId)
      expect(await db.member.count()).toBe(sheets.users.length)
      expect(await db.department.count()).toBe(sheets.departments.length)
      expect(await db.budgetLine.count()).toBe(sheets.budget.length)
      expect((await db.fiscalYear.findMany({ select: { code: true }, orderBy: { code: 'asc' } })).map((y) => y.code)).toEqual([...new Set(sheets.budget.map((b) => b.fiscalYear))].sort())
      const centers = await db.costCenter.findMany({ select: { code: true, nameTh: true, department: { select: { code: true } } } })
      expect(new Map(centers.map((c) => [c.code, `${c.nameTh} @ ${c.department.code}`]))).toEqual(new Map(sheets.costCenters.map((c) => [c.code!, `${c.nameTh} @ ${c.department}`])))
      expect(await db.supplier.count()).toBe(sheets.suppliers.length)
      expect(await db.deliverySite.count()).toBe(sheets.sites.length)
      // Every line holds its planned amount
      const lines = await db.budgetLine.findMany({ select: { code: true, fiscalYear: { select: { code: true } }, balance: { select: { availableSatang: true, reservedSatang: true, committedSatang: true, actualSatang: true } } } })
      for (const sheetLine of sheets.budget) {
        const line = lines.find((l) => l.code === sheetLine.code && l.fiscalYear.code === sheetLine.fiscalYear)
        const b = line?.balance
        expect(b && b.availableSatang + b.reservedSatang + b.committedSatang + b.actualSatang, sheetLine.code).toBe(amountToSatang(sheetLine.planned!))
      }
    })

    it('makes one request per row of Request_History, in its status, routed by the rule and to the approver the sheet expects', async () => {
      expect(report.seeded).toBe(true)
      expect(Object.values(report.byStatus).reduce((a, b) => a + b, 0)).toBe(sheets.history.length)
      const db = forTenant(organizationId)
      const requests = await db.request.findMany({ select: { id: true, title: true, status: true } })
      expect(requests).toHaveLength(sheets.history.length)
      const byTitle = new Map(requests.map((r) => [r.title, r]))
      const routes = await db.approvalRoute.findMany({
        where: { subjectType: 'REQUEST' },
        orderBy: { createdAt: 'asc' },
        select: { subjectId: true, ruleCode: true, escalatedFromRuleCode: true, steps: { orderBy: { stepNo: 'asc' }, take: 1, select: { tasks: { orderBy: { createdAt: 'asc' }, take: 1, select: { assignee: { select: { employeeCode: true } } } } } } },
      })
      for (const row of sheets.history) {
        const request = byTitle.get(row.title!)
        expect(request?.status, row.ref).toBe(row.status)
        const route = routes.find((r) => r.subjectId === request!.id)!
        expect(
          { rule: route.escalatedFromRuleCode ?? route.ruleCode, escalated: route.escalatedFromRuleCode !== null, approver: route.steps[0]?.tasks[0]?.assignee.employeeCode },
          row.ref,
        ).toEqual({ rule: row.expectedRule, escalated: row.escalated === 'Y', approver: row.expectedApprover })
      }
    })

    it(`charges each request to its budget key's line of the fiscal year of the day it was sent (${clock.fiscalYears.join(' and ')})`, async () => {
      const db = forTenant(organizationId)
      const years = await db.fiscalYear.findMany({ select: { code: true, startsOn: true, endsOn: true } })
      const requests = await db.request.findMany({ select: { title: true, submittedAt: true, budgetLine: { select: { code: true, fiscalYear: { select: { code: true } } } } } })
      const used = new Set<string>()
      for (const row of sheets.history) {
        const request = requests.find((r) => r.title === row.title)!
        const day = dayOf(request.submittedAt!)
        const year = years.find((y) => y.startsOn.toISOString().slice(0, 10) <= day && day <= y.endsOn.toISOString().slice(0, 10))!
        const line = sheets.budget.find((b) => b.budgetKey === row.budgetKey && b.fiscalYear === year.code)!
        expect(request.budgetLine?.code, row.ref).toBe(line.code)
        used.add(year.code)
      }
      expect([...used].sort()).toEqual([...clock.fiscalYears].sort())
    })

    it('gives each request the item, quantity, unit and unit price of its row, the answers of column form, a DPA when the supplier processes personal data, and a renewal date from serviceEndInDays', async () => {
      const db = forTenant(organizationId)
      const items = new Map(sheets.items.map((i) => [i.code!, i.nameTh!]))
      const requests = await db.request.findMany({ select: { id: true, title: true, formData: true, lines: { orderBy: { lineNo: 'asc' }, select: { description: true, quantity: true, uom: true, unitPriceSatang: true, serviceEndDate: true } } } })
      const dpa = new Set((await db.fileLink.findMany({ where: { subjectType: 'Request', kind: 'DPA' }, select: { subjectId: true } })).map((l) => l.subjectId))
      let withDpa = 0
      for (const row of sheets.history) {
        const request = requests.find((r) => r.title === row.title)!
        expect(request.lines.map((l) => ({ description: l.description, quantity: Number(l.quantity.toString()), uom: l.uom, unitPrice: l.unitPriceSatang })), row.ref).toEqual([
          { description: items.get(row.itemCode!), quantity: Number(row.qty), uom: row.unit, unitPrice: amountToSatang(row.unitPrice!) },
        ])
        const form = row.form ? (JSON.parse(row.form) as Record<string, string>) : {}
        expect(request.formData, row.ref).toMatchObject(form)
        const personal = form.processesPersonalData === 'Y'
        expect(dpa.has(request.id), row.ref).toBe(personal)
        if (personal) withDpa++
        const end = request.lines[0]!.serviceEndDate?.toISOString().slice(0, 10)
        if (row.serviceEndInDays) expect(end, row.ref).toBe(dayOf(new Date(clock.now.getTime() + Number(row.serviceEndInDays) * MS_PER_DAY)))
        // Only the renewal rows remind: any other service ends after FR-INT-101's 60-day reminder window
        else if (end) expect(end > dayOf(new Date(clock.now.getTime() + RENEWAL_WINDOW_DAYS * MS_PER_DAY)), `${row.ref} ends ${end}`).toBe(true)
      }
      // The sheet has rows that need a DPA (ATT-DPA), so the path above was taken
      expect(withDpa).toBeGreaterThan(0)
    })

    it('[FR-AP-102/AC3] S8-12: with PAY on, each completed row’s invoice is a tier-2 invoice in the state its scenario leaves it, counted per scenario', async () => {
      const db = forTenant(organizationId)
      expect(await db.invoiceConfirmation.count()).toBe(0)
      expect(await db.accountCode.count()).toBe(parseGlAccounts(await loadInputWorkbook(INPUT_WORKBOOKS.p1)).length)
      const completed = sheets.history.filter((r) => r.status === 'COMPLETED')
      const invoices = await db.invoice.findMany({ where: { number: { not: null } }, select: { supplierInvoiceNo: true, status: true } })
      const expected = (row: (typeof completed)[number]) => {
        const paid = row.paymentStatus === 'PAID'
        if (row.invoiceScenario === 'PRICE_OVER' || row.invoiceScenario === 'QTY_OVER') return paid || (row.invoiceScenario === 'QTY_OVER' && Number(row.qty) < 2) ? 'READY_FOR_PAYMENT' : 'EXCEPTION'
        return 'READY_FOR_PAYMENT'
      }
      const counted: Record<string, number> = {}
      for (const row of completed) {
        const scenario = row.invoiceScenario || 'MATCH'
        const mine = invoices.filter((i) => i.supplierInvoiceNo === (row.invoiceNo || `INV-${row.ref}`))
        if (scenario === 'MISSING') {
          expect(mine, row.ref).toHaveLength(0)
          continue
        }
        expect(mine.map((i) => i.status), row.ref).toEqual([expected(row)])
        counted[scenario] = (counted[scenario] ?? 0) + 1
      }
      // one submitted invoice per row of each scenario but MISSING, as the sheet counts them
      const bySheet: Record<string, number> = {}
      for (const row of completed) if ((row.invoiceScenario || 'MATCH') !== 'MISSING') bySheet[row.invoiceScenario || 'MATCH'] = (bySheet[row.invoiceScenario || 'MATCH'] ?? 0) + 1
      expect(counted).toEqual(bySheet)
      // the inbox: the second copy of each DUPLICATE row and one invoice that names no PO
      const duplicates = completed.filter((r) => r.invoiceScenario === 'DUPLICATE').length
      expect(await db.inboundEmail.count({ where: { status: 'PROCESSED' } })).toBe(duplicates + 1)
    })

    it('S8-12: each supplier’s registry flag, payee type and default income type are those of sheet SupplierPayment', async () => {
      const db = forTenant(organizationId)
      const suppliers = await db.supplier.findMany({ select: { code: true, registryFlag: true, payeeType: true, defaultWhtIncomeTypeCode: true } })
      for (const p of sheets.supplierPayment) {
        const s = suppliers.find((x) => x.code === p.supplierCode)!
        expect({ flag: s.registryFlag, payee: s.payeeType, wht: s.defaultWhtIncomeTypeCode }, String(p.supplierCode)).toEqual({ flag: registryFlagOf(String(p.registryStatus)), payee: p.payeeType, wht: p.whtIncomeType || null })
      }
      // the income types are there, waiting for the accountant to confirm them
      expect(await db.whtIncomeType.count({ where: { confirmedById: null } })).toBeGreaterThan(0)
    })

    it('leaves a history made in full alone when the seed runs again', async () => {
      const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
      const again = await seedDemoHistory(organizationId, parseHistory(workbook), clock.now, { pin: PIN, budgetKeys: budgetKeyLines(parseBudget(workbook)) })
      expect(again.seeded).toBe(false)
      expect(await prisma.request.count({ where: { organizationId } })).toBe(sheets.history.length)
    })
  })
}
