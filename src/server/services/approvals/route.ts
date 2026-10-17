import { DOC_TYPE_TRAITS, resolveRoute, type RouteInput, type RouteResult, type RouteSlot, type RouteStep } from '@/core/doa'
import { err, ok, type Result } from '@/core/result'
import { addBusinessMinutes, remindAt, type BusinessCalendar } from '@/core/sla'
import type { ApprovalSubject } from '@/core/sod'
import { resolveRequestRoute, type ReviewSlot, type ReviewStep } from '@/core/workflow'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar, loadRoutePolicy } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { loadWorkflowVersions, type ReviewFacts } from '@/server/workflow/policy'

// Approval routes (spec §7.4, §6.2, BR-DOA-01..11): every submit or resubmit resolves a new route with the DOA engine
// and stores it as ApprovalRoute → ApprovalStep → ApprovalTask. An old route is never edited; a replaced route is
// CANCELLED. Steps follow one another; the first step gets its tasks at once — one, or one per slot of a committee.
// A purchase request whose facts match rules of the workflow version in effect starts with one REVIEW step (S6 ·
// BR-WF-06): stepNo 1, no DOA step number, every slot's reviewers at once; the DOA steps follow under the next numbers,
// each keeping the step number resolveRoute gave it (doaStepNo), by which the next step finds its approvers.

/** APPROVAL_SUBJECTS of src/core/sod: the one list of subjects */
export type { ApprovalSubject }

/** When the assignee is reminded, as a share of the SLA (BR-SLA-02, OQ-06: half way) */
const DEFAULT_REMIND_SHARE = 0.5
const PERCENT = 100

/**
 * The reminder share of a DOA version (DoaVersion.escalationPolicy.remindPct): the DOA_Policy sheet and the seed
 * keep it as a share of the SLA (0.5), while core remindAt takes a percent (GC-SLA-07: 50). Anything outside 0..1
 * falls back to the default.
 */

/**
 * The document's number in a task's notices, when it has one (S17-10, BR-NOTI-06): what a push shows on a locked
 * screen. The label stays for the other channels; a label may be a title or an item, never shown by push.
 */
const numberOf = (subject: { readonly number?: string | null }) => (subject.number ? { number: subject.number } : {})

export function remindShareOf(escalationPolicy: unknown): number {
  const value = Number((escalationPolicy as { remindPct?: unknown } | null)?.remindPct ?? DEFAULT_REMIND_SHARE)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_REMIND_SHARE
}

export interface StartedRoute {
  readonly route: RouteResult
  readonly routeId: string
  readonly firstTask: { readonly id: string; readonly assigneeMemberId: string; readonly principalMemberId: string | null; readonly dueAt: Date }
  readonly events: EventDraft[]
  readonly notifications: NotificationDraft[]
}

/** Times of a newly assigned task (BR-SLA-01..03): due after its SLA in business time, reminded part-way (a share). */
export function taskTimes(assignedAt: Date, slaMinutes: number, remindShare: number, calendar: BusinessCalendar): { dueAt: Date; remindAt: Date } {
  return { dueAt: addBusinessMinutes(assignedAt, slaMinutes, calendar), remindAt: remindAt({ assignedAt, slaMinutes, remindPct: Math.round(remindShare * PERCENT) }, calendar) }
}

/**
 * Resolves the route of a document and stores it with its first task, inside the caller's command transaction. A
 * refusal of the engine (DOA_NOT_CONFIGURED, APPROVER_NOT_FOUND, NO_HIGHER_AUTHORITY, REVIEWER_NOT_FOUND, …) comes back
 * unchanged and nothing is written. `review`: the facts of a purchase request for its reviewers (BR-WF-06); without
 * them the route is the DOA's alone.
 */
