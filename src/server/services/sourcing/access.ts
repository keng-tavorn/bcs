import type { Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'

// Who reads what of an RFx's bids (BR-RFX-16 · docs/sub-specs/S10.md "สิทธิ์" · S10-08 review ข้อ 1 2): sourcing.view is
// granted to any member at OWN and ASSIGNED scope, so it is always asked with the RFx as its resource — never bare, which
// authorize() answers "could ever be allowed" for every member. PRICES: PROCUREMENT FINANCE EXECUTIVE AUDITOR (ORG) and
// the RFx's evaluators (ASSIGNED) read the bids' amounts, the ranking and the scores once revealed. STATE: a requester of
// a source line (OWN) sees how the RFx stands, never a price before it is awarded. Anyone else: FORBIDDEN.

export type RfxReading = 'PRICES' | 'STATE'

export async function rfxReading(tx: TenantTx, ctx: Ctx, rfxEventId: string): Promise<Result<RfxReading>> {
  const card = await tx.scorecard.findFirst({ where: { rfxEventId }, select: { evaluators: { select: { memberId: true } } } })
  const priced = await authorize(tx, ctx, 'sourcing.view', { assigneeMemberIds: (card?.evaluators ?? []).map((e) => e.memberId) })
  if (priced.ok) return { ok: true, data: 'PRICES' }
  const sources = await tx.rfxLineSource.findMany({ where: { rfxLine: { rfxEventId } }, select: { requestLine: { select: { request: { select: { requesterMemberId: true } } } } } })
  const owners = [...new Set(sources.map((s) => s.requestLine.request.requesterMemberId))]
  const own = await authorize(tx, ctx, 'sourcing.view', { ownerMemberIds: owners })
  return own.ok ? { ok: true, data: 'STATE' } : own
}
