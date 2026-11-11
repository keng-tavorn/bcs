import type { AppError } from '@/core/result'
import { AWARD_DECISION_MACHINE, transition, type AwardDecisionCommand } from '@/core/state-machines'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { NotificationDraft } from '@/server/notifications/create'
import type { SubjectDecided, SubjectDecision } from '../approvals/subjects'
import { requireModule } from '../modules'
import { applyAward, awardCtx, type AwardRow } from './award-apply'

// The decision of DOA RFX_AWARD (S10-10 · FR-SRC-204 AC3 AC5 · BR-RFX-12 BR-RFX-13 · ADR-202 ADR-206). The shared
// approvals/decide.ts has checked the decider's separation of duties (the adapter's sodContext: the submitter through
// checkSod, then BR-SOD-13's people through awardDecisionSodExtra), the step-up at the version's stepUpThreshold and
// the channel; the route's result comes here under the lock of the RFx and then the award (the order of the award's own
// commands and of bid.disqualify). Approved: applyAward in the same transaction, with a context derived from the
// submitter (BR-RFX-13: the POs are made by procurement, the approver acts on their behalf · S10-11 award-apply.ts); any
// refusal rolls the whole decision back and the task stays open. Rejected: the RFx stays as it is and a new award may be
// made. Returned: the submitter changes and sends it again on a new route (BR-DOA-09). The submitter hears a return or a
// rejection.

export { applyAward, awardCtx, type AwardApplied, type AwardRow } from './award-apply'

const refused = (code: AppError['code'], message: string, details: Record<string, unknown>): SubjectDecided => ({ ok: false, error: { code, message, details } })

/** award.decided: the submitter hears a return or a rejection (IMMEDIATE) */
function decidedNotice(award: AwardRow, rfx: { number: string | null; title: string }, outcome: 'RETURNED' | 'REJECTED'): NotificationDraft {
  return {
    recipientMemberId: award.submittedById!,
    templateKey: 'award.decided',
    data: { awardDecisionId: award.id, rfxEventId: award.rfxEventId, number: award.number, rfxNumber: rfx.number, title: rfx.title, outcome },
    urgency: 'IMMEDIATE',
    dedupeKey: `award.decided:${award.id}:${award.version}`,
    subjectType: 'AWARD_DECISION',
    subjectId: award.id,
  }
}

export async function decideAward(tx: TenantTx, ctx: Ctx, awardDecisionId: string, decision: SubjectDecision): Promise<SubjectDecided> {
  const head = await tx.awardDecision.findFirst({ where: { id: awardDecisionId }, select: { rfxEventId: true } })
  // A route of this subject without its award (the tests of the shared base): refused as the empty adapter was
  if (!head) return refused('VALIDATION_FAILED', 'no award for this task', { reason: 'SUBJECT' })
  const on = await requireModule(ctx, 'SOURCING', tx)
  if (!on.ok) return { ok: false, error: on.error }
  await lockRowsForUpdate(tx, 'RfxEvent', ctx.organizationId, [head.rfxEventId])
  await lockRowsForUpdate(tx, 'AwardDecision', ctx.organizationId, [awardDecisionId])
  const award = (await tx.awardDecision.findFirst({ where: { id: awardDecisionId } }))!
  const rfx = await tx.rfxEvent.findUniqueOrThrow({ where: { id: award.rfxEventId }, select: { number: true, title: true } })
  const command: AwardDecisionCommand = decision.outcome === 'APPROVED' ? 'award.final_approval' : decision.outcome === 'RETURNED' ? 'approval.return' : 'approval.reject'
  const moved = transition(AWARD_DECISION_MACHINE, award.status, command)
  if (!moved.ok) return refused('INVALID_STATE_TRANSITION', `${command} is not allowed from ${award.status}`, { from: award.status, command })
  const number = award.number ?? ''
  if (decision.outcome === 'APPROVED') {
    const approver = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    const applied = await applyAward(tx, awardCtx(ctx, award.submittedById!), award, approver)
    if (!applied.ok) return { ok: false, error: applied.error }
    await tx.awardDecision.update({
      where: { id: award.id },
      data: { status: moved.to, decidedAt: ctx.now, poStatus: applied.poStatus, purchaseOrderIds: [...applied.purchaseOrderIds], priceAgreementIds: [...applied.priceAgreementIds], version: { increment: 1 } },
    })
    return {
      ok: true,
      documentStatus: moved.to,
      events: [
        {
          type: 'award.approved',
          aggregateType: 'AwardDecision',
          aggregateId: award.id,
          data: {
            rfxEventId: award.rfxEventId,
            number,
            onBehalfOf: approver,
            purchaseOrderIds: [...applied.purchaseOrderIds],
            priceAgreementIds: [...applied.priceAgreementIds],
            preferredSupplierIds: [...applied.preferredSupplierIds],
            poStatus: applied.poStatus,
            linesWithoutAgreement: [...applied.linesWithoutAgreement],
          },
        },
        ...applied.events,
      ],
      notifications: [...applied.notifications],
    }
  }
  await tx.awardDecision.update({ where: { id: award.id }, data: { status: moved.to, currentRouteId: null, ...(decision.outcome === 'REJECTED' ? { decidedAt: ctx.now } : {}), version: { increment: 1 } } })
  return {
    ok: true,
    documentStatus: moved.to,
    events: [{ type: decision.outcome === 'REJECTED' ? 'award.rejected' : 'award.returned', aggregateType: 'AwardDecision', aggregateId: award.id, data: { rfxEventId: award.rfxEventId, number, reasonCommentId: decision.reasonCommentId } }],
    notifications: award.submittedById ? [decidedNotice(award, rfx, decision.outcome)] : [],
  }
}