export async function startRoute(
  tx: TenantTx,
  ctx: Ctx,
  subject: { readonly type: ApprovalSubject; readonly id: string; readonly label: string; readonly number?: string | null },
  input: RouteInput,
  review?: ReviewFacts,
): Promise<Result<StartedRoute>> {
  // BR-DOA-20: a subject routes only with a document type that lists it (DOC_TYPE_TRAITS)
  if (!DOC_TYPE_TRAITS[input.documentType].subjects.includes(subject.type)) {
    return err('VALIDATION_FAILED', `${subject.type} does not route with ${input.documentType}`, { reason: 'SUBJECT', subjectType: subject.type, documentType: input.documentType })
  }
  const policy = await loadRoutePolicy(tx)
  if (review && input.documentType === 'PURCHASE_REQUEST') {
    const resolved = resolveRequestRoute(input, review, { ...policy, workflows: await loadWorkflowVersions(tx) })
    if (!resolved.ok) return resolved
    return storeRoute(tx, ctx, subject, resolved.data.approval, resolved.data.review)
  }
  const resolved = resolveRoute(input, policy)
  if (!resolved.ok) return resolved
  return storeRoute(tx, ctx, subject, resolved.data)
}

/**
 * Stores a route with its first task: one the DOA engine resolved, or the initial package's route to the contract
 * signatory (BR-DOA-19), which no DOA can resolve because none is in effect yet.
 */
export async function storeRoute(
  tx: TenantTx,
  ctx: Ctx,
  subject: { readonly type: ApprovalSubject; readonly id: string; readonly label: string; readonly number?: string | null },
  route: RouteResult,
  review: ReviewStep | null = null,
): Promise<Result<StartedRoute>> {
  if (route.steps.length === 0) return err('APPROVER_NOT_FOUND', 'the route has no approver', { ruleCode: route.ruleCode })

  const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: route.doaVersionId }, select: { escalationPolicy: true } })
  const remindShare = remindShareOf(version.escalationPolicy)
  const calendar = await loadBusinessCalendar(tx, ctx.organizationId)

  // Replaced routes of the same document are cancelled with their open tasks (BR-DOA-09)
  const routeNo = (await tx.approvalRoute.count({ where: { subjectType: subject.type, subjectId: subject.id } })) + 1
  const created = await tx.approvalRoute.create({
    data: {
      organizationId: ctx.organizationId,
      subjectType: subject.type,
      subjectId: subject.id,
      routeNo,
      doaVersionId: route.doaVersionId,
      ruleCode: route.ruleCode,
      escalatedFromRuleCode: route.escalatedFromRuleCode,
      amountBasis: route.amountBasis,
      amountSatang: route.basisAmountSatang,
      explanationTh: route.explanationTh,
      // The time the route was made by the command's clock: a later step reads the holders of then against it (S6-08)
      createdAt: ctx.now,
      workflowVersionId: review?.workflowVersionId ?? null,
    },
    select: { id: true },
  })

  let first: StartedRoute['firstTask'] | null = null
  const events: EventDraft[] = []
  const notifications: NotificationDraft[] = []
  if (review) {
    // BR-WF-06: the REVIEW step comes first, its groups kept for stepOutcome (BR-WF-01); its SLA is its slots' most
    const reviewRow = await tx.approvalStep.create({
      data: {
        organizationId: ctx.organizationId,
        routeId: created.id,
        stepNo: 1,
        kind: 'REVIEW',
        doaStepNo: null,
        reviewGroups: review.groups.map((g) => ({ ruleCodes: [...g.ruleCodes], quorum: g.quorum, quorumCount: g.quorumCount, slotNos: [...g.slotNos] })),
        mode: 'PARALLEL',
        quorum: 'ALL',
        quorumCount: null,
        slaBusinessMinutes: review.slaBusinessMinutes,
        status: 'ACTIVE',
      },
      select: { id: true },
    })
    const assigned = await assignReviewTasks(tx, ctx, { stepId: reviewRow.id, routeId: created.id }, review, subject, { remindShare, calendar })
    first = assigned.first
    events.push(...assigned.events)
    notifications.push(...assigned.notifications)
  }
  const offset = review ? 1 : 0
  for (const step of route.steps) {
    const isFirst: boolean = first === null
    const stepRow: { id: string } = await tx.approvalStep.create({
      // A DOA step: its doaStepNo is its place in the rule, as resolveRoute gave it (ruleStepNo · BR-WF-06); a committee keeps its quorum
      data: {
        organizationId: ctx.organizationId,
        routeId: created.id,
        stepNo: step.stepNo + offset,
        doaStepNo: step.ruleStepNo,
        slaBusinessMinutes: step.slaBusinessMinutes,
        status: isFirst ? 'ACTIVE' : 'WAITING',
        ...stepModeOf(step),
      },
      select: { id: true },
    })
    if (!isFirst) continue
    const assigned = await assignStepTasks(tx, ctx, { stepId: stepRow.id, stepNo: step.stepNo + offset, routeId: created.id, slaBusinessMinutes: step.slaBusinessMinutes }, step, subject, { remindShare, calendar })
    first = assigned.first
    events.push(...assigned.events)
    notifications.push(...assigned.notifications)
  }
  return ok({ route, routeId: created.id, firstTask: first!, events, notifications })
}

