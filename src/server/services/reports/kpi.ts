import { resolveRoute, type DoaDocumentType, type RouteInput } from '@/core/doa'
import { vatFromNet } from '@/core/money/math'
import { businessMinutesBetween } from '@/core/sla'
import { resolveRequestRoute } from '@/core/workflow'
import type { TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar, loadRoutePolicy } from '@/server/doa/policy'
import { loadWorkflowVersions, requestReviewFacts } from '@/server/workflow/policy'

// The KPIs of the first tier (spec §11.4, §1 G-1 to G-5, FR-VIS-003 AC1), computed from Event and the transaction
// tables only (P-8), over a period [from, to). Ratios are kept as numerator and denominator (no floating point); times
// are business minutes on the organization's calendar (§7.8). Scope narrows the documents to departments (§2.4
// report.view for a department head); null is the whole organization.
//  G-1  POs approved ÷ purchase documents in the accounting system — the denominator comes from the monthly Express
//       import, not available yet (S4-14), so only the numerator is known
//  G-2  (a) decisions whose decider is not who the DOA engine gives for that step at the route's time (re-run); a
//       reviewer's decision (S6) against who the workflow engine gives for its slot (OQ-101)
//       (b) decision events that name the DOA version and rule in their columns ÷ all decisions
//  G-3  median business time from a request's submit to its first PO approval · median business time a task waited
//       for its decision · tasks decided after their due time, or open past it at the end, ÷ all tasks assigned
//  G-4  tasks assigned on requests whose budget check did not pass
//  G-5  decisions on LINE (chat or LIFF) ÷ all decisions of approval steps, in all and per kind of document; a
//       reviewer's decision is no approval and is not counted (S6 · OQ-101)

export interface Ratio {
  readonly numerator: number
  readonly denominator: number | null
}

export interface KpiResult {
  readonly from: string
  readonly to: string
  readonly g1: Ratio
  readonly g2: { readonly misrouted: number; readonly checked: number; readonly withDoaReference: Ratio }
  readonly g3: { readonly submitToPoMedianMinutes: number | null; readonly decisionMedianMinutes: number | null; readonly pastDue: Ratio }
  readonly g4: { readonly tasksOnFailedBudgetCheck: number }
  readonly g5: { readonly total: Ratio; readonly bySubject: Readonly<Record<string, Ratio>> }
}

const MOBILE = new Set(['LINE_CHAT', 'LIFF'])

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

interface DecisionData {
  decision: string
  subjectType: string
  subjectId: string
  actorMemberId: string
  onBehalfOfMemberId: string | null
}

/** The DOA engine's input for a routed document, as it stood when the route was made (G-2 (a)) */
async function routeInput(tx: TenantTx, subjectType: string, subjectId: string, at: Date): Promise<RouteInput | null> {
  if (subjectType === 'REQUEST') {
    const r = await tx.request.findUnique({ where: { id: subjectId } })
    if (!r) return null
    return { documentType: 'PURCHASE_REQUEST', amount: { netSatang: r.netSatang, vatSatang: r.vatSatang }, requesterMemberId: r.requesterMemberId, chargedDepartmentId: r.chargedDepartmentId, conflictMemberIds: [r.requesterMemberId], at }
  }
  if (subjectType === 'PURCHASE_ORDER') {
    const po = await tx.purchaseOrder.findUnique({ where: { id: subjectId }, include: { lines: { take: 1, orderBy: { lineNo: 'asc' }, include: { budgetLine: { select: { departmentId: true } } } } } })
    if (!po?.createdById || !po.lines[0]) return null
    const requesters = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: po.id } } } } } }, select: { requesterMemberId: true } })
    return {
      documentType: 'PURCHASE_ORDER',
      amount: { netSatang: po.netSatang, vatSatang: po.vatSatang },
      requesterMemberId: po.createdById,
      chargedDepartmentId: po.lines[0].budgetLine.departmentId,
      conflictMemberIds: [...new Set([po.createdById, ...requesters.map((r) => r.requesterMemberId)])],
      at,
    }
  }
  if (subjectType === 'VARIANCE') {
    const v = await tx.variance.findUnique({ where: { id: subjectId }, include: { poLine: { include: { budgetLine: { select: { departmentId: true } } } }, po: { select: { vatRateBp: true } } } })
    if (!v) return null
    // the same amount the route was made with: the variance before VAT and its VAT at the PO's rate
    return { documentType: 'GR_VARIANCE', amount: { netSatang: v.amountSatang, vatSatang: vatFromNet(v.amountSatang, v.po.vatRateBp ?? 0).vat }, requesterMemberId: v.createdById, chargedDepartmentId: v.poLine.budgetLine.departmentId, conflictMemberIds: [v.createdById], at }
  }
  return null
}

