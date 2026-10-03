import { checkSod } from '@/core/sod'
import type { TaskState } from '@/core/state-machines'
import { systemClock } from '@/lib/clock'
import { newId } from '@/lib/ids'
import type { Ctx } from '@/server/context'
import { consumeStepUp } from '@/server/auth/step-up'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { comparisonBaselineId } from '@/server/queries/doa'
import type { CommandOutcome } from '../_pipeline'
import { laterVersionScheduled, publishApprovedDoaVersion } from '../doa'
import { boundaryTableRequiredFor } from '../doa/boundary'
import { isInitialPackageRoute } from '../doa/initial-package'
import { approveOrgChange, rejectOrgChange } from '../org-authority'
import { closeRoute } from './route'

// Approving policy (spec BR-DOA-15, FR-DOA-002 AC2–AC3, FR-DOA-010 AC2): a DOA version or an authority change is
// decided by the approver of its DOA_CHANGE or ORG_AUTHORITY_CHANGE rule — or, for the initial package, by the contract
// signatory (BR-DOA-19) — with a step-up every time, on the web or LIFF only; the submitter never approves their own
// (BR-SOD-06, BR-SOD-08). A policy route is approved or rejected, not returned. The holders of an initial package are
// authority changes on the same route and follow its decision. A DOA version is approved only with its boundary table
// ticked as checked whenever it has one — the table the drafter ticked to send it (FR-DOA-009 AC3) — and a tick given
// for a table compared with another version than the one compared now (another version approved in between) is
// refused; rejecting needs no tick, and authority changes have no table.

export interface PolicyTask {
  readonly id: string
  readonly stepId: string
  readonly principalMemberId: string | null
  readonly step: { readonly route: { readonly id: string; readonly subjectType: string; readonly subjectId: string; readonly doaVersionId: string; readonly ruleCode: string } }
}

