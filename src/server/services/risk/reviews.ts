import { z } from 'zod'
import type { AppError, Result } from '@/core/result'
import { riskReviewOutcome, type ReviewDecision } from '@/core/risk'
import { checkSod } from '@/core/sod'
import { REVIEW_TASK_MACHINE, RISK_ASSESSMENT_MACHINE, transition, type ReviewTaskCommand, type ReviewTaskState, type RiskAssessmentState } from '@/core/state-machines'
import { reresolveOpenTasks, resolveReviewer, type OpenTaskOnTree, type ReviewerSpec } from '@/core/workflow'
import { RISK_TEXT_MAX } from '@/lib/constants'
import { riskSettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { effectiveSodPolicy, loadOrgSnapshot } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { OutboxDraft } from '@/server/events/outbox'
import type { NotificationDraft } from '@/server/notifications/create'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { reviewDecidersIn, riskReviewTaskPage, riskReviewTaskReaders, riskReviewTasksOf, type RiskReviewTaskPage, type RiskReviewTaskRow } from '@/server/queries/risk-review'
import { workflowVersionFromRows } from '@/server/workflow/snapshot'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { issuePortalLink } from '../suppliers/links'
import { completeAssessment } from './assessments'
import { preparersOf, visibleDomains } from './reviewers'
import { RISK_SUPPLIER_TEMPLATES } from './templates'

// The reviewers' decisions (S11-06 · FR-RSK-202 AC3 AC5 · BR-RSK-07 BR-RSK-08 BR-RSK-19 · BR-SOD-16 · INV-RSK-04):
// - riskReview.decide: the holder of a slot (or who acts for them now) passes or returns the assessment; no rejection
//   (BR-WF-09), no step-up. A return needs a reason, kept as a Comment; ticked "may go to the supplier", its words become
//   the assessment's returnReason and the supplier's e-mail. Every slot passed → COMPLETED; one return → RETURNED and the
//   other open tasks of the round CANCELLED (STEP_DECIDED). The assessment's row is locked first, so two slots decided at
//   the same moment give one outcome (BR-RSK-19).
// - reresolveReviewTasks: after an org change (ADR-108), the open tasks found from the tree go to their new holder with
//   the core of S6 (reresolveOpenTasks). A round has one task per slot (the unique key of ReviewTask), so the task keeps
//   its row and its slot and changes hands (review_task.reassigned).
// - the timers of job risk-review-task-sla: reminded half way, overdue at dueAt, the rule's fallback told at escalateAt
//   (for its information; no co-reviewer is added, a reviewer has no next band · BR-SLA-02).

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })

const loadTask = (tx: TenantTx, id: string) => tx.reviewTask.findFirst({ where: { id } })

function moveTask(task: { status: string }, command: ReviewTaskCommand): ReviewTaskState | null {
  const t = transition(REVIEW_TASK_MACHINE, task.status as ReviewTaskState, command)
  return t.ok ? t.to : null
}

/** Who may decide a reviewer's task now (INV-RSK-04): the one rule, kept with the reviewer's pages (queries/risk-review.ts) */
export const reviewDeciders = reviewDecidersIn

// ---------- riskReview.decide ----------

const DecideInput = z
  .strictObject({
    taskId: z.uuid(),
    decision: z.enum(['PASS', 'RETURN']),
    /** Required to return: what is missing or wrong, for PROCUREMENT and the auditors */
    reason: z.string().trim().min(1).max(RISK_TEXT_MAX).optional(),
    /** The reviewer allows the reason's words to reach the supplier (BR-RSK-08) */
    shareWithSupplier: z.boolean().default(false),
  })
  .refine((v) => v.decision === 'PASS' || Boolean(v.reason), { path: ['reason'], message: 'a return needs a reason' })

export interface DecideResult {
  readonly taskId: string
  readonly decision: ReviewDecision
  readonly assessment: 'IN_REVIEW' | 'COMPLETED' | 'RETURNED'
}

