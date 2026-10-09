import { z } from 'zod'
import { THAI_TIME_ZONE } from '@/core/thai'
import { BP_PER_WHOLE } from '@/core/money/constants'
import { toMoneyDto, type MoneyDto } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { authorize, scopesFor, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { loadInsights, median, type InsightsData, type InsightsTask, type InsightsWeek } from '@/server/queries/insights'
import { addAmounts, budgetFigures, budgetLowThreshold, budgetViewScope, NO_AMOUNTS, type BudgetAmounts, type BudgetFiguresDto } from '../budget/dashboard'
import { reportScope } from './access'
import { periodOf } from './index'

// The executive summary /insights (spec §9.10, §11.5, FR-VIS-007): one row of filters kept in the address — the period
// (30 days, 90 days, this fiscal year or chosen days), a department and a request type — and four cards: spending,
// budget, speed and control, each with its main figure, one chart and what needs attention, every number opening the
// documents it counts (insightsList). Who sees what (AC4): the page follows report.view (the whole organization, or the
// departments a head heads); the budget card follows budget.view; spending, prices and idle POs need po.view over the
// organization, because their lists are POs. A card or figure whose list the reader could not open is left out, never
// shown and refused. The figures come from queries/insights.ts on the same definitions as the KPI view and the budget
// dashboard. Read only.

export const INSIGHT_RANGES = ['30d', '90d', 'fy', 'custom'] as const
export type InsightRange = (typeof INSIGHT_RANGES)[number]

/** The lists behind the figures */
export const INSIGHT_LISTS = [
  'spend',
  'price-alerts',
  'budget',
  'budget-low',
  'submit-to-po',
  'decision-time',
  'overdue',
  'idle-pos',
  'doa-ref',
  'doa-missing',
  'over-budget',
  'channel',
  'supplier-changes',
] as const
export type InsightList = (typeof INSIGHT_LISTS)[number]

/** Departments the spending chart names; the rest is one bar (§9.10) */
export const SPEND_CHART_DEPARTMENTS = 5
/** Weeks of the speed chart (§9.10) */
export const INSIGHT_WEEKS = 12
/** poIdleDays: no setting yet, the default of OQ-36 */
export const PO_IDLE_DAYS = 30 // TODO(OQ-36)
/** The channels the control chart names; any other channel is added up as "other" */
export const DECISION_CHANNELS = ['WEB', 'LIFF', 'LINE_CHAT', 'EMAIL'] as const
/** A list shows at most this many documents, the newest or the most urgent first */
export const INSIGHT_LIST_MAX = 200

const RANGE_DAYS = { '30d': 30, '90d': 90 } as const
const PERCENT_TO_BP = 100
const DAYS_PER_WEEK = 7

const DAY = z.iso.date()
const ID = z.uuid()
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export type InsightsParams = Readonly<Record<string, string | string[] | undefined>>

export interface InsightsFiltersDto {
  readonly range: InsightRange
  /** The days of the period, both counted (YYYY-MM-DD, Thai) */
  readonly from: string
  readonly to: string
  readonly departmentId: string | null
  readonly requestTypeId: string | null
}

export interface InsightsBaseDto {
  readonly filters: InsightsFiltersDto
  /** The address asked for days that cannot be a period; the period is the last 30 days instead */
  readonly periodInvalid: boolean
  /** The address asked for a department or a type the reader cannot choose; the filter was left out */
  readonly ignored: ReadonlyArray<'department' | 'type'>
  /** ORG: the whole organization · DEPT: the departments the reader heads */
  readonly scope: 'ORG' | 'DEPT'
  readonly options: {
    readonly departments: ReadonlyArray<{ readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null }>
    readonly requestTypes: ReadonlyArray<{ readonly id: string; readonly nameTh: string; readonly nameEn: string | null }>
  }
  readonly asOf: string
}

export interface DepartmentAmountDto {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
}

export interface InsightsDto extends InsightsBaseDto {
  /** null: the reader has no po.view over the organization */
  readonly spend: {
    readonly total: MoneyDto
    readonly poCount: number
    /** Every department with spending, the largest first */
    readonly byDepartment: ReadonlyArray<DepartmentAmountDto & { readonly net: MoneyDto; readonly netSatang: string }>
    /**
     * The chart: the first five departments and the rest added up as one bar (department null), each bar's length its
     * share of the longest in basis points, for drawing only
     */
    readonly chart: ReadonlyArray<{ readonly department: DepartmentAmountDto | null; readonly net: MoneyDto; readonly barBp: number }>
    readonly priceAlerts: number
    readonly alertPct: number
  } | null
  /** null: the reader has no budget.view over the scope, or no fiscal year covers the end of the period */
  readonly budget: {
    readonly fiscalYearCode: string
    readonly asOf: string
    readonly lowPct: number
    readonly total: BudgetFiguresDto
    readonly byDepartment: ReadonlyArray<DepartmentAmountDto & BudgetFiguresDto & { readonly reservedBp: number; readonly committedBp: number; readonly actualBp: number }>
    /** How long the chart's axis needs to be: 100 %, or more when a department holds more than it planned (basis points) */
    readonly chartMaxBp: number
    readonly lineCount: number
    readonly lowLines: number
    /** The request type filter does not apply to budget lines */
    readonly typeIgnored: boolean
  } | null
  readonly speed: {
    readonly submitToPoMedianMinutes: number | null
    readonly submitToPoCount: number
    readonly decisionMedianMinutes: number | null
    readonly decisionCount: number
    readonly weekly: ReadonlyArray<{ readonly start: string; readonly medianMinutes: number | null; readonly count: number }>
    readonly overdue: number
    /** null: the reader has no po.view over the organization */
    readonly idlePos: number | null
    readonly idleDays: number
  }
  readonly control: {
    readonly decisions: number
    readonly withDoa: number
    readonly withoutDoa: number
    readonly overBudget: number
    readonly channels: ReadonlyArray<{ readonly channel: (typeof DECISION_CHANNELS)[number] | 'OTHER'; readonly count: number }>
    readonly supplierChanges: number
  }
}

export interface InsightItemDto {
  readonly key: string
  readonly document: { readonly type: 'REQUEST' | 'PURCHASE_ORDER' | 'VARIANCE' | 'DOA_VERSION' | 'ORG_AUTHORITY_CHANGE' | 'BUDGET_LINE' | 'SUPPLIER'; readonly id: string; readonly label: string; readonly poId: string | null } | null
  /** Who decided, who holds the task, or who asked */
  readonly person: { readonly nameTh: string; readonly nameEn: string | null } | null
  readonly personKind: 'ASSIGNEE' | 'DECIDER' | 'REQUESTER' | null
  readonly at: string | null
  /** What `at` is */
  readonly atKind: 'DECIDED' | 'ASSIGNED' | 'APPROVED' | 'FIRST_PO' | 'LAST_ACTIVITY' | 'CHANGED' | null
  readonly dueAt: string | null
  readonly amount: MoneyDto | null
  readonly minutes: number | null
  readonly channel: string | null
  /** A budget line's figures (the budget lists) */
  readonly budget: BudgetFiguresDto | null
  /** A supplier's registry status change */
  readonly status: { readonly from: string | null; readonly to: string } | null
  readonly mark: 'PRICE_ALERT' | 'WITH_DOA' | 'WITHOUT_DOA' | 'LOW' | null
}

export interface InsightsListDto extends InsightsBaseDto {
  readonly list: InsightList
  /** A chosen channel (list channel) or week (list decision-time), as asked */
  readonly channel: string | null
  readonly week: string | null
  readonly items: readonly InsightItemDto[]
  readonly total: number
}

// ---------- the period and the weeks ----------

function thaiDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: THAI_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** The weeks of the speed chart: Monday to Sunday in Thai time, the last one holding the end of the period (§11.5) */
export function weeksEnding(day: string, weeks = INSIGHT_WEEKS): InsightsWeek[] {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
  const monday = addDays(day, -((weekday + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK))
  return Array.from({ length: weeks }, (_, i) => {
    const start = addDays(monday, -(weeks - 1 - i) * DAYS_PER_WEEK)
    // the last week stops at the end of the period: its median and its list count nothing decided after the period
    const sunday = addDays(start, DAYS_PER_WEEK - 1)
    const { from, to } = periodOf({ from: start, to: sunday < day ? sunday : day })
    return { start, from, to }
  })
}

async function periodFromParams(tx: TenantTx, params: InsightsParams, now: Date): Promise<{ range: InsightRange; from: string; to: string; invalid: boolean }> {
  const today = thaiDay(now)
  const last = (days: number) => ({ from: addDays(today, -(days - 1)), to: today })
  const asked = one(params.range)
  const range: InsightRange = (INSIGHT_RANGES as readonly string[]).includes(asked ?? '') ? (asked as InsightRange) : '30d'
  if (range === '30d' || range === '90d') return { range, ...last(RANGE_DAYS[range]), invalid: false }
  if (range === 'fy') {
    const date = new Date(`${today}T00:00:00Z`)
    const year = await tx.fiscalYear.findFirst({ where: { startsOn: { lte: date }, endsOn: { gte: date } }, select: { startsOn: true } })
    return year ? { range, from: year.startsOn.toISOString().slice(0, 10), to: today, invalid: false } : { range: '30d', ...last(RANGE_DAYS['30d']), invalid: true }
  }
  const from = one(params.from)
  const to = one(params.to)
  if (!from || !to || !DAY.safeParse(from).success || !DAY.safeParse(to).success || from > to) return { range: '30d', ...last(RANGE_DAYS['30d']), invalid: true }
  return { range, from, to, invalid: false }
}

// ---------- who reads what ----------

interface Reader {
  readonly principal: Principal
  /** report.view: null for the whole organization, else the departments headed */
  readonly departments: readonly string[] | null
  readonly orgPos: boolean
  /** budget.view over the same departments, or null for none */
  readonly budgetDepartments: readonly string[] | null | 'NONE'
}

async function reader(tx: TenantTx, ctx: Ctx): Promise<Result<Reader>> {
  const allowed = await authorize(tx, ctx, 'report.view')
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  const scope = reportScope(allowed.data)
  if (scope === 'NONE') return err('FORBIDDEN', 'the executive summary follows report.view', { capability: 'report.view' })
  const budget = budgetViewScope(allowed.data)
  const budgetDepartments = budget === null ? 'NONE' : budget.kind === 'ORG' ? null : [...budget.departmentIds]
  return ok({ principal: allowed.data, departments: scope, orgPos: scopesFor(allowed.data, 'po.view').has('ORG'), budgetDepartments })
}

/** The departments both scopes cover (null: every department · 'NONE': none) */
function within(a: readonly string[] | null | 'NONE', b: readonly string[] | null): readonly string[] | null | 'NONE' {
  if (a === 'NONE') return 'NONE'
  if (b === null) return a
  const both = a === null ? b : a.filter((d) => b.includes(d))
  return both.length ? both : 'NONE'
}

interface Prepared {
  readonly base: InsightsBaseDto
  readonly data: InsightsData
  readonly reader: Reader
  readonly lowBp: bigint
  readonly lowPct: number
  readonly alertPct: number
  readonly fiscalYearCode: string | null
}

async function prepare(tx: TenantTx, ctx: Ctx, params: InsightsParams): Promise<Result<Prepared>> {
  const who = await reader(tx, ctx)
  if (!who.ok) return who
  const r = who.data
  const period = await periodFromParams(tx, params, ctx.now)
  const [departments, requestTypes, org, calendar, low] = await Promise.all([
    tx.department.findMany({ where: r.departments === null ? {} : { id: { in: [...r.departments] } }, select: { id: true, code: true, nameTh: true, nameEn: true }, orderBy: { code: 'asc' } }),
    tx.requestType.findMany({ where: { active: true }, select: { id: true, nameTh: true, nameEn: true }, orderBy: { code: 'asc' } }),
    tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } }),
    loadBusinessCalendar(tx, ctx.organizationId),
    budgetLowThreshold(tx, ctx.organizationId),
  ])
  const ignored: Array<'department' | 'type'> = []
  const askedDepartment = one(params.dept)
  const departmentId = askedDepartment && ID.safeParse(askedDepartment).success && departments.some((d) => d.id === askedDepartment) ? askedDepartment : null
  if (askedDepartment && !departmentId) ignored.push('department')
  const askedType = one(params.type)
  const requestTypeId = askedType && ID.safeParse(askedType).success && requestTypes.some((t) => t.id === askedType) ? askedType : null
  if (askedType && !requestTypeId) ignored.push('type')

  // the departments the figures read: the filter, else the reader's scope (a head never reads past it)
  const scopeDepartments = departmentId ? [departmentId] : r.departments
  // the budget card reads what both budget.view and the page's scope cover, then the filter: a reader's filter never
  // widens their budget.view (a head of A who reads the organization's reports never reads B's budget lines)
  const budgetDepartments = within(within(r.budgetDepartments, scopeDepartments), departmentId ? [departmentId] : null)
  const { from, to } = periodOf({ from: period.from, to: period.to })
  const endDay = new Date(`${period.to}T00:00:00Z`)
  const year = budgetDepartments === 'NONE' ? null : await tx.fiscalYear.findFirst({ where: { startsOn: { lte: endDay }, endsOn: { gte: endDay } }, select: { id: true, code: true } })
  const alertPct = OrgSettingsSchema.shape.priceAlertPct.parse((org.settings as { priceAlertPct?: unknown } | null)?.priceAlertPct)

  const data = await loadInsights(tx, {
    from,
    to,
    now: ctx.now,
    scope: { departmentIds: scopeDepartments, requestTypeId },
    calendar,
    alertBp: Math.round(alertPct * PERCENT_TO_BP),
    idleDays: PO_IDLE_DAYS,
    weeks: weeksEnding(period.to),
    budget: year && budgetDepartments !== 'NONE' ? { fiscalYearId: year.id, departmentIds: budgetDepartments } : null,
  })
  return ok({
    base: {
      filters: { range: period.range, from: period.from, to: period.to, departmentId, requestTypeId },
      periodInvalid: period.invalid,
      ignored,
      scope: r.departments === null ? 'ORG' : 'DEPT',
      options: { departments, requestTypes },
      asOf: ctx.now.toISOString(),
    },
    data,
    reader: r,
    lowBp: low.lowBp,
    lowPct: low.lowPct,
    alertPct,
    fiscalYearCode: year?.code ?? null,
  })
}

