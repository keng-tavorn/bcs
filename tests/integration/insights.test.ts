import { execSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import { toMoneyDto } from '@/core/money/dto'
import { loadPrincipal, scopesFor, type Principal } from '@/server/authz'
import { makeCtx, type Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { seedBudget } from '@/server/seed/budget'
import { seedDevPins } from '@/server/seed/pins'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { parseBudget, parseDemoHistory, parseSites, parseSuppliers } from '@/server/seed/sheets'
import { seedSuppliers } from '@/server/seed/suppliers'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { loadInputWorkbook } from '@/server/seed/workbook'
import { budgetDashboard } from '@/server/services/budget/dashboard'
import { seedDemoHistory } from '@/server/services/demo-history'
import { periodOf } from '@/server/services/reports'
import { reportScope } from '@/server/services/reports/access'
import { INSIGHT_LISTS, insightsList, insightsView, weeksEnding, type InsightsDto, type InsightsParams } from '@/server/services/reports/insights'
import { collectKpis } from '@/server/services/reports/kpi'

// S16-08 · the executive summary /insights (FR-VIS-007) on the organization `pnpm db:seed` makes — every user of sheet
// Users, the budget, the suppliers and the requests, POs, receipts and decisions of Demo_History made through the real
// services. The figures are compared with the KPI view (collectKpis, §11.4) and the budget dashboard (§11.2) over the
// same period and scope, and with sums the test makes itself; every list behind a figure must be as long as the figure;
// and every seed member gets exactly the cards whose lists they may open (AC4).

const NOW = new Date('2026-09-28T03:00:00Z')
const TODAY = '2026-09-28'
const ORG_CODE = 'INSIGHTS-SCOPE'
const PASSWORD = 'insights-test-password-0001'
const TOTP_KEY = 'insights-test-totp-key-000000000001'
const PIN = '739164'

interface Member {
  readonly id: string
  readonly code: string
  readonly principal: Principal
  readonly ctx: Ctx
}

let organizationId: string
let members: Member[]

const ctxAt = (memberId: string): Ctx => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now: NOW })
const roles = (m: Member) => (m.principal.kind === 'member' ? m.principal.roles : new Set<string>())
const heads = (m: Member) => (m.principal.kind === 'member' ? m.principal.headOfDepartmentIds : new Set<string>())

async function view(m: Member, params: InsightsParams = {}): Promise<InsightsDto> {
  const result = await insightsView(m.ctx, params)
  if (!result.ok) throw new Error(`insights refused ${m.code}: ${result.error.code}`)
  return result.data
}

async function kpis(from: string, to: string, departmentIds: readonly string[] | null) {
  return forTenant(organizationId).$transaction((tx) => collectKpis(tx, organizationId, { ...periodOf({ from, to }), now: NOW }, departmentIds))
}

/** The figure each list stands behind, read off the cards */
function figureOf(d: InsightsDto, list: string): number | null {
  const figures: Record<string, number | null> = {
    spend: d.spend?.poCount ?? null,
    'price-alerts': d.spend?.priceAlerts ?? null,
    budget: d.budget?.lineCount ?? null,
    'budget-low': d.budget?.lowLines ?? null,
    'submit-to-po': d.speed.submitToPoCount,
    'decision-time': d.speed.decisionCount,
    overdue: d.speed.overdue,
    'idle-pos': d.speed.idlePos,
    'doa-ref': d.control.withDoa,
    'doa-missing': d.control.withoutDoa,
    'over-budget': d.control.overBudget,
    channel: d.control.decisions,
    'supplier-changes': d.control.supplierChanges,
  }
  return figures[list] ?? null
}

/** The card figures agree with the KPI view of the same period and departments */
async function expectSameAsKpiView(d: InsightsDto, departmentIds: readonly string[] | null) {
  const { result } = await kpis(d.filters.from, d.filters.to, departmentIds)
  expect(d.control.withDoa).toBe(result.g2.withDoaReference.numerator)
  expect(d.control.decisions).toBe(result.g2.withDoaReference.denominator)
  expect(d.speed.submitToPoMedianMinutes).toBe(result.g3.submitToPoMedianMinutes)
  expect(d.speed.decisionMedianMinutes).toBe(result.g3.decisionMedianMinutes)
  expect(d.control.overBudget).toBe(result.g4.tasksOnFailedBudgetCheck)
  const mobile = d.control.channels.filter((c) => c.channel === 'LIFF' || c.channel === 'LINE_CHAT').reduce((n, c) => n + c.count, 0)
  expect(mobile).toBe(result.g5.total.numerator)
  expect(d.control.channels.reduce((n, c) => n + c.count, 0)).toBe(result.g5.total.denominator)
}

