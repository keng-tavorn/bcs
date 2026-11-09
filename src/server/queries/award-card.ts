import { amountToSatang } from '@/core/money/dto'
import { forTenant } from '@/server/db/tenant'

// S10-10 (BR-NOTI-01 · docs/sub-specs/S10.md "การแจ้งเตือน"): what the LINE approval card of an award shows beside its
// number and amount — how many bids were received, how many suppliers win and whether its lines cost more before VAT than
// the lowest offer on each ("ไม่ใช่ราคาต่ำสุด"), read from the snapshot frozen at award.submit. No supplier, line or price.

interface StoredSnapshot {
  readonly lowestBidId?: string | null
  readonly lowestLinesNet?: string
  readonly submitted?: number
  readonly bids?: ReadonlyArray<{ readonly bidId: string; readonly net: string }>
}

export async function awardCardCounts(organizationId: string, awardDecisionId: string): Promise<{ readonly bids: number; readonly winners: number; readonly notLowest: boolean } | null> {
  const award = await forTenant(organizationId).awardDecision.findFirst({ where: { id: awardDecisionId }, select: { netSatang: true, rankingSnapshot: true, lines: { select: { supplierId: true } } } })
  if (!award) return null
  const snapshot = (award.rankingSnapshot ?? {}) as StoredSnapshot
  // the awarded lines against the lowest offer on each of them, so an award of some lines or a split is judged line by line
  const lowest = snapshot.lowestLinesNet ?? snapshot.bids?.find((b) => b.bidId === snapshot.lowestBidId)?.net
  return { bids: snapshot.submitted ?? 0, winners: new Set(award.lines.map((l) => l.supplierId)).size, notLowest: lowest !== undefined ? award.netSatang > amountToSatang(lowest) : false }
}