// ---------- the documents behind each figure (the KPI page's lists: every number leads to its items, §9.9) ----------

/** One decision counted by G-2 and G-5 */
export interface KpiDecisionItem {
  readonly taskId: string
  readonly subjectType: string
  readonly subjectId: string
  readonly decision: string
  readonly channel: string
  readonly decidedAt: string
  readonly actorMemberId: string
  readonly onBehalfOfMemberId: string | null
  readonly doaVersionId: string | null
  readonly doaRuleCode: string | null
  /** G-2 (a): the decider is not who the DOA engine gives for the step; null when the document could not be re-run */
  readonly misrouted: boolean | null
  /** A reviewer's decision of a REVIEW step (S6): G-2 counts it, G-5 does not */
  readonly review: boolean
}

/** One approval task counted by G-3 (its decision time, or because it went past its due time) or by G-4 */
export interface KpiTaskItem {
  readonly taskId: string
  readonly subjectType: string
  readonly subjectId: string
  readonly assigneeMemberId: string
  readonly assignedAt: string
  readonly dueAt: string | null
  readonly decidedAt: string | null
  /** Business minutes from assignment to decision; null while open */
  readonly minutes: number | null
}

/**
 * Whether a task assigned in the period counts as past due in G-3 (c), and why: decided after its due time, or still
 * open (or waiting for the requester's answer) past it when the period ends — or not: decided by its due time, open and
 * not due yet, with no due time, or closed without a decision (cancelled or reassigned)
 */
export type KpiPastDueMark = 'PAST_DUE_DECIDED' | 'PAST_DUE_OPEN' | 'DECIDED_ON_TIME' | 'OPEN_NOT_DUE' | 'NO_DUE_TIME' | 'CLOSED_UNDECIDED'

/** The marks G-3 (c) counts */
export const isPastDue = (mark: KpiPastDueMark): boolean => mark === 'PAST_DUE_DECIDED' || mark === 'PAST_DUE_OPEN'

/** One task assigned in the period: the denominator of G-3 (c), with whether it is counted and why */
export interface KpiAssignedTaskItem extends KpiTaskItem {
  readonly pastDue: KpiPastDueMark
}

/** One request counted by G-3 (from its submit to its first approved PO) */
export interface KpiRequestItem {
  readonly requestId: string
  readonly submittedAt: string
  readonly firstPoApprovedAt: string
  readonly minutes: number
}

export interface KpiItems {
  /** G-1: the POs approved in the period */
  readonly g1: ReadonlyArray<{ readonly poId: string; readonly approvedAt: string }>
  /** G-2 and G-5: every decision in the period, oldest first */
  readonly decisions: readonly KpiDecisionItem[]
  readonly g3SubmitToPo: readonly KpiRequestItem[]
  readonly g3Decisions: readonly KpiTaskItem[]
  /** G-3: the tasks assigned in the period that were decided after their due time, or are open past it */
  readonly g3PastDue: readonly KpiTaskItem[]
  /** G-3: every task assigned in the period (the denominator of the past-due share), each marked counted or not and why */
  readonly g3Assigned: readonly KpiAssignedTaskItem[]
  /** G-4: the tasks of requests whose budget check did not pass */
  readonly g4: readonly KpiTaskItem[]
}

export async function computeKpis(tx: TenantTx, organizationId: string, period: { from: Date; to: Date; now: Date }, departmentIds: readonly string[] | null): Promise<KpiResult> {
  return (await collectKpis(tx, organizationId, period, departmentIds)).result
}