beforeAll(async () => {
  execSync('pnpm exec tsx scripts/storage-init.ts', { stdio: 'ignore' })
  const workbook = await loadInputWorkbook()
  await seedTaxRates()
  const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const users = input.users.map((u) => ({ ...u, email: `insights.${u.email}` }))
  const org = await seedDemoOrganization({ ...input, org: { ...input.org, code: ORG_CODE }, users }, { password: PASSWORD, totpKey: TOTP_KEY, now: NOW })
  organizationId = org.organizationId
  await seedOrgStructure(organizationId, users, parseOrgStructureInput(workbook), NOW)
  await seedBudget(organizationId, parseBudget(workbook), NOW)
  await seedSuppliers(organizationId, { suppliers: parseSuppliers(workbook), sites: parseSites(workbook) }, NOW)
  await seedDevPins(organizationId, PIN, NOW)
  await seedDemoHistory(organizationId, parseDemoHistory(workbook), NOW, { pin: PIN })

  const db = forTenant(organizationId)
  const rows = await db.member.findMany({ where: { status: 'ACTIVE' }, select: { id: true, employeeCode: true }, orderBy: { employeeCode: 'asc' } })
  members = await Promise.all(
    rows.map(async (m) => {
      const ctx = ctxAt(m.id)
      return { id: m.id, code: m.employeeCode ?? m.id, ctx, principal: await db.$transaction((tx) => loadPrincipal(tx, ctx)) }
    })
  )
}, 900_000)

const executive = () => members.find((m) => roles(m).has('EXECUTIVE'))!
const departmentHead = () => members.find((m) => heads(m).size > 0 && reportScope(m.principal) !== null && reportScope(m.principal) !== 'NONE')!

