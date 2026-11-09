import { z } from 'zod'
import { err, ok, type AppError, type Result } from '@/core/result'
import { riskReviewers, type RiskDomain, type RiskReviewStep, type RiskTierCode, type Screening } from '@/core/risk'
import { addBusinessMinutes, remindAt, type BusinessCalendar } from '@/core/sla'
import { systemCtx, type Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar, loadDelegations, loadOrgSnapshot } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { OutboxDraft } from '@/server/events/outbox'
import type { NotificationDraft } from '@/server/notifications/create'
import { assessmentPreparers, domainsSeenBy } from '@/server/queries/risk-review'
import { loadWorkflowVersions } from '@/server/workflow/policy'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { DEFAULT_ESCALATE_AFTER_MINUTES } from '../sla/policy'

// The reviewers of a sent assessment (BR-RSK-07 · ADR-222 · FR-RSK-202 AC1 AC3): the rules of RISK_ASSESSMENT scope of
// the workflow version in effect at the send, resolved by riskReviewers (resolveReviewStep of S6, the engine unchanged),
// become one ReviewTask per slot of the round, all at once. No rule matches → no task, and the assessment completes at the
// send. A rule with neither its reviewer nor its fallback refuses the send (REVIEWER_NOT_FOUND), and ORG_ADMIN and
// DOA_ADMIN are told by a second command that outlives the refusal (as request.report_doa_gap · NEW-27).

/** BR-SLA-02 (OQ-06): a reviewer is reminded half way through the slot's SLA */
const REMIND_PERCENT = 50

export interface ReviewSlots {
  readonly tasks: number
  readonly workflowVersionId: string | null
  readonly events: EventDraft[]
  readonly notifications: NotificationDraft[]
  readonly outbox: OutboxDraft[]
}

/** What the reviewers of an assessment are found from (its row as the send reads it) */
export interface AssessmentForReviewers {
  readonly id: string
  readonly number: string | null
  readonly supplierId: string
  readonly screening: unknown
  readonly categoryCodes: readonly string[]
  readonly payeeType: string
  readonly inherentTier: RiskTierCode
  readonly openedById: string
  readonly filledOnBehalfById: string | null
  readonly answers: ReadonlyArray<{ readonly answeredByMemberId: string | null }>
}

/**
 * The members who prepared the assessment: who opened it and everyone who filled it in for the supplier. None of them
 * reviews it — the resolve passes them over (GC-RSK-28) and riskReview.decide refuses them (BR-SOD-16).
 */
export const preparersOf = assessmentPreparers

/** The timers of a reviewer's task (BR-SLA-02): due after the slot's SLA, reminded half way, escalated 480 minutes after due */
export function reviewTaskTimes(assignedAt: Date, slaMinutes: number, calendar: BusinessCalendar): { dueAt: Date; remindAt: Date; escalateAt: Date } {
  const dueAt = addBusinessMinutes(assignedAt, slaMinutes, calendar)
  return { dueAt, remindAt: remindAt({ assignedAt, slaMinutes, remindPct: REMIND_PERCENT }, calendar), escalateAt: addBusinessMinutes(dueAt, DEFAULT_ESCALATE_AFTER_MINUTES, calendar) }
}

/** The step of reviewers the version in effect at `at` names for the assessment; null = no rule matches */
export async function resolveAssessmentReviewers(tx: TenantTx, a: AssessmentForReviewers, tier: RiskTierCode, at: Date): Promise<Result<RiskReviewStep | null>> {
  const [versions, org, delegations] = await Promise.all([loadWorkflowVersions(tx), loadOrgSnapshot(tx), loadDelegations(tx)])
  const preparers = preparersOf(a)
  return riskReviewers(
    versions,
    {
      screening: a.screening as Screening,
      tier,
      inherentTier: a.inherentTier,
      categoryCodes: a.categoryCodes,
      payeeType: a.payeeType,
      openedById: a.openedById,
      filledOnBehalfByIds: preparers.filter((m) => m !== a.openedById),
      at,
    },
    org,
    delegations,
  )
}

/** The questions a slot's reviewer sees: GENERAL and the slot's domains (BR-RSK-08 · the one rule of the reviewer's pages) */
export const visibleDomains = (riskDomains: readonly string[]): string[] => domainsSeenBy(riskDomains)