/** The KPIs and the documents each figure counts, in the same pass (the counts are the lengths of the lists) */
export async function collectKpis(
  tx: TenantTx,
  organizationId: string,
  period: { from: Date; to: Date; now: Date },
  departmentIds: readonly string[] | null,
): Promise<{ result: KpiResult; items: KpiItems }> {
  const occurredAt = { gte: period.from, lt: period.to }
  // Documents inside the scope: requests charged to the departments, POs and variances on their budget lines
  const inScope = async (subjectType: string, subjectId: string): Promise<boolean> => {
    if (departmentIds === null) return true
    if (subjectType === 'REQUEST') return (await tx.request.count({ where: { id: subjectId, chargedDepartmentId: { in: [...departmentIds] } } })) > 0
    if (subjectType === 'PURCHASE_ORDER') return (await tx.poLine.count({ where: { poId: subjectId, budgetLine: { departmentId: { in: [...departmentIds] } } } })) > 0
    if (subjectType === 'VARIANCE') return (await tx.variance.count({ where: { id: subjectId, poLine: { budgetLine: { departmentId: { in: [...departmentIds] } } } } })) > 0
    return false
  }

  // ----- G-1 -----
  const approvedPos = await tx.event.findMany({ where: { type: 'po.approved', occurredAt }, select: { aggregateId: true, occurredAt: true }, orderBy: { seq: 'asc' } })
  const g1Items: Array<{ poId: string; approvedAt: string }> = []
  for (const e of approvedPos) if (await inScope('PURCHASE_ORDER', e.aggregateId)) g1Items.push({ poId: e.aggregateId, approvedAt: e.occurredAt.toISOString() })
  const g1 = g1Items.length

  // ----- decisions (G-2, G-5) -----
  const decisionEvents = await tx.event.findMany({ where: { type: 'approval_task.decided', occurredAt }, orderBy: { seq: 'asc' } })
  const decisions: Array<{ data: DecisionData; channel: string; doaVersionId: string | null; doaRuleCode: string | null; taskId: string; occurredAt: Date; review: boolean }> = []
  for (const e of decisionEvents) {
    const data = e.data as unknown as DecisionData
    // A reviewer's decision names its workflow version (INV-WF-04)
    const review = typeof (e.data as { workflowVersionId?: unknown }).workflowVersionId === 'string'
    if (await inScope(data.subjectType, data.subjectId)) decisions.push({ data, channel: e.channel, doaVersionId: e.doaVersionId, doaRuleCode: e.doaRuleCode, taskId: e.aggregateId, occurredAt: e.occurredAt, review })
  }
  const policy = await loadRoutePolicy(tx)
  const workflows = decisions.some((d) => d.review) ? await loadWorkflowVersions(tx) : []
  let misrouted = 0
  let checked = 0
  const decisionItems: KpiDecisionItem[] = []
  for (const d of decisions) {
    let wrong: boolean | null = null
    const task = await tx.approvalTask.findUnique({ where: { id: d.taskId }, include: { step: { include: { route: true } } } })
    const input = task ? await routeInput(tx, d.data.subjectType, d.data.subjectId, task.step.route.createdAt) : null
    if (task && input) {
      checked++
      let holders: ReadonlyArray<{ readonly assigneeMemberId: string; readonly principalMemberId: string | null }> = []
      if (task.step.kind === 'REVIEW') {
        // A reviewer: the holders of their slot, as the workflow engine gives them for the request at the route's time
        const request = await tx.request.findUniqueOrThrow({ where: { id: d.data.subjectId }, include: { requestType: { select: { code: true } }, lines: { select: { categoryCode: true, budgetLineId: true } } } })
        const facts = await requestReviewFacts(tx, { requestTypeCode: request.requestType.code, grossSatang: request.grossSatang, netSatang: request.netSatang, formData: request.formData, budgetLineId: request.budgetLineId, lines: request.lines })
        const again = resolveRequestRoute(input, facts, { ...policy, workflows })
        holders = again.ok ? (again.data.review?.slots.find((s) => s.slotNo === task.slotNo)?.assignees ?? []) : []
      } else {
        // A DOA step is the engine's step of its DOA step number (BR-WF-06): a route with reviewers numbers it one on
        const again = resolveRoute(input, policy)
        const step = again.ok ? again.data.steps.find((s) => s.stepNo === (task.step.doaStepNo ?? task.step.stepNo)) : undefined
        // A committee step allows every slot's holder (S6 · FR-WF-102): each decides their own slot
        holders = step ? (step.committee?.slots ?? [step]) : []
      }
      const allowed = new Set(holders.flatMap((h) => [h.assigneeMemberId, h.principalMemberId]).filter((m): m is string => Boolean(m)))
      // the decider: the delegate who acted, or the approver themself; a delegator acting on their own task counts
      wrong = !allowed.has(d.data.actorMemberId)
      if (wrong) misrouted++
    }
    decisionItems.push({
      taskId: d.taskId,
      subjectType: d.data.subjectType,
      subjectId: d.data.subjectId,
      decision: d.data.decision,
      channel: d.channel,
      decidedAt: d.occurredAt.toISOString(),
      actorMemberId: d.data.actorMemberId,
      onBehalfOfMemberId: d.data.onBehalfOfMemberId ?? null,
      doaVersionId: d.doaVersionId,
      doaRuleCode: d.doaRuleCode,
      misrouted: wrong,
      review: d.review,
    })
  }
  const withReference = decisions.filter((d) => d.doaVersionId !== null && d.doaRuleCode !== null).length

  // ----- G-3 -----
  const calendar = await loadBusinessCalendar(tx, organizationId)
  const poApprovals = await tx.purchaseOrder.findMany({ where: { approvedAt: occurredAt }, select: { id: true, approvedAt: true } })
  const firstPoOf = new Map<string, Date>()
  for (const po of poApprovals) {
    const requests = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: po.id } } } } } }, select: { id: true } })
    for (const r of requests) {
      const earlier = firstPoOf.get(r.id)
      if (!earlier || po.approvedAt! < earlier) firstPoOf.set(r.id, po.approvedAt!)
    }
  }
  const submitToPo: number[] = []
  const submitToPoItems: KpiRequestItem[] = []
  for (const [requestId, approvedAt] of firstPoOf) {
    const r = await tx.request.findUnique({ where: { id: requestId }, select: { submittedAt: true, chargedDepartmentId: true } })
    if (!r?.submittedAt) continue
    if (departmentIds !== null && !departmentIds.includes(r.chargedDepartmentId)) continue
    const minutes = businessMinutesBetween(r.submittedAt, approvedAt, calendar)
    submitToPo.push(minutes)
    submitToPoItems.push({ requestId, submittedAt: r.submittedAt.toISOString(), firstPoApprovedAt: approvedAt.toISOString(), minutes })
  }
  const taskItem = (t: { id: string; assigneeMemberId: string; assignedAt: Date; dueAt: Date | null; decidedAt: Date | null; step: { route: { subjectType: string; subjectId: string } } }): KpiTaskItem => ({
    taskId: t.id,
    subjectType: t.step.route.subjectType,
    subjectId: t.step.route.subjectId,
    assigneeMemberId: t.assigneeMemberId,
    assignedAt: t.assignedAt.toISOString(),
    dueAt: t.dueAt?.toISOString() ?? null,
    decidedAt: t.decidedAt?.toISOString() ?? null,
    minutes: t.decidedAt ? businessMinutesBetween(t.assignedAt, t.decidedAt, calendar) : null,
  })
  const decidedTasks = await tx.approvalTask.findMany({ where: { decidedAt: occurredAt }, include: { step: { include: { route: true } } } })
  const decisionMinutes: number[] = []
  const decidedItems: KpiTaskItem[] = []
  for (const t of decidedTasks) {
    if (!(await inScope(t.step.route.subjectType, t.step.route.subjectId))) continue
    decisionMinutes.push(businessMinutesBetween(t.assignedAt, t.decidedAt!, calendar))
    decidedItems.push(taskItem(t))
  }
  const assigned = await tx.approvalTask.findMany({ where: { assignedAt: occurredAt }, include: { step: { include: { route: true } } } })
  let pastDue = 0
  let assignedInScope = 0
  const pastDueItems: KpiTaskItem[] = []
  const assignedItems: KpiAssignedTaskItem[] = []
  const end = period.to < period.now ? period.to : period.now
  for (const t of assigned) {
    if (!(await inScope(t.step.route.subjectType, t.step.route.subjectId))) continue
    assignedInScope++
    const item = taskItem(t)
    const mark = pastDueMark(t, end)
    if (isPastDue(mark)) {
      pastDue++
      pastDueItems.push(item)
    }
    assignedItems.push({ ...item, pastDue: mark })
  }

  // ----- G-4 -----
  const submits = await tx.event.findMany({ where: { type: { in: ['request.submitted', 'request.resubmitted'] }, occurredAt }, select: { aggregateId: true, data: true } })
  let g4 = 0
  const g4Items: KpiTaskItem[] = []
  for (const s of submits) {
    const check = (s.data as { budgetCheck?: { availableSatang?: string; reservedSatang?: string } }).budgetCheck
    const failed = !check || BigInt(check.reservedSatang ?? '0') > BigInt(check.availableSatang ?? '0')
    if (!failed || !(await inScope('REQUEST', s.aggregateId))) continue
    const tasks = await tx.approvalTask.findMany({ where: { step: { route: { subjectType: 'REQUEST', subjectId: s.aggregateId } } }, include: { step: { include: { route: true } } } })
    g4 += tasks.length
    g4Items.push(...tasks.map(taskItem))
  }

  // ----- G-5 -----
  const approvals = decisions.filter((d) => !d.review)
  const bySubject: Record<string, { numerator: number; denominator: number }> = {}
  for (const d of approvals) {
    const kind = d.data.subjectType === 'REQUEST' ? ('PURCHASE_REQUEST' satisfies DoaDocumentType) : d.data.subjectType
    bySubject[kind] ??= { numerator: 0, denominator: 0 }
    bySubject[kind].denominator++
    if (MOBILE.has(d.channel)) bySubject[kind].numerator++
  }

  return {
    result: {
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      g1: { numerator: g1, denominator: null },
      g2: { misrouted, checked, withDoaReference: { numerator: withReference, denominator: decisions.length } },
      g3: { submitToPoMedianMinutes: median(submitToPo), decisionMedianMinutes: median(decisionMinutes), pastDue: { numerator: pastDue, denominator: assignedInScope } },
      g4: { tasksOnFailedBudgetCheck: g4 },
      g5: { total: { numerator: approvals.filter((d) => MOBILE.has(d.channel)).length, denominator: approvals.length }, bySubject },
    },
    items: { g1: g1Items, decisions: decisionItems, g3SubmitToPo: submitToPoItems, g3Decisions: decidedItems, g3PastDue: pastDueItems, g3Assigned: assignedItems, g4: g4Items },
  }
}