describe('[FR-VIS-007/AC3] every figure agrees with the KPI view and the budget dashboard, on data whose answers are known', () => {
  it('the seed has something to count in 90 days: decisions on several channels, POs approved and budget used', async () => {
    const d = await view(executive(), { range: '90d' })
    expect(d.filters).toMatchObject({ range: '90d', to: TODAY })
    expect(d.control.decisions).toBeGreaterThan(5)
    expect(d.control.channels.filter((c) => c.count > 0).length).toBeGreaterThan(1)
    expect(d.spend!.poCount).toBeGreaterThan(0)
    expect(d.budget!.total.usedBp).toBeGreaterThan(0)
  })

  it('control and speed equal G-2 (b), G-3 (1) (2), G-4 and G-5 of the KPI view — for the organization, for 30 and 90 days', async () => {
    for (const range of ['30d', '90d'] as const) await expectSameAsKpiView(await view(executive(), { range }), null)
  })

  it('the budget card is the budget dashboard of the same fiscal year, satang for satang, in all and per department', async () => {
    const d = await view(executive(), { range: '30d' })
    const dash = await budgetDashboard(executive().ctx)
    if (!dash.ok) throw new Error(dash.error.code)
    expect(d.budget!.fiscalYearCode).toBe(dash.data.fiscalYear!.code)
    expect(d.budget!.total).toEqual(dash.data.total)
    expect(d.budget!.lineCount).toBe(dash.data.lines.length)
    expect(d.budget!.lowLines).toBe(dash.data.lines.filter((l) => l.low).length)
    for (const dept of dash.data.departments) {
      const { id, code, nameTh, nameEn, ...figures } = dept
      expect(d.budget!.byDepartment.find((x) => x.id === id), code).toMatchObject({ id, code, nameTh, nameEn, ...figures })
    }
  })

  it('spending is the POs approved in the period and not cancelled, before VAT, added up by the department of each line', async () => {
    const d = await view(executive(), { range: '90d' })
    const { from, to } = periodOf({ from: d.filters.from, to: d.filters.to })
    const pos = await forTenant(organizationId).purchaseOrder.findMany({
      where: { approvedAt: { gte: from, lt: to }, status: { not: 'CANCELLED' } },
      select: { netSatang: true, lines: { select: { netSatang: true, budgetLine: { select: { departmentId: true } } } } },
    })
    expect(d.spend!.poCount).toBe(pos.length)
    expect(d.spend!.total).toEqual(toMoneyDto(pos.reduce((n, p) => n + p.netSatang, 0n)))
    const byDept = new Map<string, bigint>()
    for (const l of pos.flatMap((p) => p.lines)) byDept.set(l.budgetLine.departmentId, (byDept.get(l.budgetLine.departmentId) ?? 0n) + l.netSatang)
    expect(new Map(d.spend!.byDepartment.map((x) => [x.id, BigInt(x.netSatang)]))).toEqual(new Map([...byDept].filter(([, n]) => n !== 0n)))
  })

  it('every list is as long as the figure that opens it, and the week medians add up to the period’s tasks', async () => {
    for (const m of [executive(), departmentHead()]) {
      const d = await view(m, { range: '90d' })
      for (const list of INSIGHT_LISTS) {
        const figure = figureOf(d, list)
        const result = await insightsList(m.ctx, { range: '90d' }, list)
        if (figure === null) {
          expect(result.ok, `${m.code} · ${list}`).toBe(false)
          continue
        }
        if (!result.ok) throw new Error(`${m.code} · ${list}: ${result.error.code}`)
        expect(result.data.total, `${m.code} · ${list}`).toBe(figure)
      }
      for (const c of d.control.channels) {
        const result = await insightsList(m.ctx, { range: '90d', channel: c.channel }, 'channel')
        expect(result.ok && result.data.total, `${m.code} · ${c.channel}`).toBe(c.count)
      }
      for (const w of d.speed.weekly) {
        const result = await insightsList(m.ctx, { range: '90d', week: w.start }, 'decision-time')
        expect(result.ok && result.data.total, `${m.code} · week ${w.start}`).toBe(w.count)
      }
    }
  })

  it('the weeks run Monday to Sunday in Thai time, twelve of them, the last holding the end of the period', () => {
    const weeks = weeksEnding(TODAY)
    expect(weeks).toHaveLength(12)
    expect(weeks.at(-1)!.start).toBe('2026-09-28')
    expect(weeks[0]!.start).toBe('2026-07-13')
    expect(weeks[0]!.from.toISOString()).toBe('2026-07-12T17:00:00.000Z')
    expect(weeksEnding('2026-09-27').at(-1)!.start).toBe('2026-09-21')
  })
})

describe('[FR-VIS-007/AC1] the filters live in the address: the same link gives the same view', () => {
  it('reads the period, the department and the type from the parameters, and the same parameters give the same figures', async () => {
    const ceo = executive()
    const ninety = await view(ceo, { range: '90d' })
    expect(ninety.filters).toEqual({ range: '90d', from: '2026-07-01', to: TODAY, departmentId: null, requestTypeId: null })
    const dept = ninety.options.departments.find((x) => ninety.spend!.byDepartment.some((s) => s.id === x.id))!
    const params = { range: '90d', dept: dept.id, type: ninety.options.requestTypes[0]!.id }
    const once = await view(ceo, params)
    const again = await view(ceo, params)
    expect(once.filters).toEqual({ range: '90d', from: '2026-07-01', to: TODAY, departmentId: dept.id, requestTypeId: ninety.options.requestTypes[0]!.id })
    expect({ ...again, asOf: null }).toEqual({ ...once, asOf: null })
  })

  it('a department filter gives the KPI view of that department, and spending of its lines only', async () => {
    const ceo = executive()
    const all = await view(ceo, { range: '90d' })
    for (const dept of all.options.departments) {
      const d = await view(ceo, { range: '90d', dept: dept.id })
      await expectSameAsKpiView(d, [dept.id])
      expect(d.spend!.byDepartment.every((x) => x.id === dept.id)).toBe(true)
      expect(d.budget!.byDepartment.every((x) => x.id === dept.id)).toBe(true)
    }
  })

  it('chosen days, this fiscal year, and an impossible period that falls back to 30 days and says so', async () => {
    const ceo = executive()
    expect((await view(ceo, { range: 'custom', from: '2026-08-01', to: '2026-08-31' })).filters).toMatchObject({ range: 'custom', from: '2026-08-01', to: '2026-08-31' })
    const fy = await view(ceo, { range: 'fy' })
    expect(fy.filters.range).toBe('fy')
    expect(fy.filters.from <= TODAY && fy.filters.to === TODAY).toBe(true)
    const bad = await view(ceo, { range: 'custom', from: '2026-09-30', to: '2026-09-01' })
    expect(bad.periodInvalid).toBe(true)
    expect(bad.filters).toMatchObject({ range: '30d', from: '2026-08-30', to: TODAY })
  })
})