/**
 * The tasks of a round of reviewers, inside the send's transaction: one per slot, each due after its slot's SLA, its holder
 * told at once with the supplier, the tier, the domains and how many questions it reads — never an answer (BR-NOTI-01).
 * `questions` = the domains of the assessment's set of questions.
 */
export async function reviewSlotsFor(
  tx: TenantTx,
  ctx: Ctx,
  assessment: AssessmentForReviewers,
  tier: RiskTierCode,
  round: number,
  questions: ReadonlyArray<{ readonly domain: string }>,
): Promise<Result<ReviewSlots>> {
  const resolved = await resolveAssessmentReviewers(tx, assessment, tier, ctx.now)
  if (!resolved.ok) return resolved
  const none: ReviewSlots = { tasks: 0, workflowVersionId: null, events: [], notifications: [], outbox: [] }
  if (resolved.data === null) return ok(none)
  const step = resolved.data
  const calendar = await loadBusinessCalendar(tx, ctx.organizationId)
  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: assessment.supplierId }, select: { nameTh: true, payeeType: true } })
  // BR-NOTI-01 as BR-NOTI ข้อ 10: a sole proprietor is named by the assessment's number only
  const supplierName = supplier.payeeType === 'INDIVIDUAL' ? null : supplier.nameTh
  const admins = step.slots.some((s) => s.assignees.some((x) => x.notifyOrgAdmin))
    ? [...new Set((await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })).map((r) => r.memberId))]
    : []
  const events: EventDraft[] = []
  const notifications: NotificationDraft[] = []
  for (const slot of step.slots) {
    // every RISK rule names one reviewer of quorum ALL (WF_LINT_RISK_QUORUM), so a slot has one holder
    if (slot.assignees.length !== 1) throw new Error(`a reviewer slot of a risk assessment has ${slot.assignees.length} holders (WF_LINT_RISK_QUORUM)`)
    const holder = slot.assignees[0]!
    const groupNo = step.groups.findIndex((g) => g.slotNos.includes(slot.slotNo)) + 1
    const times = reviewTaskTimes(ctx.now, slot.slaBusinessMinutes, calendar)
    const task = await tx.reviewTask.create({
      data: {
        organizationId: ctx.organizationId,
        assessmentId: assessment.id,
        reviewRound: round,
        workflowVersionId: step.workflowVersionId,
        ruleCodes: [...slot.ruleCodes],
        groupNo,
        slotNo: slot.slotNo,
        quorum: 'ALL',
        riskDomains: [...slot.riskDomains],
        assigneeMemberId: holder.assigneeMemberId,
        delegatorMemberId: holder.principalMemberId,
        fallbackUsed: slot.fallback ?? 'NONE',
        assignedAt: ctx.now,
        dueAt: times.dueAt,
        remindAt: times.remindAt,
        escalateAt: times.escalateAt,
      },
      select: { id: true },
    })
    events.push({
      type: 'review_task.assigned',
      aggregateType: 'ReviewTask',
      aggregateId: task.id,
      data: {
        assessmentId: assessment.id,
        reviewRound: round,
        workflowVersionId: step.workflowVersionId,
        ruleCodes: [...slot.ruleCodes],
        slotNo: slot.slotNo,
        riskDomains: [...slot.riskDomains],
        assigneeMemberId: holder.assigneeMemberId,
        delegatorMemberId: holder.principalMemberId,
        fallbackUsed: slot.fallback ?? 'NONE',
        dueAt: times.dueAt.toISOString(),
        reassigned: false,
      },
    })
    const domains = visibleDomains(slot.riskDomains)
    notifications.push({
      recipientMemberId: holder.assigneeMemberId,
      templateKey: 'risk.review_assigned',
      data: {
        assessmentId: assessment.id,
        taskId: task.id,
        number: assessment.number,
        supplierName,
        tier,
        riskDomains: [...slot.riskDomains],
        questionCount: questions.filter((q) => domains.includes(q.domain)).length,
        dueAt: times.dueAt.toISOString(),
      },
      urgency: 'IMMEDIATE',
      dedupeKey: `risk.review_assigned:${task.id}`,
      subjectType: 'RiskAssessment',
      subjectId: assessment.id,
    })
    // BR-DLG-05: the acting holder prepared the assessment, so the task stayed with the holder; ORG_ADMIN is told
    if (holder.notifyOrgAdmin) {
      for (const memberId of admins) {
        notifications.push({
          recipientMemberId: memberId,
          templateKey: 'risk.review_delegate_conflict',
          data: { assessmentId: assessment.id, taskId: task.id, number: assessment.number },
          urgency: 'IMMEDIATE',
          dedupeKey: `risk.review_delegate_conflict:${task.id}:${memberId}`,
          subjectType: 'RiskAssessment',
          subjectId: assessment.id,
        })
      }
    }
  }
  events.unshift({
    type: 'risk_assessment.reviewers_assigned',
    aggregateType: 'RiskAssessment',
    aggregateId: assessment.id,
    data: { workflowVersionId: step.workflowVersionId, reviewRound: round, tasks: step.slots.length },
  })
  return ok({ tasks: step.slots.length, workflowVersionId: step.workflowVersionId, events, notifications, outbox: [] })
}

