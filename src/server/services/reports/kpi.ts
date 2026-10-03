import { resolveRoute, type DoaDocumentType, type RouteInput } from '@/core/doa'
import { vatFromNet } from '@/core/money/math'
import { businessMinutesBetween } from '@/core/sla'
import type { TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar, loadRoutePolicy } from '@/server/doa/policy'

// The KPIs of the first tier (spec §11.4, §1 G-1 to G-5, FR-VIS-003 AC1), computed from Event and the transaction
// tables only (P-8), over a period [from, to). Ratios are kept as numerator and denominator (no floating point); times
// are business minutes on the organization's calendar (§7.8). Scope narrows the documents to departments (§2.4
// report.view for a department head); null is the whole organization.
//  G-1  POs approved ÷ purchase documents in the accounting system — the denominator comes from the monthly Express
//       import, not available yet (S4-14), so only the numerator is known
//  G-2  (a) decisions whose decider is not who the DOA engine gives for that step at the route's time (re-run)
//       (b) decision events that name the DOA version and rule in their columns ÷ all decisions
//  G-3  median business time from a request's submit to its first PO approval · median business time a task waited
//       for its decision · tasks decided after their due time, or open past it at the end, ÷ all tasks assigned
//  G-4  tasks assigned on requests whose budget check did not pass
//  G-5  decisions on LINE (chat or LIFF) ÷ all decisions, in all and per kind of document

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

export async function computeKpis(tx: TenantTx, organizationId: string, period: { from: Date; to: Date; now: Date }, departmentIds: readonly string[] | null): Promise<KpiResult> {
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
  const approvedPos = await tx.event.findMany({ where: { type: 'po.approved', occurredAt }, select: { aggregateId: true } })
  let g1 = 0
  for (const e of approvedPos) if (await inScope('PURCHASE_ORDER', e.aggregateId)) g1++

  // ----- decisions (G-2, G-5) -----
  const decisionEvents = await tx.event.findMany({ where: { type: 'approval_task.decided', occurredAt }, orderBy: { seq: 'asc' } })
  const decisions: Array<{ data: DecisionData; channel: string; doaVersionId: string | null; doaRuleCode: string | null; taskId: string }> = []
  for (const e of decisionEvents) {
    const data = e.data as unknown as DecisionData
    if (await inScope(data.subjectType, data.subjectId)) decisions.push({ data, channel: e.channel, doaVersionId: e.doaVersionId, doaRuleCode: e.doaRuleCode, taskId: e.aggregateId })
  }
  const policy = await loadRoutePolicy(tx)
  let misrouted = 0
  let checked = 0
  for (const d of decisions) {
    const task = await tx.approvalTask.findUnique({ where: { id: d.taskId }, include: { step: { include: { route: true } } } })
    if (!task) continue
    const input = await routeInput(tx, d.data.subjectType, d.data.subjectId, task.step.route.createdAt)
    if (!input) continue
    checked++
    const again = resolveRoute(input, policy)
    const step = again.ok ? again.data.steps.find((s) => s.stepNo === task.step.stepNo) : undefined
    const allowed = new Set([step?.assigneeMemberId, step?.principalMemberId].filter((m): m is string => Boolean(m)))
    // the decider: the delegate who acted, or the approver themself; a delegator acting on their own task counts
    if (!allowed.has(d.data.actorMemberId)) misrouted++
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
  for (const [requestId, approvedAt] of firstPoOf) {
    const r = await tx.request.findUnique({ where: { id: requestId }, select: { submittedAt: true, chargedDepartmentId: true } })
    if (!r?.submittedAt) continue
    if (departmentIds !== null && !departmentIds.includes(r.chargedDepartmentId)) continue
    submitToPo.push(businessMinutesBetween(r.submittedAt, approvedAt, calendar))
  }
  const decidedTasks = await tx.approvalTask.findMany({ where: { decidedAt: occurredAt }, include: { step: { include: { route: true } } } })
  const decisionMinutes: number[] = []
  for (const t of decidedTasks) {
    if (!(await inScope(t.step.route.subjectType, t.step.route.subjectId))) continue
    decisionMinutes.push(businessMinutesBetween(t.assignedAt, t.decidedAt!, calendar))
  }
  const assigned = await tx.approvalTask.findMany({ where: { assignedAt: occurredAt }, include: { step: { include: { route: true } } } })
  let pastDue = 0
  let assignedInScope = 0
  const end = period.to < period.now ? period.to : period.now
  for (const t of assigned) {
    if (!(await inScope(t.step.route.subjectType, t.step.route.subjectId))) continue
    assignedInScope++
    if (!t.dueAt) continue
    if (t.decidedAt ? t.decidedAt > t.dueAt : (t.status === 'OPEN' || t.status === 'INFO_REQUESTED') && end > t.dueAt) pastDue++
  }

  // ----- G-4 -----
  const submits = await tx.event.findMany({ where: { type: { in: ['request.submitted', 'request.resubmitted'] }, occurredAt }, select: { aggregateId: true, data: true } })
  let g4 = 0
  for (const s of submits) {
    const check = (s.data as { budgetCheck?: { availableSatang?: string; reservedSatang?: string } }).budgetCheck
    const failed = !check || BigInt(check.reservedSatang ?? '0') > BigInt(check.availableSatang ?? '0')
    if (!failed || !(await inScope('REQUEST', s.aggregateId))) continue
    g4 += await tx.approvalTask.count({ where: { step: { route: { subjectType: 'REQUEST', subjectId: s.aggregateId } } } })
  }

  // ----- G-5 -----
  const bySubject: Record<string, { numerator: number; denominator: number }> = {}
  for (const d of decisions) {
    const kind = d.data.subjectType === 'REQUEST' ? ('PURCHASE_REQUEST' satisfies DoaDocumentType) : d.data.subjectType
    bySubject[kind] ??= { numerator: 0, denominator: 0 }
    bySubject[kind].denominator++
    if (MOBILE.has(d.channel)) bySubject[kind].numerator++
  }

  return {
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    g1: { numerator: g1, denominator: null },
    g2: { misrouted, checked, withDoaReference: { numerator: withReference, denominator: decisions.length } },
    g3: { submitToPoMedianMinutes: median(submitToPo), decisionMedianMinutes: median(decisionMinutes), pastDue: { numerator: pastDue, denominator: assignedInScope } },
    g4: { tasksOnFailedBudgetCheck: g4 },
    g5: { total: { numerator: decisions.filter((d) => MOBILE.has(d.channel)).length, denominator: decisions.length }, bySubject },
  }
}