/** The mode and quorum an ApprovalStep row keeps: a committee's (BR-WF-01), or the defaults of a step of one approver */
export function stepModeOf(step: RouteStep): { mode: 'SEQUENTIAL' | 'PARALLEL'; quorum: 'ALL' | 'ANY' | 'COUNT'; quorumCount: number | null } {
  return step.committee ? { mode: 'PARALLEL', quorum: step.committee.quorum, quorumCount: step.committee.quorumCount } : { mode: 'SEQUENTIAL', quorum: 'ALL', quorumCount: null }
}

/** The slots a step's tasks fill: a committee's, or the one approver of a step of one approver as slot 1 */
export const slotsOf = (step: RouteStep): readonly RouteSlot[] =>
  step.committee?.slots ?? [{ slotNo: 1, assigneeMemberId: step.assigneeMemberId, principalMemberId: step.principalMemberId, resolvedFrom: step.resolvedFrom, notifyOrgAdmin: step.notifyOrgAdmin }]

export interface AssignedStep {
  /** The task of slot 1 */
  readonly first: StartedRoute['firstTask']
  readonly events: EventDraft[]
  readonly notifications: NotificationDraft[]
}

/**
 * The tasks of a step that starts: one per slot, all at once (§6.4 ApprovalStep with slots), each told to its holder.
 * A step of one approver is slot 1 and its events say what they said before S6; a committee's add slotNo.
 */