// ---------- REVIEWER_NOT_FOUND: told to the administrators after the refused send ----------

const Text = z.string().trim().min(1).max(100)
const GapInput = z.strictObject({ assessmentId: z.uuid(), ruleCode: Text.nullable(), position: Text.nullable(), department: Text.nullable() })

const reportReviewerGapCommand = defineCommand({
  name: 'riskAssessment.report_reviewer_gap',
  capability: 'system.risk',
  input: GapInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ admins: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'reported by the system after a refused send' } }
    const a = await tx.riskAssessment.findFirst({ where: { id: input.assessmentId }, select: { id: true, number: true } })
    if (!a) return { ok: false, error: { code: 'NOT_FOUND', message: 'assessment not found' } }
    const admins = await tx.roleAssignment.findMany({ where: { role: { in: ['ORG_ADMIN', 'DOA_ADMIN'] }, revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
    const adminIds = [...new Set(admins.map((r) => r.memberId))]
    const gap = [input.ruleCode ?? '-', input.position ?? '-', input.department ?? '-'].join(':')
    return {
      ok: true,
      result: { admins: adminIds.length },
      events: [
        {
          type: 'risk_assessment.reviewer_gap_reported',
          aggregateType: 'RiskAssessment',
          aggregateId: a.id,
          data: { ruleCode: input.ruleCode, position: input.position, department: input.department, notifiedAdmins: adminIds.length },
        },
      ],
      notifications: adminIds.map((memberId) => ({
        recipientMemberId: memberId,
        templateKey: 'risk.reviewer_gap',
        data: { assessmentId: a.id, number: a.number, ruleCode: input.ruleCode, position: input.position, department: input.department },
        urgency: 'IMMEDIATE' as const,
        dedupeKey: `risk.reviewer_gap:${a.id}:${gap}:${memberId}`,
        subjectType: 'RiskAssessment',
        subjectId: a.id,
      })),
    }
  },
})

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

/**
 * After a send refused with REVIEWER_NOT_FOUND (FR-RSK-202 AC1): ORG_ADMIN and DOA_ADMIN are told, in a transaction of its
 * own and by the system (the sender may be the supplier's contact). Returns how many were told, or null.
 */
export async function reportReviewerGap(ctx: Ctx, assessmentId: string, error: AppError, options: RunOptions): Promise<number | null> {
  if (error.code !== 'REVIEWER_NOT_FOUND') return null
  const d = error.details ?? {}
  const reported = await runCommand(
    systemCtx(ctx.organizationId, ctx.now, 'risk-reviewer-gap'),
    reportReviewerGapCommand,
    { assessmentId, ruleCode: text(d.rule), position: text(d.position), department: text(d.department) },
    { ...options, idempotencyKey: `${options.idempotencyKey}:reviewer-gap` },
  )
  return reported.ok ? reported.data.admins : null
}

/** The refusal of a send, with how many administrators were told of a missing reviewer (details.adminsNotified) */
export async function withReviewerGapReport<T>(ctx: Ctx, assessmentId: unknown, result: Result<T>, options: RunOptions): Promise<Result<T>> {
  if (result.ok || typeof assessmentId !== 'string') return result
  const notified = await reportReviewerGap(ctx, assessmentId, result.error, options)
  if (notified === null) return result
  return err(result.error.code, result.error.message, { ...result.error.details, adminsNotified: notified })
}

export type { RiskDomain }