describe('[FR-VIS-007/AC4] each seed member gets the page, and each card, only when they may open its lists', () => {
  it('has members of every kind to try: organization readers, department heads, members without report.view', () => {
    expect(members.some((m) => reportScope(m.principal) === null)).toBe(true)
    expect(members.some((m) => Array.isArray(reportScope(m.principal)))).toBe(true)
    expect(members.some((m) => reportScope(m.principal) === 'NONE')).toBe(true)
    expect(members.some((m) => reportScope(m.principal) === null && !scopesFor(m.principal, 'budget.view').has('ORG'))).toBe(true)
  })

  it('for every member: refused without report.view; spending and idle POs with po.view over the organization; budget with budget.view; a head reads the departments they head', async () => {
    for (const m of members) {
      const scope = reportScope(m.principal)
      const result = await insightsView(m.ctx, { range: '90d' })
      if (scope === 'NONE') {
        expect(result.ok, m.code).toBe(false)
        if (!result.ok) expect(result.error.code, m.code).toBe('FORBIDDEN')
        const list = await insightsList(m.ctx, { range: '90d' }, 'doa-ref')
        expect(list.ok, m.code).toBe(false)
        continue
      }
      if (!result.ok) throw new Error(`${m.code}: ${result.error.code}`)
      const d = result.data
      const orgPos = scopesFor(m.principal, 'po.view').has('ORG')
      const budgetScopes = scopesFor(m.principal, 'budget.view')
      const seesBudget = budgetScopes.has('ORG') || (budgetScopes.has('DEPT') && heads(m).size > 0)
      expect(d.spend !== null, `${m.code} spending`).toBe(orgPos)
      expect(d.speed.idlePos !== null, `${m.code} idle POs`).toBe(orgPos)
      expect(d.budget !== null, `${m.code} budget`).toBe(seesBudget)
      expect(d.scope, m.code).toBe(scope === null ? 'ORG' : 'DEPT')
      if (scope !== null) {
        expect(d.options.departments.map((x) => x.id).sort(), m.code).toEqual([...scope].sort())
        await expectSameAsKpiView(d, scope)
        if (d.budget) expect(d.budget.byDepartment.every((x) => scope.includes(x.id)), m.code).toBe(true)
      }
      for (const list of ['spend', 'price-alerts', 'idle-pos'] as const) expect((await insightsList(m.ctx, { range: '90d' }, list)).ok, `${m.code} · ${list}`).toBe(orgPos)
      for (const list of ['budget', 'budget-low'] as const) expect((await insightsList(m.ctx, { range: '90d' }, list)).ok, `${m.code} · ${list}`).toBe(seesBudget)
    }
  })

  it('a head who opens a link filtered to another department reads their own departments, and the page says the filter was left out', async () => {
    const head = departmentHead()
    const other = (await view(executive())).options.departments.find((x) => !heads(head).has(x.id))!
    const d = await view(head, { range: '90d', dept: other.id })
    expect(d.ignored).toEqual(['department'])
    expect(d.filters.departmentId).toBeNull()
    await expectSameAsKpiView(d, [...heads(head)])
    const list = await insightsList(head.ctx, { range: '90d', dept: other.id }, 'doa-ref')
    expect(list.ok && list.data.filters.departmentId).toBeNull()
  })
})