const decideCommand = defineCommand({
  name: 'riskReview.decide',
  capability: 'risk.review.decide',
  input: DecideInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<DecideResult>> {
    const on = await requireModule(ctx, 'RISK', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const found = await loadTask(tx, input.taskId)
    if (!found) return fail('NOT_FOUND', 'review task not found')
    // the assessment's row first: the tasks of a round are decided one after another (BR-RSK-19)
    await lockRowsForUpdate(tx, 'RiskAssessment', ctx.organizationId, [found.assessmentId])
    const task = (await loadTask(tx, input.taskId))!
    const a = await tx.riskAssessment.findUniqueOrThrow({
      where: { id: task.assessmentId },
      select: { id: true, number: true, supplierId: true, status: true, reviewRound: true, openedById: true, filledOnBehalfById: true, submittedByContactId: true, tier: true, answers: { select: { answeredByMemberId: true } } },
    })
    const preparers = preparersOf(a)
    const allowed = await authorize(tx, ctx, 'risk.review.decide', { deciderMemberIds: await reviewDeciders(tx, task, preparers, ctx.now) })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'members only')
    const actorMemberId = allowed.data.memberId
    const command: ReviewTaskCommand = input.decision === 'PASS' ? 'riskReview.pass' : 'riskReview.return'
    const to = moveTask(task, command)
    if (!to || a.status !== 'IN_REVIEW' || a.reviewRound !== task.reviewRound) {
      const by = task.decidedById ? await tx.member.findUnique({ where: { id: task.decidedById }, select: { displayNameTh: true, displayNameEn: true } }) : null
      return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${task.status}`, {
        from: task.status,
        command,
        ...(by ? { name: by.displayNameTh, nameEn: by.displayNameEn ?? by.displayNameTh } : {}),
        ...(task.decidedAt ? { time: task.decidedAt.toISOString() } : {}),
      })
    }
    // BR-SOD-16: who opened or filled in the assessment never reviews it — whether they decide or the task is theirs
    const sodPolicy = await effectiveSodPolicy(tx, ctx.now)
    for (const who of [actorMemberId, task.delegatorMemberId].filter((m): m is string => Boolean(m))) {
      const sod = checkSod({ kind: 'DECIDE_RISK_REVIEW', actorMemberId: who, assessmentPreparerMemberIds: preparers }, sodPolicy)
      if (!sod.ok) {
        return {
          ok: false,
          error: { code: 'SOD_VIOLATION', message: 'separation of duties', details: { rule: sod.rule } },
          auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: a.id, data: { rule: sod.rule, action: 'riskReview.decide', subjectType: 'RiskAssessment', subjectId: a.id, actorMemberId } }],
        }
      }
    }

    const events: EventDraft[] = []
    const notifications: NotificationDraft[] = []
    let outbox: OutboxDraft[] = []
    let reasonCommentId: string | null = null
    if (input.decision === 'RETURN') {
      const comment = await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'RiskAssessment', subjectId: a.id, authorMemberId: actorMemberId, body: input.reason! }, select: { id: true } })
      reasonCommentId = comment.id
    }
    await tx.reviewTask.update({ where: { id: task.id }, data: { status: to, decidedAt: ctx.now, decidedById: actorMemberId, reasonCommentId, version: { increment: 1 } } })
    events.push({
      type: 'review_task.decided',
      aggregateType: 'ReviewTask',
      aggregateId: task.id,
      data: {
        assessmentId: a.id,
        decision: input.decision,
        workflowVersionId: task.workflowVersionId,
        ruleCodes: task.ruleCodes,
        slotNo: task.slotNo,
        reviewRound: task.reviewRound,
        decidedById: actorMemberId,
        onBehalfOf: actorMemberId === task.assigneeMemberId ? null : task.assigneeMemberId,
        shareWithSupplier: input.decision === 'RETURN' ? input.shareWithSupplier : false,
      },
    })

    const round = await tx.reviewTask.findMany({ where: { assessmentId: a.id, reviewRound: task.reviewRound, status: { not: 'CANCELLED' } }, select: { id: true, slotNo: true, ruleCodes: true, status: true } })
    const outcome = riskReviewOutcome(round.map((t) => ({ slotNo: t.slotNo, ruleCodes: t.ruleCodes, decision: t.status === 'PASSED' ? 'PASS' : t.status === 'RETURNED' ? 'RETURN' : null })))
    if (outcome === 'OPEN') {
      await tx.riskAssessment.update({ where: { id: a.id }, data: { version: { increment: 1 } } })
      return { ok: true, result: { taskId: task.id, decision: input.decision, assessment: 'IN_REVIEW' }, events, notifications }
    }

    if (outcome === 'RETURNED') {
      const moved = transition(RISK_ASSESSMENT_MACHINE, a.status as RiskAssessmentState, 'riskReview.return')
      if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `riskReview.return is not allowed from ${a.status}`, { from: a.status })
      for (const other of round.filter((t) => t.status === 'OPEN')) {
        await tx.reviewTask.update({ where: { id: other.id }, data: { status: 'CANCELLED', cancelledWhy: 'STEP_DECIDED', version: { increment: 1 } } })
        events.push({ type: 'review_task.cancelled', aggregateType: 'ReviewTask', aggregateId: other.id, data: { assessmentId: a.id, why: 'STEP_DECIDED' } })
      }
      const shared = input.shareWithSupplier ? input.reason! : null
      await tx.riskAssessment.update({ where: { id: a.id }, data: { status: moved.to, returnReason: shared, lastActivityAt: ctx.now, version: { increment: 1 } } })
      events.push({ type: 'risk_assessment.returned', aggregateType: 'RiskAssessment', aggregateId: a.id, data: { reviewRound: task.reviewRound, byTaskId: task.id, reasonShared: shared !== null } })
      notifications.push(openerNotice(a, 'risk.assessment_returned'))
      const told = await tellSupplier(tx, ctx, a, { templateKey: RISK_SUPPLIER_TEMPLATES.returned, data: { number: a.number ?? '', reason: shared }, withLink: true, memberId: actorMemberId })
      events.push(...told.events)
      notifications.push(...told.notifications)
      outbox = told.outbox
      return { ok: true, result: { taskId: task.id, decision: input.decision, assessment: 'RETURNED' }, events, notifications, outbox }
    }

    const moved = transition(RISK_ASSESSMENT_MACHINE, a.status as RiskAssessmentState, 'risk_review.all_passed')
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `risk_review.all_passed is not allowed from ${a.status}`, { from: a.status })
    await tx.riskAssessment.update({ where: { id: a.id }, data: { version: { increment: 1 } } })
    events.push(...(await completeAssessment(tx, ctx, a.id)))
    notifications.push(openerNotice(a, 'risk.assessment_completed'))
    const told = await tellSupplier(tx, ctx, a, { templateKey: RISK_SUPPLIER_TEMPLATES.completed, data: { number: a.number ?? '', tier: a.tier }, withLink: false, memberId: actorMemberId })
    events.push(...told.events)
    notifications.push(...told.notifications)
    return { ok: true, result: { taskId: task.id, decision: input.decision, assessment: 'COMPLETED' }, events, notifications, outbox: told.outbox }
  },
})

/** BR-NOTI-12: who opened the assessment hears of its outcome in the day's digest */
const openerNotice = (a: { id: string; number: string | null; openedById: string }, templateKey: string): NotificationDraft => ({
  recipientMemberId: a.openedById,
  templateKey,
  data: { assessmentId: a.id, number: a.number },
  urgency: 'DIGEST',
  dedupeKey: `${templateKey}:${a.id}:${templateKey}`,
  subjectType: 'RiskAssessment',
  subjectId: a.id,
})

/**
 * The supplier's e-mail of an outcome (BR-NOTI-12): to the contact who sent it, else the supplier's primary active contact;
 * a return carries only the words the reviewer allowed (BR-RSK-08) and, when the portal answers for the supplier, a new
 * link to answer again (BR-RSK-17).
 */
async function tellSupplier(
  tx: TenantTx,
  ctx: Ctx,
  a: { id: string; supplierId: string; submittedByContactId: string | null },
  notice: { templateKey: string; data: Record<string, unknown>; withLink: boolean; memberId: string },
): Promise<{ events: EventDraft[]; notifications: NotificationDraft[]; outbox: OutboxDraft[] }> {
  const none = { events: [] as EventDraft[], notifications: [] as NotificationDraft[], outbox: [] as OutboxDraft[] }
  const sender = a.submittedByContactId ? await tx.supplierContact.findFirst({ where: { id: a.submittedByContactId, status: 'ACTIVE' }, select: { id: true } }) : null
  const contact = sender ?? (await tx.supplierContact.findFirst({ where: { supplierId: a.supplierId, status: 'ACTIVE' }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { id: true } }))
  if (!contact) return none
  const events: EventDraft[] = []
  let link: { url: string; expiresAt: string } | null = null
  if (notice.withLink) {
    const [org, supplier] = await Promise.all([
      tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { code: true, settings: true } }),
      tx.supplier.findUniqueOrThrow({ where: { id: a.supplierId }, select: { portalEnabled: true } }),
    ])
    if (riskSettingsOf(org.settings).portalAnswering && supplier.portalEnabled) {
      const issued = await issuePortalLink(tx, { organizationId: ctx.organizationId, orgCode: org.code, contactId: contact.id, purpose: 'RISK_QUESTIONNAIRE', now: ctx.now, supplierId: a.supplierId, createdById: notice.memberId })
      link = { url: issued.url, expiresAt: issued.expiresAt.toISOString() }
      events.push({ type: 'portal_session.link_requested', aggregateType: 'SupplierContact', aggregateId: contact.id, data: { contactId: contact.id, linkId: issued.linkId, purpose: 'RISK_QUESTIONNAIRE' } })
    }
  }
  const sent = await enqueueSupplierNotice(tx, ctx, {
    templateKey: notice.templateKey,
    supplierId: a.supplierId,
    contactId: contact.id,
    subjectType: 'RiskAssessment',
    subjectId: a.id,
    dedupeKey: `${notice.templateKey}:${a.id}:${ctx.now.toISOString()}`,
    data: { ...notice.data, ...(link ?? {}) },
  })
  return { events: [...events, ...sent.events], notifications: sent.notifications, outbox: sent.outbox }
}

export const decideRiskReview = (ctx: Ctx, input: z.input<typeof DecideInput>, options: RunOptions) => runCommand(ctx, decideCommand, input, options)

// ---------- after an org change: the open tasks follow the tree (ADR-108 · S6's org-authority calls this) ----------

/** The spec a task was found with: the rule's reviewer, or its fallback when the task went to the fallback */
function specOf(rule: { reviewers: readonly ReviewerSpec[]; fallback: ReviewerSpec | null } | undefined, fallbackUsed: string): ReviewerSpec | null {
  if (!rule) return null
  return fallbackUsed === 'NONE' ? (rule.reviewers[0] ?? null) : rule.fallback
}

/**
 * Moves every open reviewer's task of a risk assessment whose position now lands on someone else (BR-WF-14 as S6-08):
 * found again with reresolveOpenTasks of src/core/workflow at `at`, each still OPEN after its assessment's row is locked
 * changes hands in place (one task per slot of a round). A task whose new holder is missing or prepared the assessment
 * stays where it is. Appends its events and notices to the caller's.
 */
export async function reresolveReviewTasks(tx: TenantTx, ctx: Ctx, at: Date, out: { readonly events: EventDraft[]; readonly notifications: NotificationDraft[] }): Promise<{ moved: number; stuck: number }> {
  const open = await tx.reviewTask.findMany({
    where: { status: 'OPEN' },
    select: { id: true, assessmentId: true, ruleCodes: true, fallbackUsed: true, assigneeMemberId: true, delegatorMemberId: true, workflowVersionId: true },
  })
  if (open.length === 0) return { moved: 0, stuck: 0 }
  const versions = await tx.workflowVersion.findMany({ where: { id: { in: [...new Set(open.map((t) => t.workflowVersionId))] } }, include: { rules: true } })
  const rulesOf = new Map(versions.map((v) => [v.id, workflowVersionFromRows(v, v.rules).rules]))
  const assessments = await tx.riskAssessment.findMany({
    where: { id: { in: [...new Set(open.map((t) => t.assessmentId))] } },
    select: { id: true, number: true, tier: true, openedById: true, filledOnBehalfById: true, answers: { select: { answeredByMemberId: true } }, supplier: { select: { nameTh: true, payeeType: true } } },
  })
  const preparers = new Map(assessments.map((a) => [a.id, preparersOf(a)]))
  const onTree: OpenTaskOnTree[] = []
  for (const t of open) {
    // a slot's rules share its holder (BR-WF-02): the first rule's spec finds it again
    const spec = specOf(rulesOf.get(t.workflowVersionId)?.find((r) => r.code === t.ruleCodes[0]), t.fallbackUsed)
    if (!spec || spec.kind !== 'POSITION_AT') continue
    onTree.push({ id: t.id, resolvedFrom: `POSITION:${spec.position}@${spec.department}`, approver: spec, chargedDepartmentId: '', assigneeMemberId: t.assigneeMemberId, principalMemberId: t.delegatorMemberId, conflictMemberIds: preparers.get(t.assessmentId) ?? [] })
  }
  const found = reresolveOpenTasks(onTree, await loadOrgSnapshot(tx), at)
  if (found.reassign.length > 0) await lockRowsForUpdate(tx, 'RiskAssessment', ctx.organizationId, [...new Set(found.reassign.map((r) => open.find((t) => t.id === r.task)!.assessmentId))])
  let moved = 0
  for (const r of found.reassign) {
    const task = await tx.reviewTask.findUniqueOrThrow({ where: { id: r.task } })
    if (!moveTask(task, 'reviewTask.reassign')) continue
    // the slot's holder never holds another slot of the round (BR-WF-02): such a task stays for ORG_ADMIN to reassign
    const other = await tx.reviewTask.count({ where: { assessmentId: task.assessmentId, reviewRound: task.reviewRound, id: { not: task.id }, status: { not: 'CANCELLED' }, assigneeMemberId: r.to } })
    if (other > 0) continue
    await tx.reviewTask.update({ where: { id: task.id }, data: { assigneeMemberId: r.to, delegatorMemberId: null, version: { increment: 1 } } })
    out.events.push({ type: 'review_task.reassigned', aggregateType: 'ReviewTask', aggregateId: task.id, data: { assessmentId: task.assessmentId, fromMemberId: task.assigneeMemberId, toMemberId: r.to, why: 'ORG_AUTHORITY_CHANGE' } })
    const assessment = assessments.find((a) => a.id === task.assessmentId)
    out.notifications.push({
      recipientMemberId: r.to,
      templateKey: 'risk.review_assigned',
      data: {
        assessmentId: task.assessmentId,
        taskId: task.id,
        number: assessment?.number ?? null,
        // a sole proprietor is named by the number only (BR-NOTI-01 as at the send)
        supplierName: assessment && assessment.supplier.payeeType !== 'INDIVIDUAL' ? assessment.supplier.nameTh : null,
        tier: assessment?.tier ?? null,
        riskDomains: task.riskDomains,
        dueAt: task.dueAt.toISOString(),
        reassigned: true,
      },
      urgency: 'IMMEDIATE',
      dedupeKey: `risk.review_assigned:${task.id}:${r.to}`,
      subjectType: 'RiskAssessment',
      subjectId: task.assessmentId,
    })
    moved++
  }
  return { moved, stuck: found.stuck.length + (found.reassign.length - moved) }
}

// ---------- the timers of a reviewer's task (job risk-review-task-sla) ----------

export interface ReviewTaskPlan {
  readonly taskId: string
  readonly open: boolean
  readonly remindAt: string | null
  readonly dueAt: string | null
  readonly escalateAt: string | null
}

/** The timers of an open task, or none: a decided, cancelled or missing task has nothing to wait for */
export async function planReviewTaskSla(organizationId: string, taskId: string): Promise<ReviewTaskPlan> {
  return forTenant(organizationId).$transaction(async (tx) => {
    const t = await tx.reviewTask.findFirst({ where: { id: taskId }, select: { status: true, remindAt: true, dueAt: true, escalateAt: true } })
    if (!t || t.status !== 'OPEN') return { taskId, open: false, remindAt: null, dueAt: null, escalateAt: null }
    return { taskId, open: true, remindAt: t.remindAt?.toISOString() ?? null, dueAt: t.dueAt.toISOString(), escalateAt: t.escalateAt?.toISOString() ?? null }
  })
}

const TIMER_KINDS = ['REMIND', 'OVERDUE', 'ESCALATE'] as const
type TimerKind = (typeof TIMER_KINDS)[number]
const COMMAND_OF: Readonly<Record<TimerKind, ReviewTaskCommand>> = { REMIND: 'reviewTask.remind', OVERDUE: 'reviewTask.overdue', ESCALATE: 'reviewTask.escalate' }
const AT_OF: Readonly<Record<TimerKind, 'remindAt' | 'dueAt' | 'escalateAt'>> = { REMIND: 'remindAt', OVERDUE: 'dueAt', ESCALATE: 'escalateAt' }

const timerCommand = defineCommand({
  name: 'reviewTask.timer',
  capability: 'system.risk',
  input: z.strictObject({ taskId: z.uuid(), kind: z.enum(TIMER_KINDS) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ told: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'the timers are the system’s')
    const on = await requireModule(ctx, 'RISK', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const task = await loadTask(tx, input.taskId)
    if (!task) return fail('NOT_FOUND', 'review task not found')
    if (!moveTask(task, COMMAND_OF[input.kind])) return fail('INVALID_STATE_TRANSITION', `${COMMAND_OF[input.kind]} is not allowed from ${task.status}`, { from: task.status, reason: 'CLOSED' })
    const due = task[AT_OF[input.kind]]
    if (!due || due.getTime() > ctx.now.getTime()) return fail('VALIDATION_FAILED', 'not due yet', { reason: 'NOT_DUE', waitMs: due ? due.getTime() - ctx.now.getTime() : null })
    const a = await tx.riskAssessment.findUniqueOrThrow({ where: { id: task.assessmentId }, select: { id: true, number: true, openedById: true, filledOnBehalfById: true, answers: { select: { answeredByMemberId: true } } } })
    const data = { assessmentId: a.id, taskId: task.id, number: a.number, dueAt: task.dueAt.toISOString() }
    const notify = (memberId: string, templateKey: string, extra: Record<string, unknown> = {}): NotificationDraft => ({
      recipientMemberId: memberId,
      templateKey,
      data: { ...data, ...extra },
      urgency: 'IMMEDIATE',
      dedupeKey: `${templateKey}:${task.id}:${memberId}`,
      subjectType: 'RiskAssessment',
      subjectId: a.id,
    })
    if (input.kind === 'REMIND') {
      return { ok: true, result: { told: 1 }, events: [{ type: 'review_task.reminded', aggregateType: 'ReviewTask', aggregateId: task.id, data: { assessmentId: a.id } }], notifications: [notify(task.assigneeMemberId, 'risk.review_reminder')] }
    }
    if (input.kind === 'OVERDUE') {
      return { ok: true, result: { told: 1 }, events: [{ type: 'review_task.overdue', aggregateType: 'ReviewTask', aggregateId: task.id, data: { assessmentId: a.id, dueAt: task.dueAt.toISOString() } }], notifications: [notify(task.assigneeMemberId, 'risk.review_overdue')] }
    }
    // escalateAt: the fallback of the slot's rule hears of it for its information; with nobody to tell, ORG_ADMIN does
    const version = await tx.workflowVersion.findUniqueOrThrow({ where: { id: task.workflowVersionId }, include: { rules: true } })
    const rule = workflowVersionFromRows(version, version.rules).rules.find((r) => r.code === task.ruleCodes[0])
    const fallback = rule?.fallback ? resolveReviewer(rule.fallback, await loadOrgSnapshot(tx), ctx.now) : null
    const preparers = preparersOf(a)
    const recipients =
      fallback && fallback.memberId !== task.assigneeMemberId && !preparers.includes(fallback.memberId)
        ? [fallback.memberId]
        : [...new Set((await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })).map((r) => r.memberId))]
    return {
      ok: true,
      result: { told: recipients.length },
      events: [{ type: 'review_task.escalated', aggregateType: 'ReviewTask', aggregateId: task.id, data: { assessmentId: a.id, notifiedMemberIds: recipients, toFallback: Boolean(fallback && recipients[0] === fallback.memberId) } }],
      notifications: recipients.map((m) => notify(m, 'risk.review_escalated', { role: 'ACK' })),
    }
  },
})

export interface ReviewTimerResult {
  readonly done: boolean
  readonly reason: string | null
  readonly waitMs: number | null
}

/** One timer of the job, by the system: done, or why not (CLOSED ends the run, NOT_DUE waits the time left) */
export async function runReviewTaskTimer(organizationId: string, taskId: string, kind: TimerKind, now: Date): Promise<ReviewTimerResult> {
  const r = await runCommand(systemCtx(organizationId, now, 'risk-review-task-sla'), timerCommand, { taskId, kind }, { idempotencyKey: `risk-review-task-sla:${kind}:${taskId}` })
  if (r.ok) return { done: true, reason: null, waitMs: null }
  const d = r.error.details ?? {}
  const reason = typeof d.reason === 'string' ? d.reason : r.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : r.error.code
  return { done: false, reason, waitMs: typeof d.waitMs === 'number' ? d.waitMs : null }
}

// ---------- the reviewer's pages (risk.review.view · BR-RSK-08) ----------

/** The member's reviewer tasks (RISK on): open ones to decide, or the ones they decided */
export async function riskReviewTasks(ctx: Ctx, which: 'OPEN' | 'DONE'): Promise<Result<RiskReviewTaskRow[]>> {
  const on = await requireModule(ctx, 'RISK')
  if (!on.ok) return on
  return { ok: true, data: await riskReviewTasksOf(ctx, which) }
}

/**
 * One reviewer's task: risk.review.view for whoever may decide it now or decided it (ASSIGNED), then the page of the
 * slot's own domains only. Anyone else reads NOT_FOUND, as if it did not exist.
 */
export async function riskReviewTask(ctx: Ctx, taskId: string): Promise<Result<RiskReviewTaskPage>> {
  const on = await requireModule(ctx, 'RISK')
  if (!on.ok) return on
  const readers = await riskReviewTaskReaders(ctx, taskId)
  const may = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'risk.review.view', { assigneeMemberIds: readers }))
  if (!may.ok || readers.length === 0) return fail('NOT_FOUND', 'review task not found')
  const page = await riskReviewTaskPage(ctx, taskId)
  return page ? { ok: true, data: page } : fail('NOT_FOUND', 'review task not found')
}

export { visibleDomains }
