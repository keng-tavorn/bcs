import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'

// What keeps the SOURCING module on (S10-02 · §4.11 rule 4 · OQ-33): an RFx not yet AWARDED, CONCLUDED or CANCELLED,
// and an award still open (DRAFT, RETURNED, PENDING_APPROVAL) or APPROVED but waiting for the winner's prices before VAT
// (PENDING_PRICE · OQ-212). Each is named by its number, or by its id before rfx.open or award.submit gives it one.

const LISTED = 20

export async function openSourcingDocuments(tx: TenantTx, _ctx: Ctx): Promise<string[]> {
  const rfxs = await tx.rfxEvent.findMany({
    where: { status: { in: ['DRAFT', 'OPEN', 'CLOSED', 'EVALUATING'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: LISTED,
    select: { id: true, number: true },
  })
  const awards = await tx.awardDecision.findMany({
    where: { OR: [{ status: { in: ['DRAFT', 'RETURNED', 'PENDING_APPROVAL'] } }, { status: 'APPROVED', poStatus: 'PENDING_PRICE' }] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: LISTED,
    select: { id: true, number: true },
  })
  return [...rfxs, ...awards].map((d) => d.number ?? d.id)
}