export async function assignStepTasks(
  tx: TenantTx,
  ctx: Ctx,
  row: { readonly stepId: string; readonly stepNo: number; readonly routeId: string; readonly slaBusinessMinutes: number },
  step: RouteStep,
  subject: { readonly type: ApprovalSubject; readonly id: string; readonly label: string; readonly number?: string | null },
  timing: { readonly remindShare: number; readonly calendar: BusinessCalendar },
): Promise<AssignedStep> {
  const times = taskTimes(ctx.now, row.slaBusinessMinutes, timing.remindShare, timing.calendar)
  const events: EventDraft[] = []
  const notifications: NotificationDraft[] = []
  let first: StartedRoute['firstTask'] | null = null
  for (const slot of slotsOf(step)) {
    const task: { id: string } = await tx.approvalTask.create({
      data: {
        organizationId: ctx.organizationId,
        stepId: row.stepId,
        slotNo: slot.slotNo,
        assigneeMemberId: slot.assigneeMemberId,
        principalMemberId: slot.principalMemberId,
        resolvedFrom: slot.resolvedFrom,
        assignedAt: ctx.now,
        dueAt: times.dueAt,
        remindAt: times.remindAt,
      },
      select: { id: true },
    })
    first ??= { id: task.id, assigneeMemberId: slot.assigneeMemberId, principalMemberId: slot.principalMemberId, dueAt: times.dueAt }
    events.push({
      type: 'approval_task.assigned',
      aggregateType: 'ApprovalTask',
      aggregateId: task.id,
      data: {
        subjectType: subject.type,
        subjectId: subject.id,
        routeId: row.routeId,
        stepNo: row.stepNo,
        assigneeMemberId: slot.assigneeMemberId,
        principalMemberId: slot.principalMemberId,
        resolvedFrom: slot.resolvedFrom,
        dueAt: times.dueAt.toISOString(),
        ...(step.committee ? { slotNo: slot.slotNo } : {}),
      },
    })
    notifications.push({
      recipientMemberId: slot.assigneeMemberId,
      templateKey: 'task.assigned',
      data: { subjectType: subject.type, subjectId: subject.id, label: subject.label, ...numberOf(subject), taskId: task.id, dueAt: times.dueAt.toISOString() },
      urgency: 'IMMEDIATE',
      dedupeKey: `task.assigned:${task.id}`,
      subjectType: subject.type,
      subjectId: subject.id,
    })
    // BR-DLG-05: the delegate conflicts with the document, so the task stayed with the delegator; ORG_ADMIN is told
    if (slot.notifyOrgAdmin) {
      const admins = await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
      for (const memberId of new Set(admins.map((a) => a.memberId))) {
        notifications.push({
          recipientMemberId: memberId,
          templateKey: 'approval_task.delegate_conflict',
          data: { subjectType: subject.type, subjectId: subject.id, label: subject.label, ...numberOf(subject), taskId: task.id },
          urgency: 'IMMEDIATE',
          dedupeKey: `approval_task.delegate_conflict:${task.id}:${memberId}`,
          subjectType: subject.type,
          subjectId: subject.id,
        })
      }
    }
  }
  return { first: first!, events, notifications }
}

/**
 * The tasks of a REVIEW step (BR-WF-06, BR-WF-15): every reviewer of every slot at once — a slot of the ANY rules has a
 * task per reviewer, whoever decides first decides it — each due after its slot's SLA, with the rules it answers for.
 * approval_task.assigned names the slot, the workflow version and the rules (INV-WF-04); the reviewer is told with
 * task.review_assigned. A delegate who conflicts with the request left the task with the delegator: ORG_ADMIN is told.
 */
