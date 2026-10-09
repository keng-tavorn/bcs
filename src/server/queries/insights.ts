import { exceedsByMoreThan, type Satang } from '@/core/money/math'
import { businessMinutesBetween, type BusinessCalendar } from '@/core/sla'
import { MS_PER_DAY } from '@/lib/constants'
import type { TenantTx } from '@/server/db/tenant'
import { APPROVED_STATUSES, itemKey } from './purchase-orders'

// The figures of the executive summary /insights (spec §11.5, FR-VIS-007 AC2 AC3): spending, budget, speed and control
// over a period [from, to), from the transaction tables and Event only (P-8). Everything is read in batches per period —
// never one read per row (the lesson of NEW-38) — and the same definitions as the KPI view (§11.4, collectKpis) and the
// budget dashboard (§11.2), so the numbers agree; the tests compare them on data whose answers are known. Every figure
// comes with the documents it counts, so a number always opens its list and the list's length is the number. Queries
// never check permissions: the service (services/reports/insights.ts) decides the scope and which cards a reader gets.

/** What the figures read: departments (null: all, and documents outside any department, as the KPI view) and a request type */
export interface InsightsScope {
  readonly departmentIds: readonly string[] | null
  readonly requestTypeId: string | null
}

export interface InsightsWeek {
  /** Monday, "YYYY-MM-DD" in Thai time */
  readonly start: string
  readonly from: Date
  readonly to: Date
}

export interface InsightsInput {
  readonly from: Date
  readonly to: Date
  readonly now: Date
  readonly scope: InsightsScope
  readonly calendar: BusinessCalendar
  /** settings.priceAlertPct in basis points (FR-P2P-003 AC1) */
  readonly alertBp: number
  /** poIdleDays (OQ-36) */
  readonly idleDays: number
  /** The weeks of the speed chart, oldest first */
  readonly weeks: readonly InsightsWeek[]
  /** The budget lines the budget card reads (its own scope, budget.view), or null for no budget card */
  readonly budget: { readonly fiscalYearId: string; readonly departmentIds: readonly string[] | null } | null
}

export interface SpendPo {
  readonly poId: string
  readonly approvedAt: Date
  /** Before VAT, of the PO's lines inside the scope */
  readonly netSatang: bigint
  /** A line's unit price is above the one approved before it by more than priceAlertPct */
  readonly priceAlert: boolean
}

export interface BudgetLineAsOf {
  readonly id: string
  readonly departmentId: string
  readonly planned: bigint
  readonly available: bigint
  readonly reserved: bigint
  readonly committed: bigint
  readonly actual: bigint
}

export interface InsightsTask {
  readonly taskId: string
  readonly subjectType: string
  readonly subjectId: string
  readonly assigneeMemberId: string
  readonly assignedAt: Date
  readonly dueAt: Date | null
  readonly decidedAt: Date | null
  readonly minutes: number | null
}

export interface InsightsDecision {
  readonly taskId: string
  readonly subjectType: string
  readonly subjectId: string
  readonly actorMemberId: string
  readonly channel: string
  readonly decidedAt: Date
  readonly withDoaReference: boolean
}

export interface InsightsData {
  readonly spend: { readonly pos: readonly SpendPo[]; readonly byDepartment: ReadonlyMap<string, bigint> }
  readonly budget: { readonly lines: readonly BudgetLineAsOf[] } | null
  readonly speed: {
    /** G-3 (1): requests from submit to their first PO approved in the period */
    readonly submitToPo: ReadonlyArray<{ readonly requestId: string; readonly submittedAt: Date; readonly firstPoApprovedAt: Date; readonly minutes: number }>
    /** G-3 (2): tasks decided in the period */
    readonly decided: readonly InsightsTask[]
    readonly weekly: ReadonlyArray<{ readonly start: string; readonly tasks: readonly InsightsTask[] }>
    /** Open tasks past their due time now */
    readonly overdue: readonly InsightsTask[]
    readonly idlePos: ReadonlyArray<{ readonly poId: string; readonly lastActivityAt: Date }>
  }
  readonly control: {
    /** G-2 (b) and G-5: every decision in the period */
    readonly decisions: readonly InsightsDecision[]
    /** G-4: the tasks of requests submitted in the period whose budget check did not pass */
    readonly overBudget: readonly InsightsTask[]
    readonly supplierChanges: ReadonlyArray<{ readonly supplierId: string; readonly at: Date; readonly from: string | null; readonly to: string }>
  }
}

