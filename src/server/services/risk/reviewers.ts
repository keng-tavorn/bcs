import type { Result } from '@/core/result'
import type { RiskTierCode } from '@/core/risk'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { OutboxDraft } from '@/server/events/outbox'
import type { NotificationDraft } from '@/server/notifications/create'

// The reviewers of a sent assessment (BR-RSK-07 · ADR-222): the slots the rules of RISK_ASSESSMENT scope of the workflow
// version in effect name for this assessment, as ReviewTask rows of the round. S11-05 sends with no reviewer rule (the
// assessment completes at once); S11-06 resolves the rules here with resolveReviewStep of S6.

export interface ReviewSlots {
  readonly tasks: number
  readonly workflowVersionId: string | null
  readonly events: EventDraft[]
  readonly notifications: NotificationDraft[]
  readonly outbox: OutboxDraft[]
}

export async function reviewSlotsFor(tx: TenantTx, ctx: Ctx, assessment: { readonly id: string }, tier: RiskTierCode, round: number): Promise<Result<ReviewSlots>> {
  void tx
  void ctx
  void assessment
  void tier
  void round
  return { ok: true, data: { tasks: 0, workflowVersionId: null, events: [], notifications: [], outbox: [] } }
}