async function assignReviewTasks(
  tx: TenantTx,
  ctx: Ctx,
  row: { readonly stepId: string; readonly routeId: string },
  review: ReviewStep,
  subject: { readonly type: ApprovalSubject; readonly id: string; readonly label: string; readonly number?: string | null },
  timing: { readonly remindShare: number; readonly calendar: BusinessCalendar },
): Promise<AssignedStep> {
  const events: EventDraft[] = []
  const notifications: NotificationDraft[] = []
  let first: StartedRoute['firstTask'] | null = null
  const admins = review.slots.some((s) => s.assignees.some((a) => a.notifyOrgAdmin))
    ? [...new Set((await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })).map((a) => a.memberId))]
    : []
  for (const slot of review.slots) {
    const times = taskTimes(ctx.now, slot.slaBusinessMinutes, timing.remindShare, timing.calendar)
    for (const a of slot.assignees) {
      const task: { id: string } = await tx.approvalTask.create({
        data: {
          organizationId: ctx.organizationId,
          stepId: row.stepId,
          slotNo: slot.slotNo,
          workflowRuleCodes: [...slot.ruleCodes],
          assigneeMemberId: a.assigneeMemberId,
          principalMemberId: a.principalMemberId,
          resolvedFrom: a.resolvedFrom,
          assignedAt: ctx.now,
          dueAt: times.dueAt,
          remindAt: times.remindAt,
        },
        select: { id: true },
      })
      first ??= { id: task.id, assigneeMemberId: a.assigneeMemberId, principalMemberId: a.principalMemberId, dueAt: times.dueAt }
      events.push({
        type: 'approval_task.assigned',
        aggregateType: 'ApprovalTask',
        aggregateId: task.id,
        data: {
          subjectType: subject.type,
          subjectId: subject.id,
          routeId: row.routeId,
          stepNo: 1,
          assigneeMemberId: a.assigneeMemberId,
          principalMemberId: a.principalMemberId,
          resolvedFrom: a.resolvedFrom,
          dueAt: times.dueAt.toISOString(),
          ...reviewFieldsOf(review, slot),
        },
      })
      notifications.push({
        recipientMemberId: a.assigneeMemberId,
        templateKey: 'task.review_assigned',
        data: { subjectType: subject.type, subjectId: subject.id, label: subject.label, ...numberOf(subject), taskId: task.id, dueAt: times.dueAt.toISOString(), ruleCodes: [...slot.ruleCodes] },
        urgency: 'IMMEDIATE',
        dedupeKey: `task.review_assigned:${task.id}`,
        subjectType: subject.type,
        subjectId: subject.id,
      })
      if (a.notifyOrgAdmin) {
        for (const memberId of admins) {
          notifications.push({
            recipientMemberId: memberId,
            templateKey: 'approval_task.delegate_conflict',
            data: { subjectType: subject.type, subjectId: subject.id, label: subject.label, ...numberOf(subject), taskId: task.id },
            urgency: 'IMMEDIATE',
            dedupeKey: `approval_task.delegate_conflict:${task.id}:${memberId}`,
            subjectType: subject.type,
            subjectId: subject.id,
          })
        }
      }
    }
  }
  return { first: first!, events, notifications }
}

/** What the events of a reviewer's task add (INV-WF-04): the slot, the workflow version and the rules it answers for */
export const reviewFieldsOf = (review: Pick<ReviewStep, 'workflowVersionId'>, slot: Pick<ReviewSlot, 'slotNo' | 'ruleCodes'>) => ({
  slotNo: slot.slotNo,
  workflowVersionId: review.workflowVersionId,
  workflowRuleCodes: [...slot.ruleCodes],
})

/** Cancels the open tasks and the active route of a document (cancel, resubmit, final decision). */
export async function closeRoute(
  tx: TenantTx,
  subject: { readonly type: ApprovalSubject; readonly id: string },
  routeStatus: 'COMPLETED' | 'CANCELLED',
  // ALREADY_EFFECTIVE (S6-07): a withdrawal still asked when its version took effect
  why: 'REQUEST_CANCELLED' | 'ROUTE_REPLACED' | 'DOCUMENT_DECIDED' | 'ALREADY_EFFECTIVE',
): Promise<EventDraft[]> {
  const routes = await tx.approvalRoute.findMany({ where: { subjectType: subject.type, subjectId: subject.id, status: 'ACTIVE' }, select: { id: true } })
  const events: EventDraft[] = []
  for (const route of routes) {
    const open = await tx.approvalTask.findMany({ where: { step: { routeId: route.id }, status: { in: ['OPEN', 'INFO_REQUESTED'] } }, select: { id: true } })
    for (const task of open) {
      await tx.approvalTask.update({ where: { id: task.id }, data: { status: 'CANCELLED' } })
      events.push({ type: 'approval_task.cancelled', aggregateType: 'ApprovalTask', aggregateId: task.id, data: { subjectId: subject.id, why } })
    }
    await tx.approvalStep.updateMany({ where: { routeId: route.id, status: { in: ['WAITING', 'ACTIVE'] } }, data: { status: routeStatus === 'COMPLETED' ? 'DONE' : 'CANCELLED' } })
    await tx.approvalRoute.update({ where: { id: route.id }, data: { status: routeStatus } })
  }
  return events
}