const amountsOf = (l: { planned: bigint; available: bigint; reserved: bigint; committed: bigint; actual: bigint }): BudgetAmounts => ({ planned: l.planned, available: l.available, reserved: l.reserved, committed: l.committed, actual: l.actual })

/** part ÷ whole in basis points, rounded down; 0 when nothing is planned */
const shareBp = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * BP_PER_WHOLE) / whole) : 0)

const channelOf = (channel: string): (typeof DECISION_CHANNELS)[number] | 'OTHER' => ((DECISION_CHANNELS as readonly string[]).includes(channel) ? (channel as (typeof DECISION_CHANNELS)[number]) : 'OTHER')

/** The four cards for this reader (FR-VIS-007 AC2 to AC4) */
export async function insightsView(ctx: Ctx, params: InsightsParams): Promise<Result<InsightsDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const prepared = await prepare(tx, ctx, params)
    if (!prepared.ok) return prepared
    const { base, data, reader: r, lowBp, lowPct, alertPct, fiscalYearCode } = prepared.data
    const departmentIds = unique([...data.spend.byDepartment.keys(), ...(data.budget?.lines.map((l) => l.departmentId) ?? [])])
    const departments = new Map((await tx.department.findMany({ where: { id: { in: departmentIds } }, select: { id: true, code: true, nameTh: true, nameEn: true } })).map((d) => [d.id, d]))

    const spent = [...data.spend.byDepartment].filter(([, net]) => net !== 0n).sort(([, a], [, b]) => (a === b ? 0 : a > b ? -1 : 1))
    const rest = spent.slice(SPEND_CHART_DEPARTMENTS).reduce((n, [, net]) => n + net, 0n)
    const bars = [...spent.slice(0, SPEND_CHART_DEPARTMENTS).map(([id, net]) => ({ department: departments.get(id)!, net })), ...(rest !== 0n ? [{ department: null, net: rest }] : [])]
    const longest = bars.reduce((m, b) => (b.net > m ? b.net : m), 0n)
    const spend: InsightsDto['spend'] = r.orgPos
      ? {
          total: toMoneyDto(data.spend.pos.reduce((sum, p) => sum + p.netSatang, 0n)),
          poCount: data.spend.pos.length,
          byDepartment: spent.map(([id, net]) => ({ ...departments.get(id)!, net: toMoneyDto(net), netSatang: net.toString() })),
          chart: bars.map((b) => ({ department: b.department, net: toMoneyDto(b.net), barBp: shareBp(b.net, longest) })),
          priceAlerts: data.spend.pos.filter((p) => p.priceAlert).length,
          alertPct,
        }
      : null

    let budget: InsightsDto['budget'] = null
    if (data.budget && fiscalYearCode) {
      const byDepartment = new Map<string, BudgetAmounts>()
      for (const l of data.budget.lines) byDepartment.set(l.departmentId, addAmounts(byDepartment.get(l.departmentId) ?? NO_AMOUNTS, amountsOf(l)))
      const rows = [...byDepartment].map(([id, a]) => ({ ...departments.get(id)!, ...budgetFigures(a, lowBp), reservedBp: shareBp(a.reserved, a.planned), committedBp: shareBp(a.committed, a.planned), actualBp: shareBp(a.actual, a.planned) }))
      budget = {
        fiscalYearCode,
        asOf: base.filters.to,
        lowPct,
        total: budgetFigures(data.budget.lines.map(amountsOf).reduce(addAmounts, NO_AMOUNTS), lowBp),
        byDepartment: rows.sort((a, b) => a.code.localeCompare(b.code)),
        chartMaxBp: Math.max(Number(BP_PER_WHOLE), ...rows.map((x) => x.reservedBp + x.committedBp + x.actualBp)),
        lineCount: data.budget.lines.length,
        lowLines: data.budget.lines.filter((l) => budgetFigures(amountsOf(l), lowBp).low).length,
        typeIgnored: base.filters.requestTypeId !== null,
      }
    }

    const counts = new Map<string, number>()
    for (const d of data.control.decisions) counts.set(channelOf(d.channel), (counts.get(channelOf(d.channel)) ?? 0) + 1)
    const withDoa = data.control.decisions.filter((d) => d.withDoaReference).length
    return ok({
      ...base,
      spend,
      budget,
      speed: {
        submitToPoMedianMinutes: median(data.speed.submitToPo.map((s) => s.minutes)),
        submitToPoCount: data.speed.submitToPo.length,
        decisionMedianMinutes: median(data.speed.decided.map((t) => t.minutes!)),
        decisionCount: data.speed.decided.length,
        weekly: data.speed.weekly.map((w) => ({ start: w.start, medianMinutes: median(w.tasks.map((t) => t.minutes!)), count: w.tasks.length })),
        overdue: data.speed.overdue.length,
        idlePos: r.orgPos ? data.speed.idlePos.length : null,
        idleDays: PO_IDLE_DAYS,
      },
      control: {
        decisions: data.control.decisions.length,
        withDoa,
        withoutDoa: data.control.decisions.length - withDoa,
        overBudget: data.control.overBudget.length,
        channels: [...DECISION_CHANNELS, 'OTHER' as const].map((channel) => ({ channel, count: counts.get(channel) ?? 0 })).filter((c) => c.channel !== 'OTHER' || c.count > 0),
        supplierChanges: data.control.supplierChanges.length,
      },
    })
  })
}

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]
const name = (m: { displayNameTh: string; displayNameEn: string | null } | undefined) => (m ? { nameTh: m.displayNameTh, nameEn: m.displayNameEn } : null)
const BLANK = { person: null, personKind: null, at: null, atKind: null, dueAt: null, amount: null, minutes: null, channel: null, budget: null, status: null, mark: null } as const

