import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { taxDateOf } from '@/core/vat'
import { MS_PER_DAY } from '@/lib/constants'
import type { DoaRuleSnapshot } from '@/core/doa'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { ruleJson, versionSnapshotFromRows } from '@/server/doa/snapshot'
import { backtestDraft } from '@/server/services/backtest'
import { getPriceReference } from '@/server/services/price-reference'
import { decideTask } from '@/server/services/approvals/decide'
import { createBudgetTransfer, submitBudgetTransfer } from '@/server/services/budget/transfers'
import { submitBudgetOverrun } from '@/server/services/budget/overruns'
import { runBudgetAlerts } from '@/server/services/budget/alerts'
import { computeWorkflowReport } from '@/server/services/reports/workflow'
import { computeKpis } from '@/server/services/reports/kpi'
import { createDraft, submitRequest } from './requests'
import { stepUpForTask } from './pin'
import { renewRequestLine, runRenewalReminders } from '@/server/services/requests/repeat'
import { forTenant } from '@/server/db/tenant'
import { seedBudget } from '@/server/seed/budget'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { seedDevPins } from '@/server/seed/pins'
import { seedAccountCodes } from '@/server/seed/account-codes'
import { linkHistoryToCatalog, seedCatalog } from '@/server/seed/catalog'
import { seedP1Modules } from '@/server/seed/p1-modules'
import { parseBudget, parseCatalogItems, parseCostCenters, parseGlAccounts, parseHistory, parseSites, parseSuppliers } from '@/server/seed/sheets'
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
  let sheets: { users: Row[]; departments: Row[]; budget: Row[]; costCenters: Row[]; suppliers: Row[]; sites: Row[]; items: Row[]; history: Row[] }

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
    await seedCatalog(organizationId, parseCatalogItems(workbook), clock.now)
    await seedDevPins(organizationId, PIN, clock.now)
    report = await seedDemoHistory(organizationId, parseHistory(workbook), clock.now, { pin: PIN, budgetKeys: budgetKeyLines(budget) })
    await linkHistoryToCatalog(organizationId)
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

    it('[FR-AP-102/AC3] S8-04: with PAY on, every completed row’s invoice is a tier-2 invoice, matched and ready for payment', async () => {
      const db = forTenant(organizationId)
      const completed = sheets.history.filter((r) => r.status === 'COMPLETED').length
      expect(await db.invoiceConfirmation.count()).toBe(0)
      expect(await db.invoice.count()).toBe(completed)
      expect(await db.invoice.count({ where: { status: 'READY_FOR_PAYMENT' } })).toBe(completed)
      expect(await db.accountCode.count()).toBe(parseGlAccounts(await loadInputWorkbook(INPUT_WORKBOOKS.p1)).length)
      // every PO of a completed row is closed with nothing held: the last invoice took what it held
      const held = await db.budgetAllocation.aggregate({ where: { sourceType: 'PO_LINE' }, _sum: { committedSatang: true } })
      const open = await db.purchaseOrder.findMany({ where: { status: { not: 'CLOSED' } }, select: { lines: { select: { id: true } } } })
      const openHeld = await db.budgetAllocation.aggregate({ where: { sourceType: 'PO_LINE', sourceId: { in: open.flatMap((p) => p.lines.map((l) => l.id)) } }, _sum: { committedSatang: true } })
      expect(held._sum.committedSatang ?? 0n).toBe(openHeld._sum.committedSatang ?? 0n)
    })

    it('[FR-DOA-103/AC2] S6-07: a draft with a COO band moves eqp_02\'s monthly fuel from ceo to coo in the 90-day backtest', async () => {
      const db = forTenant(organizationId)
      const v1 = await db.doaVersion.findFirstOrThrow({ where: { versionNo: 1 }, include: { rules: true } })
      const snapshot = versionSnapshotFromRows(v1, v1.rules)
      // PR-03 (above 100,000.00 to the CEO) becomes the COO up to 1,000,000.00, and PR-04 the CEO above it
      const pr03 = snapshot.rules.find((r) => r.code === 'PR-03')!
      const coo = { approver: { kind: 'POSITION_OF_ORG' as const, position: 'COO' }, slaBusinessMinutes: 960, mode: 'SEQUENTIAL' as const }
      const rules: DoaRuleSnapshot[] = [
        ...snapshot.rules.map((r) => (r.code === 'PR-03' ? { ...r, when: { ...r.when, amount: { gt: pr03.when.amount!.gt, lte: 100_000_000n } }, steps: [coo] } : r)),
        { ...pr03, code: 'PR-04', when: { ...pr03.when, amount: { gt: 100_000_000n } } },
      ]
      const { id: _id, rules: _r, createdAt: _c, updatedAt: _u, ...rest } = v1
      const draft = await prisma.doaVersion.create({
        data: { ...rest, escalationPolicy: rest.escalationPolicy as object, sodPolicy: rest.sodPolicy as object, versionNo: 2, status: 'DRAFT', effectiveFrom: new Date(clock.now.getTime() + 30 * MS_PER_DAY), effectiveTo: null, publishedAt: null } as never,
      })
      for (const rule of rules) {
        const json = ruleJson(rule)
        await prisma.doaRule.create({ data: { organizationId, doaVersionId: draft.id, code: rule.code, documentType: json.documentType, priority: rule.priority, when: json.when, steps: json.steps } })
      }
      const admin = await db.roleAssignment.findFirstOrThrow({ where: { role: 'ORG_ADMIN', revokedAt: null }, select: { memberId: true } })
      const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: admin.memberId }, channel: 'WEB', now: clock.now })
      const view = await backtestDraft(ctx, { kind: 'DOA_VERSION', versionId: draft.id }, { idempotencyKey: randomUUID(), sender: null })
      if (!view.ok || view.data.status !== 'DONE') throw new Error(JSON.stringify(view))
      const member = async (code: string) => (await db.member.findFirstOrThrow({ where: { employeeCode: code }, select: { id: true } })).id
      const [eqp02, ceo, cooId] = await Promise.all([member('eqp_02'), member('ceo'), member('coo')])
      const fuel = await db.request.findMany({ where: { requesterMemberId: eqp02, id: { in: view.data.result.rows.map((r) => r.ref) }, lines: { some: { description: { contains: 'ดีเซล' } } } }, select: { id: true } })
      expect(fuel.length).toBeGreaterThanOrEqual(3)
      for (const f of fuel) {
        expect(view.data.result.rows.find((r) => r.ref === f.id), f.id).toMatchObject({ current: { rule: 'PR-03', approvers: [ceo] }, draft: { rule: 'PR-03', approvers: [cooId] }, changed: true })
      }
      // Every request the CEO lost is one the COO gained: the load per person is that move and nothing else
      expect(view.data.result.summary.load[ceo]).toBeLessThanOrEqual(-fuel.length)
      expect(view.data.result.summary.load[cooId]).toBe(-view.data.result.summary.load[ceo]!)
    })

    it('[FR-INT-102/AC1] S6-10: one catalogue item per row of Items, one agreed price per row naming a supplier, in effect for the fiscal year of the seed, and the history lines point at their items', async () => {
      const db = forTenant(organizationId)
      const agreed = sheets.items.filter((i) => i.agreementSupplier)
      expect(await db.catalogItem.count()).toBe(sheets.items.length)
      const agreements = await db.priceAgreement.findMany({ select: { unitPriceSatang: true, validFrom: true, validTo: true, catalogItem: { select: { code: true } }, supplier: { select: { code: true } } } })
      expect(new Map(agreements.map((a) => [a.catalogItem.code, `${a.supplier.code} ${a.unitPriceSatang}`]))).toEqual(new Map(agreed.map((i) => [i.code!, `${i.agreementSupplier} ${amountToSatang(i.agreedUnitPrice!)}`])))
      const year = clock.now.toISOString().slice(0, 4)
      for (const a of agreements) expect([a.validFrom.toISOString().slice(0, 10), a.validTo.toISOString().slice(0, 10)]).toEqual([`${year}-01-01`, `${Number(year) + 1}-01-01`])
      expect(await db.event.count({ where: { type: 'catalog_item.created' } })).toBe(sheets.items.length)
      expect(await db.event.count({ where: { type: 'price_agreement.created' } })).toBe(agreed.length)
      // Every line of the history is a row of Items (its item column), so every line points at its item
      const lines = await db.requestLine.findMany({ select: { description: true, catalogItem: { select: { nameTh: true } } } })
      expect(lines.length).toBeGreaterThan(0)
      for (const l of lines) expect(l.catalogItem?.nameTh, l.description).toBe(l.description)
      // A second run adds nothing
      const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
      expect(await seedCatalog(organizationId, parseCatalogItems(workbook), clock.now)).toEqual({ items: 0, agreements: 0 })
    })

    it('[FR-DOA-101/AC1] S6-11: the ceo reads the price reference of the SUB-010 contract waiting for them — two approved POs at 260.00, too few samples; its requester is refused', async () => {
      const db = forTenant(organizationId)
      const row = sheets.history.find((h) => h.itemCode === 'SUB-010' && h.status === 'PENDING_APPROVAL')!
      const request = await db.request.findFirstOrThrow({ where: { title: row.title }, select: { id: true, requesterMemberId: true } })
      const task = await db.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: request.id } } }, select: { assigneeMemberId: true } })
      const ceo = await db.member.findFirstOrThrow({ where: { employeeCode: 'ceo' }, select: { id: true } })
      expect(task.assigneeMemberId).toBe(ceo.id)
      const asMember = (memberId: string) => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now: clock.now })
      const ref = await getPriceReference(asMember(ceo.id), { requestId: request.id })
      if (!ref.ok) throw new Error(JSON.stringify(ref.error))
      const earlier = sheets.history.filter((h) => h.itemCode === 'SUB-010' && h.status === 'COMPLETED')
      expect(ref.data.lines[0]).toMatchObject({ count: earlier.length, medianSatang: amountToSatang(row.unitPrice!).toString(), status: earlier.length < 3 ? 'FEW_SAMPLES' : 'OK', deviationBp: 0, alert: null })
      expect(ref.data.lines[0]!.key).toMatch(/^item:/)
      expect(await getPriceReference(asMember(request.requesterMemberId), { requestId: request.id })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    })

    it('[FR-INT-101/AC2] [FR-INT-101/AC3] S6-12: the security service of ga_02 is reminded once at 30 days though the job runs twice, and renewing it drafts that line again', async () => {
      const db = forTenant(organizationId)
      const row = sheets.history.find((h) => h.requester === 'ga_02' && h.serviceEndInDays === '30')!
      const request = await db.request.findFirstOrThrow({ where: { title: row.title }, select: { id: true, requesterMemberId: true, lines: { select: { id: true, description: true, quantity: true } } } })
      const line = request.lines[0]!
      // The phase-1 organization has no module CONTRACTS: the reminders need none
      expect(await db.orgModule.count({ where: { module: 'CONTRACTS', enabled: true } })).toBe(0)
      await runRenewalReminders(organizationId, clock.now)
      await runRenewalReminders(organizationId, new Date(clock.now.getTime() + 60 * 60 * 1000))
      const reminded = await db.event.findMany({ where: { type: 'request.renewal_reminded', aggregateId: request.id }, select: { data: true } })
      expect(reminded.map((e) => e.data)).toEqual([expect.objectContaining({ requestLineId: line.id, milestone: 30 })])
      expect(await db.notification.count({ where: { templateKey: 'request.renewal_due', recipientMemberId: request.requesterMemberId, subjectId: request.id } })).toBe(1)
      const asRequester = makeCtx({ organizationId, actor: { type: 'USER', memberId: request.requesterMemberId }, channel: 'WEB', now: clock.now })
      const renewed = await renewRequestLine(asRequester, { requestLineId: line.id }, { idempotencyKey: randomUUID(), sender: null })
      if (!renewed.ok) throw new Error(JSON.stringify(renewed.error))
      const draft = await db.request.findUniqueOrThrow({ where: { id: renewed.data.requestId }, select: { status: true, renewalOfRequestLineId: true, sourceRequestId: true, lines: { select: { description: true, quantity: true, serviceEndDate: true } } } })
      expect(draft).toMatchObject({ status: 'DRAFT', renewalOfRequestLineId: line.id, sourceRequestId: request.id, lines: [{ description: line.description, serviceEndDate: null }] })
      expect(draft.lines[0]!.quantity.toString()).toBe(line.quantity.toString())
      expect(await db.event.findFirst({ where: { type: 'request.drafted', aggregateId: renewed.data.requestId } })).toMatchObject({ data: { source: 'RENEWAL' } })
    })

    it('[FR-INT-103/AC3] S6-13: the split pair of fm_p02 and the duplicate pair of se_p06a carry their flags after the seed, made by the submit itself', async () => {
      const db = forTenant(organizationId)
      const idOf = async (ref: string) => (await db.request.findFirstOrThrow({ where: { title: sheets.history.find((h) => h.ref === ref)!.title }, select: { id: true } })).id
      const pairOf = (requester: string, item: string) => sheets.history.filter((h) => h.requester === requester && h.itemCode === item).sort((a, b) => Number(b.daysAgo) - Number(a.daysAgo))
      const [splitFirst, splitSecond] = pairOf('fm_p02', 'MAT-011')
      const [dupFirst, dupSecond] = pairOf('se_p06a', 'MAT-014')
      expect(await db.requestFlag.findMany({ where: { requestId: await idOf(splitSecond!.ref!) }, select: { kind: true, matchedRequestIds: true } })).toEqual([{ kind: 'SPLIT', matchedRequestIds: [await idOf(splitFirst!.ref!)] }])
      const duplicate = await db.requestFlag.findFirstOrThrow({ where: { requestId: await idOf(dupSecond!.ref!), kind: 'DUPLICATE' }, select: { matchedRequestIds: true, acknowledgedReason: true } })
      expect(duplicate.matchedRequestIds).toEqual([await idOf(dupFirst!.ref!)])
      expect(duplicate.acknowledgedReason).toBeTruthy()
    })

    it('[FR-BUD-103/AC1] S6-15: fin_bud1 sends 300,000.00 from a line of the operations side to another line, and vp_ops approves it under BT-02', async () => {
      const db = forTenant(organizationId)
      const member = async (code: string) => (await db.member.findFirstOrThrow({ where: { employeeCode: code }, select: { id: true } })).id
      const [finBud1, vpOps] = await Promise.all([member('fin_bud1'), member('vp_ops')])
      // A line of a department under OPS (whose VP is vp_ops) with 300,000.00 free, in the fiscal year of the seed's day
      const departments = await db.department.findMany({ select: { id: true, code: true, parentId: true } })
      const under = new Set(departments.filter((d) => d.code === 'OPS').map((d) => d.id))
      for (let grew = true; grew; ) {
        grew = false
        for (const d of departments) {
          if (d.parentId && under.has(d.parentId) && !under.has(d.id)) {
            under.add(d.id)
            grew = true
          }
        }
      }
      const day = new Date(`${clock.now.toISOString().slice(0, 10)}T00:00:00Z`)
      const year = await db.fiscalYear.findFirstOrThrow({ where: { startsOn: { lte: day }, endsOn: { gte: day } }, select: { id: true } })
      const lines = await db.budgetLine.findMany({ where: { fiscalYearId: year.id, status: 'OPEN' }, select: { id: true, departmentId: true, balance: { select: { availableSatang: true } } }, orderBy: { code: 'asc' } })
      const from = lines.find((l) => under.has(l.departmentId) && (l.balance?.availableSatang ?? 0n) >= 30_000_000n)!
      const to = lines.find((l) => l.id !== from.id)!
      const asMember = (memberId: string) => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now: clock.now })
      const once = () => ({ idempotencyKey: randomUUID(), sender: null })
      const created = await createBudgetTransfer(asMember(finBud1), { kind: 'TRANSFER', fromBudgetLineId: from.id, toBudgetLineId: to.id, amount: '300000.00', reason: 'ย้ายงบไปแผนกที่ใช้มากกว่า' }, once())
      if (!created.ok) throw new Error(JSON.stringify(created.error))
      const sent = await submitBudgetTransfer(asMember(finBud1), { transferId: created.data.transferId }, once())
      if (!sent.ok) throw new Error(JSON.stringify(sent.error))
      const task = await db.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: created.data.transferId } } }, select: { id: true, assigneeMemberId: true, step: { select: { route: { select: { ruleCode: true } } } } } })
      expect([task.step.route.ruleCode, task.assigneeMemberId]).toEqual(['BT-02', vpOps])
      await stepUpForTask(task.id, vpOps)
      const decided = await decideTask(asMember(vpOps), { taskId: task.id, decision: 'APPROVE' }, once())
      if (!decided.ok) throw new Error(JSON.stringify(decided.error))
      expect(await db.budgetTransfer.findUniqueOrThrow({ where: { id: created.data.transferId }, select: { status: true } })).toEqual({ status: 'APPROVED' })
      expect((await db.budgetLine.findUniqueOrThrow({ where: { id: to.id }, select: { plannedSatang: true } })).plannedSatang).toBeGreaterThanOrEqual(30_000_000n)
    })

    it('[FR-VIS-101/AC1] S6-20: the workflow reports find the request of pm_p07 waiting at the CEO as a bottleneck, and the split pair of fm_p02 outside DOA', async () => {
      const db = forTenant(organizationId)
      const pm = await db.member.findFirstOrThrow({ where: { employeeCode: 'pm_p07' }, select: { id: true } })
      const waiting = await db.approvalTask.findMany({ where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST', status: 'ACTIVE' } } }, select: { id: true, resolvedFrom: true, step: { select: { route: { select: { subjectId: true } } } } } })
      const pmRequests = new Set((await db.request.findMany({ where: { requesterMemberId: pm.id, status: 'PENDING_APPROVAL' }, select: { id: true } })).map((r) => r.id))
      const pmAtCeo = waiting.filter((t) => pmRequests.has(t.step.route.subjectId) && t.resolvedFrom.includes('CEO'))
      expect(pmAtCeo.length).toBeGreaterThan(0)
      const report = await db.$transaction((tx) => computeWorkflowReport(tx, organizationId, { from: new Date(clock.now.getTime() - 400 * MS_PER_DAY), to: new Date(clock.now.getTime() + MS_PER_DAY), now: clock.now }, null))
      const ceo = report.bottlenecks.byPosition.find((x) => x.at.startsWith('CEO@'))!
      expect(ceo.taskIds).toEqual(expect.arrayContaining(pmAtCeo.map((t) => t.id)))
      expect(ceo.overdue).toBeGreaterThan(0)
      const fm = await db.member.findFirstOrThrow({ where: { employeeCode: 'fm_p02' }, select: { id: true } })
      const split = await db.requestFlag.findFirstOrThrow({ where: { kind: 'SPLIT', request: { requesterMemberId: fm.id } }, select: { requestId: true } })
      expect(report.wrongDoa).toContainEqual(expect.objectContaining({ reason: 'SPLIT', subjectId: split.requestId }))
    })

    it('leaves a history made in full alone when the seed runs again', async () => {
      const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
      const again = await seedDemoHistory(organizationId, parseHistory(workbook), clock.now, { pin: PIN, budgetKeys: budgetKeyLines(parseBudget(workbook)) })
      expect(again.seeded).toBe(false)
      // The seeded requests (a renewal drafted by a test above has its source request)
      expect(await prisma.request.count({ where: { organizationId, sourceRequestId: null } })).toBe(sheets.history.length)
    })

    it('[FR-BUD-104/AC2] [FR-BUD-104/AC3] S6-18: MKT-OPEX is alerted after the seed when its use reached 80%, once — the job run again alerts nothing', async () => {
      const db = forTenant(organizationId)
      const day = new Date(`${clock.now.toISOString().slice(0, 10)}T00:00:00Z`)
      const line = await db.budgetLine.findFirstOrThrow({ where: { code: { startsWith: 'MKT-OPEX' }, fiscalYear: { startsOn: { lte: day }, endsOn: { gte: day } } }, select: { id: true } })
      const first = await runBudgetAlerts(organizationId, clock.now)
      const raised = await db.event.findMany({ where: { type: 'budget.alert_raised', aggregateId: line.id }, select: { data: true } })
      const used = (await db.budgetLine.findUniqueOrThrow({ where: { id: line.id }, select: { plannedSatang: true, balance: { select: { committedSatang: true, actualSatang: true } } } }))
      const usedBp = Number(((used.balance!.committedSatang + used.balance!.actualSatang) * 10_000n) / used.plannedSatang)
      // Late in the year (8,666 bp used at this seed) USED_8000 is raised; early in the next year (633 bp) nothing is due
      if (usedBp >= 8000) {
        expect(first.ok).toBe(true)
        expect(raised.map((e) => (e.data as { alert: string }).alert)).toContain('USED_8000')
      } else expect(raised).toEqual([])
      const again = await runBudgetAlerts(organizationId, new Date(clock.now.getTime() + MS_PER_DAY))
      expect(again.ok).toBe(false)
      expect(await db.event.count({ where: { type: 'budget.alert_raised', aggregateId: line.id } })).toBe(raised.length)
    })

    // After the re-seed check above: this scene adds a request of its own
    it('[FR-BUD-101/AC1] [FR-BUD-101/AC2] S6-16: mkt_01 asks over budget on MKT-OPEX, the cfo approves under OB-02, the request goes to the ceo with G-4 at 0, and a rejection takes the amount back out', async () => {
      const db = forTenant(organizationId)
      const member = async (code: string) => (await db.member.findFirstOrThrow({ where: { employeeCode: code }, select: { id: true } })).id
      const [mkt01, cfo, ceo] = await Promise.all([member('mkt_01'), member('cfo'), member('ceo')])
      const asMember = (memberId: string) => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now: clock.now })
      const once = () => ({ idempotencyKey: randomUUID(), sender: null })
      const done = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
        if (!r.ok) throw new Error(JSON.stringify(r.error))
        return r.data
      }
      const day = new Date(`${clock.now.toISOString().slice(0, 10)}T00:00:00Z`)
      const line = await db.budgetLine.findFirstOrThrow({ where: { code: { startsWith: 'MKT-OPEX' }, fiscalYear: { startsOn: { lte: day }, endsOn: { gte: day } } }, select: { id: true, plannedSatang: true, balance: { select: { availableSatang: true } } } })
      const before = { planned: line.plannedSatang, available: line.balance!.availableSatang }
      // The launch event of 185,000.00 on a line left under 10% (more than 50,000.00 short, so OB-02); a line with more
      // left at this clock asks 60,000.00 above it, still OB-02
      const price = before.available < 13_500_000n ? 18_500_000n : before.available + 6_000_000n
      const unitPrice = `${price / 100n}.${String(price % 100n).padStart(2, '0')}`
      const draft = done(await createDraft(asMember(mkt01), { requestTypeCode: 'BUY_GOODS', title: 'ค่าจัดงานเปิดตัวโครงการ', budgetLineId: line.id, lines: [{ description: 'ค่าจัดงานเปิดตัวโครงการ', quantity: '1', uom: 'งาน', unitPrice }] }, once()))
      for (let i = 0; i < 3; i++) {
        const file = await prisma.fileObject.create({ data: { organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: `quote-${i + 1}.pdf`, mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: mkt01 } })
        await prisma.fileLink.create({ data: { organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
      }
      expect(await submitRequest(asMember(mkt01), { requestId: draft.requestId }, once())).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT' } })
      const asked = done(await submitBudgetOverrun(asMember(mkt01), { requestId: draft.requestId, reason: 'งานเปิดตัวโครงการใหม่ต้องจัดในไตรมาสนี้' }, once()))
      const obTask = await db.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: asked.overrunId } } }, select: { id: true, assigneeMemberId: true, step: { select: { route: { select: { ruleCode: true, amountSatang: true } } } } } })
      expect([obTask.step.route.ruleCode, obTask.assigneeMemberId, obTask.step.route.amountSatang]).toEqual(['OB-02', cfo, price - before.available])
      await stepUpForTask(obTask.id, cfo)
      done(await decideTask(asMember(cfo), { taskId: obTask.id, decision: 'APPROVE' }, once()))
      // Sent with the overrun: the normal route, PR-03 to the ceo, and a budget check that passes
      done(await submitRequest(asMember(mkt01), { requestId: draft.requestId }, once()))
      const submitted = await db.event.findFirstOrThrow({ where: { type: 'request.submitted', aggregateId: draft.requestId }, select: { data: true } })
      const check = (submitted.data as { budgetCheck: { availableSatang: string; reservedSatang: string } }).budgetCheck
      expect(BigInt(check.availableSatang) >= BigInt(check.reservedSatang)).toBe(true)
      const from = new Date(clock.now.getTime() - 60_000)
      const kpi = await db.$transaction((tx) => computeKpis(tx, organizationId, { from, to: new Date(clock.now.getTime() + MS_PER_DAY), now: clock.now }, null))
      expect(kpi.g4.tasksOnFailedBudgetCheck).toBe(0)
      const prTask = await db.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', assigneeMemberId: ceo, step: { route: { subjectId: draft.requestId } } }, select: { id: true, step: { select: { route: { select: { ruleCode: true } } } } } })
      expect(prTask.step.route.ruleCode).toBe('PR-03')
      // The ceo does not approve: what was funded leaves MKT-OPEX in the same transaction (BR-BUD-18)
      await stepUpForTask(prTask.id, ceo)
      done(await decideTask(asMember(ceo), { taskId: prTask.id, decision: 'REJECT', reason: 'เลื่อนงานเปิดตัวไปไตรมาสหน้า' }, once()))
      const after = await db.budgetLine.findUniqueOrThrow({ where: { id: line.id }, select: { plannedSatang: true, balance: { select: { availableSatang: true } } } })
      expect({ planned: after.plannedSatang, available: after.balance!.availableSatang }).toEqual(before)
    })
  })
}
