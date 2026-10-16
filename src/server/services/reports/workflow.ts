import type { BusinessCalendar } from '@/core/sla'
import { bottlenecks as orderBottlenecks, cycleMinutes, decisionMinutes, heatCell, lowerMedian } from '@/core/workflow-reports'
import { loadBusinessCalendar } from '@/server/doa/policy'
import type { TenantTx } from '@/server/db/tenant'
import { collectKpis } from './kpi'

// The workflow reports (S6-20 · FR-VIS-101 · BR-RPT-03 to BR-RPT-06): over a period, within the reader's report.view
// scope (the whole organization, or the requests charged to the departments a head heads with their subtrees — the
// KPI's scope, whose items this reads): cycle time of each request (submit → last approval, submit → first PO approved)
// and the decision time of each step without the time a question waited (InfoRequest); bottlenecks by the position
// (resolvedFrom) and by the person the tasks waited for; the decisions outside DOA (G-2 (a) re-run, no DOA reference,
// a request flagged SPLIT); and the heatmap of decisions by weekday and hour, and of open tasks by department and age.

/** BR-RPT-06: the age bands of an open task, in business hours */
export const AGE_BANDS = [
  { key: 'H0_8', upTo: 8 },
  { key: 'H8_16', upTo: 16 },
  { key: 'H16_40', upTo: 40 },
  { key: 'H40_PLUS', upTo: null },
] as const
export type AgeBand = (typeof AGE_BANDS)[number]['key']
const MINUTES_PER_HOUR = 60

export interface WorkflowReport {
  readonly cycle: {
    readonly requests: ReadonlyArray<{ readonly requestId: string; readonly number: string | null; readonly submittedAt: string; readonly approvedAt: string | null; readonly cycleMinutes: number | null; readonly toFirstPoMinutes: number | null }>
    readonly medianCycleMinutes: number | null
    readonly medianToFirstPoMinutes: number | null
    readonly medianDecisionMinutes: number | null
  }
  readonly bottlenecks: {
    readonly byPosition: ReadonlyArray<{ readonly at: string; readonly overdue: number; readonly median: number | null; readonly taskIds: readonly string[] }>
    readonly byPerson: ReadonlyArray<{ readonly memberId: string; readonly name: string; readonly overdue: number; readonly median: number | null; readonly taskIds: readonly string[] }>
  }
  readonly wrongDoa: ReadonlyArray<{ readonly key: string; readonly reason: 'NOT_BY_DOA' | 'NO_DOA_REFERENCE' | 'SPLIT'; readonly subjectType: string; readonly subjectId: string; readonly number: string | null; readonly at: string }>
  readonly heatmap: {
    /** Decisions per weekday (SUN … SAT) and hour 0–23, Thai time */
    readonly decisions: ReadonlyArray<{ readonly weekday: string; readonly hour: number; readonly count: number }>
    readonly openByDepartment: ReadonlyArray<{ readonly departmentId: string | null; readonly code: string | null; readonly bands: Readonly<Record<AgeBand, number>> }>
  }
}

/** The questions of each task, read once (not the whole list again for every task) */
function groupByTask<Q extends { readonly taskId: string }>(questions: readonly Q[]): Map<string, Q[]> {
  const out = new Map<string, Q[]>()
  for (const q of questions) out.set(q.taskId, [...(out.get(q.taskId) ?? []), q])
  return out
}

/** "POSITION:CEO@HQ" → "CEO@HQ"; anything else as it is */
const positionAt = (resolvedFrom: string) => resolvedFrom.replace(/^POSITION:/, '')