/** The documents behind one figure, for the same filters (FR-VIS-007 AC3): the list's length is the figure */
export async function insightsList(ctx: Ctx, params: InsightsParams, list: string): Promise<Result<InsightsListDto>> {
  if (!(INSIGHT_LISTS as readonly string[]).includes(list)) return err('NOT_FOUND', 'no such list')
  const which = list as InsightList
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const prepared = await prepare(tx, ctx, params)
    if (!prepared.ok) return prepared
    const { base, data, reader: r, lowBp } = prepared.data
    // a list whose documents the reader could not open is refused, as its figure is not shown (AC4)
    if (['spend', 'price-alerts', 'idle-pos'].includes(which) && !r.orgPos) return err('FORBIDDEN', 'these POs need po.view over the organization', { capability: 'po.view', reason: 'PO_SCOPE' })
    if (['budget', 'budget-low'].includes(which) && !data.budget) return err('FORBIDDEN', 'the budget lists follow budget.view', { capability: 'budget.view', reason: 'BUDGET_SCOPE' })
    const askedChannel = one(params.channel) ?? null
    const channel = which === 'channel' && askedChannel && ([...DECISION_CHANNELS, 'OTHER'] as readonly string[]).includes(askedChannel) ? askedChannel : null
    const askedWeek = one(params.week) ?? null
    const week = which === 'decision-time' && askedWeek ? (data.speed.weekly.find((w) => w.start === askedWeek)?.start ?? null) : null

    let tasks: readonly InsightsTask[] = []
    let decisions = data.control.decisions
    if (which === 'decision-time') {
      // one week's median opens that week's tasks, the period's median every task decided in the period
      const decided = week ? data.speed.weekly.find((w) => w.start === week)!.tasks : data.speed.decided
      tasks = [...decided].sort((a, b) => b.decidedAt!.getTime() - a.decidedAt!.getTime())
    }
    if (which === 'overdue') tasks = data.speed.overdue
    if (which === 'over-budget') tasks = data.control.overBudget
    if (which === 'doa-ref') decisions = decisions.filter((d) => d.withDoaReference)
    if (which === 'doa-missing') decisions = decisions.filter((d) => !d.withDoaReference)
    if (which === 'channel' && channel) decisions = decisions.filter((d) => channelOf(d.channel) === channel)
    const useDecisions = ['doa-ref', 'doa-missing', 'channel'].includes(which)
    if (!useDecisions) decisions = []
    if (useDecisions) decisions = [...decisions].reverse()

    const spendPos = which === 'spend' ? data.spend.pos : which === 'price-alerts' ? data.spend.pos.filter((p) => p.priceAlert) : []
    const lines = which === 'budget' || which === 'budget-low' ? (data.budget?.lines ?? []).filter((l) => which === 'budget' || budgetFigures(amountsOf(l), lowBp).low) : []
    const subjects = [
      ...tasks.map((t) => ({ type: t.subjectType, id: t.subjectId })),
      ...decisions.map((d) => ({ type: d.subjectType, id: d.subjectId })),
      ...spendPos.map((p) => ({ type: 'PURCHASE_ORDER', id: p.poId })),
      ...(which === 'idle-pos' ? data.speed.idlePos.map((p) => ({ type: 'PURCHASE_ORDER', id: p.poId })) : []),
      ...(which === 'submit-to-po' ? data.speed.submitToPo.map((s) => ({ type: 'REQUEST', id: s.requestId })) : []),
    ]
    const ids = (type: string) => unique(subjects.filter((s) => s.type === type).map((s) => s.id))
    const [requests, pos, variances, versions, changes, people, budgetLines, suppliers] = await Promise.all([
      tx.request.findMany({ where: { id: { in: ids('REQUEST') } }, select: { id: true, number: true, title: true, requester: { select: { displayNameTh: true, displayNameEn: true } } } }),
      tx.purchaseOrder.findMany({ where: { id: { in: ids('PURCHASE_ORDER') } }, select: { id: true, number: true, supplier: { select: { nameTh: true } } } }),
      tx.variance.findMany({ where: { id: { in: ids('VARIANCE') } }, select: { id: true, poId: true, po: { select: { number: true } } } }),
      tx.doaVersion.findMany({ where: { id: { in: ids('DOA_VERSION') } }, select: { id: true, code: true, versionNo: true } }),
      tx.orgAuthorityChange.findMany({ where: { id: { in: ids('ORG_AUTHORITY_CHANGE') } }, select: { id: true, kind: true } }),
      tx.member.findMany({ where: { id: { in: unique([...tasks.map((t) => t.assigneeMemberId), ...decisions.map((d) => d.actorMemberId)]) } }, select: { id: true, displayNameTh: true, displayNameEn: true } }),
      tx.budgetLine.findMany({ where: { id: { in: lines.map((l) => l.id) } }, select: { id: true, code: true, nameTh: true } }),
      which === 'supplier-changes' ? tx.supplier.findMany({ where: { id: { in: unique(data.control.supplierChanges.map((c) => c.supplierId)) } }, select: { id: true, code: true, nameTh: true } }) : Promise.resolve([]),
    ])
    type Doc = NonNullable<InsightItemDto['document']>
    const docs = new Map<string, Doc>([
      ...requests.map((x): [string, Doc] => [x.id, { type: 'REQUEST', id: x.id, label: x.number ? `${x.number} ${x.title}` : x.title, poId: null }]),
      ...pos.map((x): [string, Doc] => [x.id, { type: 'PURCHASE_ORDER', id: x.id, label: [x.number, x.supplier.nameTh].filter(Boolean).join(' '), poId: x.id }]),
      ...variances.map((x): [string, Doc] => [x.id, { type: 'VARIANCE', id: x.id, label: x.po.number ?? '', poId: x.poId }]),
      ...versions.map((x): [string, Doc] => [x.id, { type: 'DOA_VERSION', id: x.id, label: `${x.code} #${x.versionNo}`, poId: null }]),
      ...changes.map((x): [string, Doc] => [x.id, { type: 'ORG_AUTHORITY_CHANGE', id: x.id, label: x.kind, poId: null }]),
    ])
    const person = new Map(people.map((p) => [p.id, p]))
    const lineOf = new Map(budgetLines.map((l) => [l.id, l]))
    const supplierOf = new Map(suppliers.map((s) => [s.id, s]))
    const requesterOf = new Map(requests.map((x) => [x.id, x.requester]))

    let items: InsightItemDto[] = []
    if (tasks.length) items = tasks.map((t, i) => ({ ...BLANK, key: `${i}:${t.taskId}`, document: docs.get(t.subjectId) ?? null, person: name(person.get(t.assigneeMemberId)), personKind: 'ASSIGNEE', at: (t.decidedAt ?? t.assignedAt).toISOString(), atKind: t.decidedAt ? 'DECIDED' : 'ASSIGNED', dueAt: t.dueAt?.toISOString() ?? null, minutes: t.minutes }))
    if (decisions.length)
      items = decisions.map((d) => ({ ...BLANK, key: d.taskId, document: docs.get(d.subjectId) ?? null, person: name(person.get(d.actorMemberId)), personKind: 'DECIDER', at: d.decidedAt.toISOString(), atKind: 'DECIDED', channel: d.channel, mark: d.withDoaReference ? 'WITH_DOA' : 'WITHOUT_DOA' }))
    if (spendPos.length)
      items = [...spendPos]
        .sort((a, b) => b.approvedAt.getTime() - a.approvedAt.getTime())
        .map((p) => ({ ...BLANK, key: p.poId, document: docs.get(p.poId) ?? null, at: p.approvedAt.toISOString(), atKind: 'APPROVED', amount: toMoneyDto(p.netSatang), mark: p.priceAlert ? 'PRICE_ALERT' : null }))
    if (which === 'idle-pos') items = data.speed.idlePos.map((p) => ({ ...BLANK, key: p.poId, document: docs.get(p.poId) ?? null, at: p.lastActivityAt.toISOString(), atKind: 'LAST_ACTIVITY' }))
    if (which === 'submit-to-po')
      items = [...data.speed.submitToPo]
        .sort((a, b) => b.firstPoApprovedAt.getTime() - a.firstPoApprovedAt.getTime())
        .map((s) => ({ ...BLANK, key: s.requestId, document: docs.get(s.requestId) ?? null, person: name(requesterOf.get(s.requestId)), personKind: 'REQUESTER', at: s.firstPoApprovedAt.toISOString(), atKind: 'FIRST_PO', minutes: s.minutes }))
    if (lines.length)
      items = lines.map((l) => {
        const figures = budgetFigures(amountsOf(l), lowBp)
        const row = lineOf.get(l.id)
        return { ...BLANK, key: l.id, document: { type: 'BUDGET_LINE', id: l.id, label: row ? `${row.code} ${row.nameTh}` : l.id, poId: null }, budget: figures, mark: figures.low ? 'LOW' : null }
      })
    if (which === 'supplier-changes')
      items = data.control.supplierChanges.map((c, i) => {
        const s = supplierOf.get(c.supplierId)
        return { ...BLANK, key: `${i}:${c.supplierId}`, document: { type: 'SUPPLIER', id: c.supplierId, label: s ? `${s.code} ${s.nameTh}` : c.supplierId, poId: null }, at: c.at.toISOString(), atKind: 'CHANGED', status: { from: c.from, to: c.to } }
      })
    return ok({ ...base, list: which, channel, week, items: items.slice(0, INSIGHT_LIST_MAX), total: items.length })
  })
}