export async function decidePolicyTask(
  tx: TenantTx,
  ctx: Ctx,
  task: PolicyTask,
  input: {
    readonly decision: 'APPROVE' | 'RETURN' | 'REJECT'
    readonly reason?: string | undefined
    readonly boundaryTableConfirmed?: boolean | undefined
    readonly boundaryBaselineId?: string | null | undefined
  },
  taskTo: TaskState,
): Promise<CommandOutcome<{ taskId: string; documentStatus: string }>> {
  const route = task.step.route
  const subjectType = route.subjectType as 'DOA_VERSION' | 'ORG_AUTHORITY_CHANGE'
  const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member decides' } }
  if (input.decision === 'RETURN') return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'policy is approved or rejected', details: { field: 'decision', reason: 'RETURN_NOT_ALLOWED' } } }
  if (ctx.channel !== 'WEB' && ctx.channel !== 'LIFF') return { ok: false, error: { code: 'FORBIDDEN', message: 'policy is decided on the web or LIFF only', details: { reason: 'CHANNEL' } } }

  const table = subjectType === 'DOA_VERSION' ? 'DoaVersion' : 'OrgAuthorityChange'
  const [locked] = await lockRowsForUpdate(tx, table, ctx.organizationId, [route.subjectId])
  if (!locked) return { ok: false, error: { code: 'NOT_FOUND', message: 'subject not found' } }
  const submitter =
    subjectType === 'DOA_VERSION'
      ? (await tx.doaVersion.findUniqueOrThrow({ where: { id: route.subjectId }, select: { submittedById: true } })).submittedById
      : (await tx.orgAuthorityChange.findUniqueOrThrow({ where: { id: route.subjectId }, select: { submittedById: true } })).submittedById

  // The submitter never decides their own policy change, nor does the delegator of a delegate who decides
  for (const who of [actor, task.principalMemberId].filter((m): m is string => Boolean(m))) {
    const sod = checkSod({ kind: 'DECIDE_APPROVAL', subject: subjectType, actorMemberId: who, requesterMemberIds: submitter ? [submitter] : [] }, { approverMayReceive: false, requesterMayReceive: true })
    if (!sod.ok) {
      return {
        ok: false,
        error: { code: 'SOD_VIOLATION', message: 'separation of duties', details: { rule: sod.rule } },
        auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: route.subjectId, data: { rule: sod.rule, action: `approval.${input.decision.toLowerCase()}`, subjectType, subjectId: route.subjectId, actorMemberId: actor } }],
      }
    }
  }

  // FR-DOA-009 AC3: the approver's tick of the boundary table, read only when approving a DOA version; recorded on the
  // decision when the version has a table to tick
  let boundaryTicked = false
  if (subjectType === 'DOA_VERSION' && input.decision === 'APPROVE') {
    const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: route.subjectId }, select: { id: true, code: true, effectiveFrom: true } })
    const startsAt = version.effectiveFrom.getTime() < ctx.now.getTime() ? ctx.now : version.effectiveFrom
    const later = await laterVersionScheduled(tx, version, startsAt)
    if (later) return later
    // The table of the version beside the one it replaces, as the decision page shows it and the send asked the drafter
    // to tick (src/server/services/doa/boundary.ts). A tick that names the version its table compared with is a tick of
    // that table only: once another version is compared — one approved in between moved the baseline — the table
    // approved is not the one ticked. Both refusals come before the step-up is used, so the grant stays for the
    // approval that follows with the tick of the table as it is now.
    const ticked = input.boundaryTableConfirmed === true
    if (ticked && input.boundaryBaselineId !== undefined && input.boundaryBaselineId !== (await comparisonBaselineId(tx, version, ctx.now))) {
      return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the boundary table changed after it was ticked', details: { field: 'boundaryTableConfirmed', reason: 'BOUNDARY_TABLE_CHANGED' } } }
    }
    if (await boundaryTableRequiredFor(tx, version.id, ctx.now)) {
      if (!ticked) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the boundary table must be confirmed', details: { field: 'boundaryTableConfirmed', reason: 'BOUNDARY_NOT_CONFIRMED' } } }
      boundaryTicked = true
    }
  }

  // BR-DOA-15: a step-up for this document, given in the last 5 minutes (security clock), used once
  const stepUpGrantId = await consumeStepUp(tx, { memberId: actor, subjectType, subjectId: route.subjectId }, systemClock.now())
  if (!stepUpGrantId) return { ok: false, error: { code: 'STEP_UP_REQUIRED', message: 'enter your authenticator code again to approve policy', details: { subjectType, subjectId: route.subjectId } } }

  let reasonCommentId: string | null = null
  if (input.decision === 'REJECT') {
    reasonCommentId = newId()
    await tx.comment.create({ data: { id: reasonCommentId, organizationId: ctx.organizationId, subjectType, subjectId: route.subjectId, authorMemberId: actor, body: input.reason! } })
  }
  await tx.approvalTask.update({
    where: { id: task.id },
    data: { status: taskTo, decision: input.decision, decidedAt: ctx.now, decidedByMemberId: actor, channel: ctx.channel, reason: input.reason ?? null, version: { increment: 1 } },
  })
  await tx.approvalStep.update({ where: { id: task.stepId }, data: { status: 'DONE' } })
  const events: EventDraft[] = [
    {
      type: 'approval_task.decided',
      aggregateType: 'ApprovalTask',
      aggregateId: task.id,
      doaVersionId: route.doaVersionId,
      doaRuleCode: route.ruleCode,
      ...(task.principalMemberId && actor !== task.principalMemberId ? { onBehalfOfMemberId: task.principalMemberId } : {}),
      data: {
        decision: input.decision,
        subjectType,
        subjectId: route.subjectId,
        doaVersionId: route.doaVersionId,
        doaRuleCode: route.ruleCode,
        channel: ctx.channel,
        actorMemberId: actor,
        onBehalfOfMemberId: task.principalMemberId && actor !== task.principalMemberId ? task.principalMemberId : null,
        reasonCommentId,
        stepUpGrantId,
        ...(boundaryTicked ? { boundaryTableConfirmed: true } : {}),
      },
    },
  ]
  const notifications: NotificationDraft[] = []
  const waiting = await tx.approvalStep.count({ where: { routeId: route.id, status: 'WAITING' } })
  if (input.decision === 'APPROVE' && waiting > 0) {
    return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'policy routes with more than one step arrive with parallel approval (S6)', details: { reason: 'MULTI_STEP' } } }
  }
  events.push(...(await closeRoute(tx, { type: subjectType, id: route.subjectId }, input.decision === 'APPROVE' ? 'COMPLETED' : 'CANCELLED', 'DOCUMENT_DECIDED')))
  let documentStatus: string
  if (subjectType === 'DOA_VERSION') {
    const packageChanges = isInitialPackageRoute(route)
      ? await tx.orgAuthorityChange.findMany({ where: { routeId: route.id, status: 'PENDING_APPROVAL' }, select: { id: true }, orderBy: { id: 'asc' } })
      : []
    if (input.decision === 'APPROVE') {
      events.push(...(await publishApprovedDoaVersion(tx, ctx, route.subjectId, actor)))
      for (const change of packageChanges) {
        const approved = await approveOrgChange(tx, ctx, change.id)
        events.push(...approved.events)
        notifications.push(...approved.notifications)
      }
      documentStatus = 'PUBLISHED'
    } else {
      const v = await tx.doaVersion.update({ where: { id: route.subjectId }, data: { status: 'REJECTED', version: { increment: 1 } }, select: { code: true, versionNo: true } })
      events.push({ type: 'doa_version.rejected', aggregateType: 'DoaVersion', aggregateId: route.subjectId, data: { code: v.code, versionNo: v.versionNo, reasonCommentId: reasonCommentId! } })
      for (const change of packageChanges) events.push(...(await rejectOrgChange(tx, ctx, change.id)))
      documentStatus = 'REJECTED'
    }
  } else if (input.decision === 'APPROVE') {
    const approved = await approveOrgChange(tx, ctx, route.subjectId)
    events.push(...approved.events)
    notifications.push(...approved.notifications)
    documentStatus = (await tx.orgAuthorityChange.findUniqueOrThrow({ where: { id: route.subjectId }, select: { status: true } })).status
  } else {
    events.push(...(await rejectOrgChange(tx, ctx, route.subjectId)))
    documentStatus = 'REJECTED'
  }
  if (submitter) {
    notifications.push({
      recipientMemberId: submitter,
      templateKey: `${subjectType === 'DOA_VERSION' ? 'doa_version' : 'org_authority_change'}.${input.decision === 'APPROVE' ? 'approved' : 'rejected'}`,
      data: { subjectId: route.subjectId, taskId: task.id },
      urgency: 'IMMEDIATE',
      dedupeKey: `policy.decided:${task.id}`,
      subjectType,
      subjectId: route.subjectId,
    })
  }
  return { ok: true, result: { taskId: task.id, documentStatus }, events, notifications }
}