/** POs still waiting on delivery: the ones that can sit without movement (FR-P2P-010 AC4) */
const IDLE_CAN_SIT = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'] as const

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]

/**
 * Which documents fall inside a scope, read once for all of them: a request by the department it charges and its type;
 * a PO by the departments of its lines' budget lines (any) and the types of the requests it orders; a variance by its PO
 * line's department and its PO's types. With no department and no type every document counts — the same rule as the
 * KPI view, which counts decisions on DOA versions and authority changes only for the whole organization.
 */
async function scopeOf(tx: TenantTx, scope: InsightsScope, refs: ReadonlyArray<{ subjectType: string; subjectId: string }>): Promise<(subjectType: string, subjectId: string) => boolean> {
  if (scope.departmentIds === null && scope.requestTypeId === null) return () => true
  const ids = (type: string) => unique(refs.filter((r) => r.subjectType === type).map((r) => r.subjectId))
  const variances = await tx.variance.findMany({ where: { id: { in: ids('VARIANCE') } }, select: { id: true, poId: true, poLine: { select: { budgetLine: { select: { departmentId: true } } } } } })
  const [requests, poLines] = await Promise.all([
    tx.request.findMany({ where: { id: { in: ids('REQUEST') } }, select: { id: true, chargedDepartmentId: true, requestTypeId: true } }),
    tx.poLine.findMany({
      where: { poId: { in: unique([...ids('PURCHASE_ORDER'), ...variances.map((v) => v.poId)]) } },
      select: { poId: true, budgetLine: { select: { departmentId: true } }, sources: { select: { requestLine: { select: { request: { select: { requestTypeId: true } } } } } } },
    }),
  ])
  const departments = scope.departmentIds === null ? null : new Set(scope.departmentIds)
  const deptOk = (d: string) => departments === null || departments.has(d)
  const typeOk = (types: ReadonlySet<string>) => scope.requestTypeId === null || types.has(scope.requestTypeId)
  const request = new Map(requests.map((r) => [r.id, r]))
  const po = new Map<string, { departments: Set<string>; types: Set<string> }>()
  for (const l of poLines) {
    const p = po.get(l.poId) ?? { departments: new Set<string>(), types: new Set<string>() }
    p.departments.add(l.budgetLine.departmentId)
    for (const s of l.sources) p.types.add(s.requestLine.request.requestTypeId)
    po.set(l.poId, p)
  }
  const variance = new Map(variances.map((v) => [v.id, v]))
  return (subjectType, subjectId) => {
    if (subjectType === 'REQUEST') {
      const r = request.get(subjectId)
      return Boolean(r && deptOk(r.chargedDepartmentId) && typeOk(new Set([r.requestTypeId])))
    }
    if (subjectType === 'PURCHASE_ORDER') {
      const p = po.get(subjectId)
      return Boolean(p && [...p.departments].some(deptOk) && typeOk(p.types))
    }
    if (subjectType === 'VARIANCE') {
      const v = variance.get(subjectId)
      const p = v ? po.get(v.poId) : undefined
      return Boolean(v && p && deptOk(v.poLine.budgetLine.departmentId) && typeOk(p.types))
    }
    return false
  }
}

const TASK_SELECT = { id: true, assigneeMemberId: true, assignedAt: true, dueAt: true, decidedAt: true, step: { select: { route: { select: { subjectType: true, subjectId: true } } } } } as const
type TaskRow = { id: string; assigneeMemberId: string; assignedAt: Date; dueAt: Date | null; decidedAt: Date | null; step: { route: { subjectType: string; subjectId: string } } }

const taskOf = (t: TaskRow, calendar: BusinessCalendar): InsightsTask => ({
  taskId: t.id,
  subjectType: t.step.route.subjectType,
  subjectId: t.step.route.subjectId,
  assigneeMemberId: t.assigneeMemberId,
  assignedAt: t.assignedAt,
  dueAt: t.dueAt,
  decidedAt: t.decidedAt,
  minutes: t.decidedAt ? businessMinutesBetween(t.assignedAt, t.decidedAt, calendar) : null,
})

const subjectOf = (t: TaskRow) => ({ subjectType: t.step.route.subjectType, subjectId: t.step.route.subjectId })

