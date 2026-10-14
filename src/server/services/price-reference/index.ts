import { err, ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { priceReferenceOf, priceRequestFacts, type PriceReferenceDto } from '@/server/queries/price-reference'

// The price reference of a request (S6-11 · FR-DOA-101 · ADR-108) for a member: who may read it is priceReference.view —
// who has or had a task on the request or on a PO bought from it, and who reads every PO (BR-PRC-07 · OQ-116). The
// numbers come from src/server/queries/price-reference.ts (BR-AI-03: S13 FR-AI-301 and S17 call this same service).

export type { PriceLineReferenceDto, PriceReferenceDto } from '@/server/queries/price-reference'

export async function getPriceReference(ctx: Ctx, input: { requestId: string }): Promise<Result<PriceReferenceDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const facts = await priceRequestFacts(tx, input.requestId)
    if (!facts) return err('NOT_FOUND', 'request not found')
    const allowed = await authorize(tx, ctx, 'priceReference.view', { assigneeMemberIds: facts.assigneeMemberIds })
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    return ok(await priceReferenceOf(tx, ctx.organizationId, facts, ctx.now))
  })
}