export async function computeWorkflowReport(tx: TenantTx, organizationId: string, period: { from: Date; to: Date; now: Date }, departmentIds: readonly string[] | null): Promise<WorkflowReport> {
  const calendar: BusinessCalendar = await loadBusinessCalendar(tx, organizationId)
  const kpi = await collectKpis(tx, organizationId, period, departmentIds)
  const items = kpi.items

  // ----- cycle time (BR-RPT-03) -----
  const scopeOfRequests = departmentIds === null ? {} : { chargedDepartmentId: { in: [...departmentIds] } }
  const submitted = await tx.request.findMany({
    where: { documentType: 'PURCHASE_REQUEST', submittedAt: { gte: period.from, lt: period.to }, ...scopeOfRequests },
    select: { id: true, number: true, submittedAt: true, approvedAt: true },
    orderBy: { submittedAt: 'asc' },
  })
  const toPo = new Map(items.g3SubmitToPo.map((r) => [r.requestId, r.minutes]))
  const requests = submitted.map((r) => ({
    requestId: r.id,
    number: r.number,
    submittedAt: r.submittedAt!.toISOString(),
    approvedAt: r.approvedAt?.toISOString() ?? null,
    cycleMinutes: r.approvedAt ? cycleMinutes(r.submittedAt!, r.approvedAt, calendar) : null,
    toFirstPoMinutes: toPo.get(r.id) ?? null,
  }))

  // Decision time of each task without the time its questions waited (BR-RPT-03)
  const taskIds = items.g3Assigned.map((t) => t.taskId)
  const [tasks, questions] = await Promise.all([
    tx.approvalTask.findMany({ where: { id: { in: taskIds } }, select: { id: true, resolvedFrom: true, assigneeMemberId: true, assignedAt: true, decidedAt: true, assignee: { select: { displayNameTh: true } } } }),
    tx.infoRequest.findMany({ where: { taskId: { in: taskIds } }, select: { taskId: true, askedAt: true, answeredAt: true } }),
  ])
  const questionsOf = groupByTask(questions)
  const pausesOf = (taskId: string, until: Date) => (questionsOf.get(taskId) ?? []).map((q) => ({ from: q.askedAt, to: q.answeredAt ?? until }))
  const minutesOf = new Map(tasks.filter((t) => t.decidedAt).map((t) => [t.id, decisionMinutes(t.assignedAt, t.decidedAt!, pausesOf(t.id, t.decidedAt!), calendar)]))

  // ----- bottlenecks (BR-RPT-04) -----
  const pastDue = new Set(items.g3Assigned.filter((t) => t.pastDue === 'PAST_DUE_DECIDED' || t.pastDue === 'PAST_DUE_OPEN').map((t) => t.taskId))
  const group = <K extends string>(keyOf: (t: (typeof tasks)[number]) => K) => {
    const groups = new Map<K, { overdue: number; minutes: number[]; taskIds: string[] }>()
    for (const t of tasks) {
      const g = groups.get(keyOf(t)) ?? { overdue: 0, minutes: [], taskIds: [] }
      if (pastDue.has(t.id)) g.overdue++
      const m = minutesOf.get(t.id)
      if (m !== undefined) g.minutes.push(m)
      g.taskIds.push(t.id)
      groups.set(keyOf(t), g)
    }
    return [...groups].map(([key, g]) => ({ key, overdue: g.overdue, median: lowerMedian(g.minutes), taskIds: g.taskIds }))
  }
  const byPosition = orderBottlenecks(group((t) => positionAt(t.resolvedFrom))).map((g) => ({ at: g.key, overdue: g.overdue, median: g.median, taskIds: g.taskIds }))
  const names = new Map(tasks.map((t) => [t.assigneeMemberId, t.assignee.displayNameTh]))
  const byPerson = orderBottlenecks(group((t) => t.assigneeMemberId)).map((g) => ({ memberId: g.key, name: names.get(g.key) ?? '', overdue: g.overdue, median: g.median, taskIds: g.taskIds }))

  // ----- decisions outside DOA (BR-RPT-05) -----
  const requestNumbers = new Map(
    (await tx.request.findMany({ where: { id: { in: [...new Set(items.decisions.filter((d) => d.subjectType === 'REQUEST').map((d) => d.subjectId))] } }, select: { id: true, number: true } })).map((r) => [r.id, r.number]),
  )
  const wrongDoa: Array<WorkflowReport['wrongDoa'][number]> = []
  for (const d of items.decisions) {
    const base = { subjectType: d.subjectType, subjectId: d.subjectId, number: requestNumbers.get(d.subjectId) ?? null, at: d.decidedAt }
    if (d.misrouted === true) wrongDoa.push({ key: `${d.taskId}:NOT_BY_DOA`, reason: 'NOT_BY_DOA', ...base })
    if (!d.doaVersionId || !d.doaRuleCode) wrongDoa.push({ key: `${d.taskId}:NO_DOA_REFERENCE`, reason: 'NO_DOA_REFERENCE', ...base })
  }
  const splits = await tx.requestFlag.findMany({
    where: { kind: 'SPLIT', createdAt: { gte: period.from, lt: period.to }, ...(departmentIds === null ? {} : { request: { chargedDepartmentId: { in: [...departmentIds] } } }) },
    select: { id: true, requestId: true, createdAt: true, request: { select: { number: true } } },
  })
  for (const f of splits) wrongDoa.push({ key: `${f.id}:SPLIT`, reason: 'SPLIT', subjectType: 'REQUEST', subjectId: f.requestId, number: f.request.number, at: f.createdAt.toISOString() })

  // ----- heatmap (BR-RPT-06) -----
  const cells = new Map<string, number>()
  for (const d of items.decisions) {
    const c = heatCell(new Date(d.decidedAt), calendar.timezone)
    cells.set(`${c.weekday}|${c.hour}`, (cells.get(`${c.weekday}|${c.hour}`) ?? 0) + 1)
  }
  const open = await tx.approvalTask.findMany({
    where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, step: { route: { status: 'ACTIVE' } } },
    select: { id: true, assignedAt: true, step: { select: { route: { select: { subjectType: true, subjectId: true } } } } },
  })
  const openRequests = new Map(
    (await tx.request.findMany({ where: { id: { in: open.filter((t) => t.step.route.subjectType === 'REQUEST').map((t) => t.step.route.subjectId) } }, select: { id: true, chargedDepartmentId: true } })).map((r) => [r.id, r.chargedDepartmentId]),
  )
  const openQuestions = await tx.infoRequest.findMany({ where: { taskId: { in: open.map((t) => t.id) } }, select: { taskId: true, askedAt: true, answeredAt: true } })
  const openQuestionsOf = groupByTask(openQuestions)
  const byDepartment = new Map<string | null, Record<AgeBand, number>>()
  for (const t of open) {
    const department = t.step.route.subjectType === 'REQUEST' ? (openRequests.get(t.step.route.subjectId) ?? null) : null
    // A head reads the requests of their departments only; the organization reads every open task
    if (departmentIds !== null && (department === null || !departmentIds.includes(department))) continue
    const pauses = (openQuestionsOf.get(t.id) ?? []).map((q) => ({ from: q.askedAt, to: q.answeredAt ?? period.now }))
    const hours = decisionMinutes(t.assignedAt, period.now, pauses, calendar) / MINUTES_PER_HOUR
    const band = AGE_BANDS.find((b) => b.upTo === null || hours < b.upTo)!.key
    const row = byDepartment.get(department) ?? { H0_8: 0, H8_16: 0, H16_40: 0, H40_PLUS: 0 }
    row[band]++
    byDepartment.set(department, row)
  }
  const departments = new Map((await tx.department.findMany({ where: { id: { in: [...byDepartment.keys()].filter((d): d is string => d !== null) } }, select: { id: true, code: true } })).map((d) => [d.id, d.code]))

  return {
    cycle: {
      requests,
      medianCycleMinutes: lowerMedian(requests.flatMap((r) => (r.cycleMinutes === null ? [] : [r.cycleMinutes]))),
      medianToFirstPoMinutes: lowerMedian(items.g3SubmitToPo.map((r) => r.minutes)),
      medianDecisionMinutes: lowerMedian([...minutesOf.values()]),
    },
    bottlenecks: { byPosition, byPerson },
    wrongDoa,
    heatmap: {
      decisions: [...cells].map(([k, count]) => ({ weekday: k.split('|')[0]!, hour: Number(k.split('|')[1]), count })),
      openByDepartment: [...byDepartment].map(([departmentId, bands]) => ({ departmentId, code: departmentId ? (departments.get(departmentId) ?? null) : null, bands })),
    },
  }
}