/**
 * G-3 (c) of one assigned task, at the end of the period (or now, if that is earlier): a task with no due time is never
 * past due; a decided one is past due when it was decided after its due time; an open one, or one waiting for the
 * requester's answer, when the end is past its due time; one closed without a decision (cancelled, reassigned) is not
 */
function pastDueMark(t: { status: string; dueAt: Date | null; decidedAt: Date | null }, end: Date): KpiPastDueMark {
  if (!t.dueAt) return 'NO_DUE_TIME'
  if (t.decidedAt) return t.decidedAt > t.dueAt ? 'PAST_DUE_DECIDED' : 'DECIDED_ON_TIME'
  if (t.status === 'OPEN' || t.status === 'INFO_REQUESTED') return end > t.dueAt ? 'PAST_DUE_OPEN' : 'OPEN_NOT_DUE'
  return 'CLOSED_UNDECIDED'
}

/** The kind of document of a decision as G-5 groups it (the DOA's document types) */
export const kpiDocumentKind = (subjectType: string): string => (subjectType === 'REQUEST' ? ('PURCHASE_REQUEST' satisfies DoaDocumentType) : subjectType)

/** Decisions made on LINE count as mobile (G-5) */
export const isMobileChannel = (channel: string): boolean => MOBILE.has(channel)