interface DecisionData {
  subjectType: string
  subjectId: string
  actorMemberId: string
}

/** The four cards' figures and the documents behind them, for one period and scope */
export async function loadInsights(tx: TenantTx, input: InsightsInput): Promise<InsightsData> {
  const { from, to, now, scope, calendar } = input
  const inPeriod = { gte: from, lt: to }
  const weeksFrom = input.weeks[0]?.from ?? from
  const weeksTo = input.weeks.at(-1)?.to ?? to
  const idleBefore = new Date(now.getTime() - input.idleDays * MS_PER_DAY)

  // ----- one read per kind of row for the period -----
  const [approvedPos, decidedTasks, weekTasks, overdueTasks, decisionEvents, submits, idleCandidates, supplierEvents] = await Promise.all([
    tx.purchaseOrder.findMany({
      where: { approvedAt: inPeriod },
      select: {
        id: true,
        status: true,
        approvedAt: true,
        lines: { select: { netSatang: true, unitPriceSatang: true, categoryCode: true, description: true, budgetLine: { select: { departmentId: true } }, sources: { select: { requestLine: { select: { requestId: true } } } } } },
      },
    }),
    tx.approvalTask.findMany({ where: { decidedAt: inPeriod }, select: TASK_SELECT }),
    tx.approvalTask.findMany({ where: { decidedAt: { gte: weeksFrom, lt: weeksTo } }, select: TASK_SELECT }),
    tx.approvalTask.findMany({ where: { status: 'OPEN', dueAt: { lt: now } }, select: TASK_SELECT, orderBy: { dueAt: 'asc' } }),
    tx.event.findMany({ where: { type: 'approval_task.decided', occurredAt: inPeriod }, select: { aggregateId: true, occurredAt: true, channel: true, data: true, doaVersionId: true, doaRuleCode: true }, orderBy: { seq: 'asc' } }),
    tx.event.findMany({ where: { type: { in: ['request.submitted', 'request.resubmitted'] }, occurredAt: inPeriod }, select: { aggregateId: true, data: true }, orderBy: { seq: 'asc' } }),
    tx.purchaseOrder.findMany({ where: { status: { in: [...IDLE_CAN_SIT] } }, select: { id: true, approvedAt: true, updatedAt: true } }),
    tx.event.findMany({ where: { type: 'supplier.registry_status_changed', occurredAt: inPeriod }, select: { aggregateId: true, occurredAt: true, data: true }, orderBy: { seq: 'desc' } }),
  ])
  const decisions = decisionEvents.map((e) => ({ e, data: e.data as unknown as DecisionData }))
  const failedSubmits = submits.filter((s) => {
    const check = (s.data as { budgetCheck?: { availableSatang?: string; reservedSatang?: string } }).budgetCheck
    return !check || BigInt(check.reservedSatang ?? '0') > BigInt(check.availableSatang ?? '0')
  })

  // ----- the rows those depend on, again one read each -----
  const firstPoOf = new Map<string, Date>()
  for (const po of approvedPos)
    for (const requestId of unique(po.lines.flatMap((l) => l.sources.map((s) => s.requestLine.requestId)))) {
      const earlier = firstPoOf.get(requestId)
      if (!earlier || po.approvedAt! < earlier) firstPoOf.set(requestId, po.approvedAt!)
    }
  const idleIds = idleCandidates.map((p) => p.id)
  const [submitted, failedTasks, poActivity, receiptActivity] = await Promise.all([
    tx.request.findMany({ where: { id: { in: [...firstPoOf.keys()] } }, select: { id: true, submittedAt: true, chargedDepartmentId: true, requestTypeId: true } }),
    tx.approvalTask.findMany({ where: { step: { route: { subjectType: 'REQUEST', subjectId: { in: unique(failedSubmits.map((s) => s.aggregateId)) } } } }, select: TASK_SELECT }),
    tx.event.groupBy({ by: ['aggregateId'], where: { aggregateType: 'PurchaseOrder', aggregateId: { in: idleIds } }, _max: { occurredAt: true } }),
    tx.goodsReceipt.groupBy({ by: ['poId'], where: { poId: { in: idleIds } }, _max: { updatedAt: true } }),
  ])

  const inScope = await scopeOf(tx, scope, [
    ...approvedPos.map((p) => ({ subjectType: 'PURCHASE_ORDER', subjectId: p.id })),
    ...[...decidedTasks, ...weekTasks, ...overdueTasks, ...failedTasks].map(subjectOf),
    ...decisions.map((d) => ({ subjectType: d.data.subjectType, subjectId: d.data.subjectId })),
    ...failedSubmits.map((s) => ({ subjectType: 'REQUEST', subjectId: s.aggregateId })),
    ...idleIds.map((id) => ({ subjectType: 'PURCHASE_ORDER', subjectId: id })),
  ])
  const departments = scope.departmentIds === null ? null : new Set(scope.departmentIds)

  // ----- spending: POs approved in the period and not cancelled, by the department of each line's budget line -----
  const spendPos = approvedPos.filter((p) => p.status !== 'CANCELLED' && inScope('PURCHASE_ORDER', p.id))
  const categories = unique(spendPos.flatMap((p) => p.lines.map((l) => l.categoryCode)))
  const earlier = spendPos.length
    ? await tx.poLine.findMany({
        where: { po: { status: { in: [...APPROVED_STATUSES] }, approvedAt: { lt: to } }, OR: categories.map((c) => ({ categoryCode: c })) },
        select: { poId: true, categoryCode: true, description: true, unitPriceSatang: true, po: { select: { approvedAt: true } } },
      })
    : []
  const pricesOf = new Map<string, Array<{ poId: string; at: Date; price: bigint }>>()
  for (const e of earlier) {
    const key = itemKey(e.categoryCode, e.description)
    const list = pricesOf.get(key) ?? []
    list.push({ poId: e.poId, at: e.po.approvedAt!, price: e.unitPriceSatang })
    pricesOf.set(key, list)
  }
  const byDepartment = new Map<string, bigint>()
  const pos: SpendPo[] = spendPos.map((p) => {
    let net = 0n
    let priceAlert = false
    for (const l of p.lines) {
      const department = l.budgetLine.departmentId
      if (departments === null || departments.has(department)) {
        net += l.netSatang
        byDepartment.set(department, (byDepartment.get(department) ?? 0n) + l.netSatang)
      }
      // the last price of the same item approved before this PO (the PO page's price history, as it stood then)
      const before = (pricesOf.get(itemKey(l.categoryCode, l.description)) ?? []).filter((x) => x.poId !== p.id && x.at < p.approvedAt!)
      const last = before.reduce<(typeof before)[number] | null>((a, b) => (a === null || b.at > a.at ? b : a), null)
      if (last && exceedsByMoreThan(l.unitPriceSatang as Satang, last.price as Satang, input.alertBp)) priceAlert = true
    }
    return { poId: p.id, approvedAt: p.approvedAt!, netSatang: net, priceAlert }
  })

  // ----- budget: §11.2 at the end of the period -----
  // A period that ends today or later reads the balance projection the budget dashboard reads (INV-BUD-05), so the two
  // agree to the satang; a period that ended earlier adds up the ledger's movements made before its end
  let budget: InsightsData['budget'] = null
  if (input.budget) {
    const lines = await tx.budgetLine.findMany({
      where: { fiscalYearId: input.budget.fiscalYearId, ...(input.budget.departmentIds === null ? {} : { departmentId: { in: [...input.budget.departmentIds] } }) },
      select: { id: true, departmentId: true, plannedSatang: true, balance: { select: { availableSatang: true, reservedSatang: true, committedSatang: true, actualSatang: true } } },
      orderBy: { code: 'asc' },
    })
    const held = new Map<string, bigint>()
    if (to > now) {
      for (const l of lines) {
        held.set(`${l.id}|AVAILABLE`, l.balance?.availableSatang ?? 0n)
        held.set(`${l.id}|RESERVED`, l.balance?.reservedSatang ?? 0n)
        held.set(`${l.id}|COMMITTED`, l.balance?.committedSatang ?? 0n)
        held.set(`${l.id}|ACTUAL`, l.balance?.actualSatang ?? 0n)
      }
    } else {
      const asOf = { budgetLineId: { in: lines.map((l) => l.id) }, createdAt: { lt: to } }
      const [into, outOf] = await Promise.all([
        tx.budgetLedgerEntry.groupBy({ by: ['budgetLineId', 'toBucket'], where: asOf, _sum: { amountSatang: true } }),
        tx.budgetLedgerEntry.groupBy({ by: ['budgetLineId', 'fromBucket'], where: asOf, _sum: { amountSatang: true } }),
      ])
      const move = (key: string, amount: bigint) => held.set(key, (held.get(key) ?? 0n) + amount)
      for (const r of into) move(`${r.budgetLineId}|${r.toBucket}`, r._sum.amountSatang ?? 0n)
      for (const r of outOf) move(`${r.budgetLineId}|${r.fromBucket}`, -(r._sum.amountSatang ?? 0n))
    }
    const bucket = (lineId: string, b: string) => held.get(`${lineId}|${b}`) ?? 0n
    budget = {
      lines: lines.map((l) => ({
        id: l.id,
        departmentId: l.departmentId,
        planned: l.plannedSatang,
        available: bucket(l.id, 'AVAILABLE'),
        reserved: bucket(l.id, 'RESERVED'),
        committed: bucket(l.id, 'COMMITTED'),
        actual: bucket(l.id, 'ACTUAL'),
      })),
    }
  }

  // ----- speed: G-3 (1) and (2), the weekly medians, overdue tasks and idle POs -----
  const submitToPo = submitted
    .filter((r) => r.submittedAt && (departments === null || departments.has(r.chargedDepartmentId)) && (scope.requestTypeId === null || r.requestTypeId === scope.requestTypeId))
    .map((r) => {
      const firstPoApprovedAt = firstPoOf.get(r.id)!
      return { requestId: r.id, submittedAt: r.submittedAt!, firstPoApprovedAt, minutes: businessMinutesBetween(r.submittedAt!, firstPoApprovedAt, calendar) }
    })
  const scoped = (rows: readonly TaskRow[]) => rows.filter((t) => inScope(t.step.route.subjectType, t.step.route.subjectId)).map((t) => taskOf(t, calendar))
  const weekRows = scoped(weekTasks)
  const weekly = input.weeks.map((w) => ({ start: w.start, tasks: weekRows.filter((t) => t.decidedAt! >= w.from && t.decidedAt! < w.to) }))
  const lastOf = new Map<string, Date>()
  const later = (id: string, at: Date | null | undefined) => {
    if (at && (!lastOf.has(id) || at > lastOf.get(id)!)) lastOf.set(id, at)
  }
  for (const p of idleCandidates) later(p.id, p.approvedAt)
  for (const a of poActivity) later(a.aggregateId, a._max.occurredAt)
  for (const r of receiptActivity) later(r.poId, r._max.updatedAt)
  const idlePos = idleCandidates
    .filter((p) => inScope('PURCHASE_ORDER', p.id))
    .map((p) => ({ poId: p.id, lastActivityAt: lastOf.get(p.id) ?? p.updatedAt }))
    .filter((p) => p.lastActivityAt < idleBefore)
    .sort((a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime())

  // ----- control: G-2 (b), G-4, G-5 and the suppliers whose registry status changed -----
  const tasksOfRequest = new Map<string, TaskRow[]>()
  for (const t of failedTasks) tasksOfRequest.set(t.step.route.subjectId, [...(tasksOfRequest.get(t.step.route.subjectId) ?? []), t])
  // as the KPI view counts it: every task of the request, once per submit whose check did not pass
  const overBudget = failedSubmits.filter((s) => inScope('REQUEST', s.aggregateId)).flatMap((s) => (tasksOfRequest.get(s.aggregateId) ?? []).map((t) => taskOf(t, calendar)))

  return {
    spend: { pos, byDepartment },
    budget,
    speed: { submitToPo, decided: scoped(decidedTasks), weekly, overdue: scoped(overdueTasks), idlePos },
    control: {
      decisions: decisions
        .filter((d) => inScope(d.data.subjectType, d.data.subjectId))
        .map((d) => ({
          taskId: d.e.aggregateId,
          subjectType: d.data.subjectType,
          subjectId: d.data.subjectId,
          actorMemberId: d.data.actorMemberId,
          channel: d.e.channel,
          decidedAt: d.e.occurredAt,
          withDoaReference: d.e.doaVersionId !== null && d.e.doaRuleCode !== null,
        })),
      overBudget,
      supplierChanges: supplierEvents.map((e) => {
        const data = e.data as { from: string | null; to: string }
        return { supplierId: e.aggregateId, at: e.occurredAt, from: data.from, to: data.to }
      }),
    },
  }
}
