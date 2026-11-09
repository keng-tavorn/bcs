import { amountToSatang } from '@/core/money/dto'
import { forTenant } from '@/server/db/tenant'

// S10-10 (BR-NOTI-01 · docs/sub-specs/S10.md "การแจ้งเตือน"): what the LINE approval card of an award shows beside its
// number and amount — how many bids were received, how many suppliers win and whether it costs more before VAT than the
// lowest complete bid ("ไม่ใช่ราคาต่ำสุด"), read from the snapshot frozen at award.submit. No supplier, line or price.

interface StoredSnapshot {
  readonly lowestBidId?: string | null
  readonly submitted?: number
  readonly bids?: ReadonlyArray<{ readonly bidId: string; readonly net: string }>
}

export async function awardCardCounts(organizationId: string, awardDecisionId: string): Promise<{ readonly bids: number; readonly winners: number; readonly notLowest: boolean } | null> {
  const award = await forTenant(organizationId).awardDecision.findFirst({ where: { id: awardDecisionId }, select: { netSatang: true, rankingSnapshot: true, lines: { select: { supplierId: true } } } })
  if (!award) return null
  const snapshot = (award.rankingSnapshot ?? {}) as StoredSnapshot
  const lowest = snapshot.bids?.find((b) => b.bidId === snapshot.lowestBidId)
  return { bids: snapshot.submitted ?? 0, winners: new Set(award.lines.map((l) => l.supplierId)).size, notLowest: lowest ? award.netSatang > amountToSatang(lowest.net) : false }
}
