import { rankBids, type CriterionKind } from '@/core/sourcing'
import type { TenantTx } from '@/server/db/tenant'

// The ranking of an RFx's bids (S10-08 · BR-RFX-09 BR-RFX-10 · INV-RFX-02): computed again whenever it is read, from the
// stored amounts and the submitted scores — never stored as a number of its own. A complete bid that is SUBMITTED (not
// withdrawn, not disqualified) is ranked; a partial one has no price score and is left out of the total ranking (AC5).
// The quality scores are those of the evaluators who submitted. Events carry the ranking as it was (scorecard.revealed,
// scorecard.recomputed), so a ranking before a disqualification is still read from them (AC6).

export interface RankedRow {
  readonly bidId: string
  readonly supplierId: string
  readonly rank: number
  readonly priceBp: number
  /** Quality criterion code → basis points */
  readonly criteria: Readonly<Record<string, number>>
  readonly totalBp: number
}

export interface RfxRanking {
  readonly rows: readonly RankedRow[]
  readonly topScoreBidId: string | null
  /** The first ranked is (one of) the lowest by amount before VAT */
  readonly topIsLowest: boolean
}

/** The ranking of the RFx's scorecard as of now; an empty ranking when no complete bid was sent */
export async function rankingOf(tx: TenantTx, scorecardId: string): Promise<RfxRanking> {
  const card = await tx.scorecard.findUniqueOrThrow({
    where: { id: scorecardId },
    select: { rfxEventId: true, criteria: { select: { id: true, code: true, kind: true, weightBp: true } }, evaluators: { where: { status: 'SUBMITTED' }, select: { memberId: true } } },
  })
  const bids = await tx.bid.findMany({ where: { rfxEventId: card.rfxEventId, status: 'SUBMITTED', isPartial: false }, select: { id: true, supplierId: true, netSatang: true, submittedAt: true } })
  if (!bids.length) return { rows: [], topScoreBidId: null, topIsLowest: false }
  const counted = card.evaluators.map((e) => e.memberId)
  const quality = card.criteria.filter((c) => c.kind === 'QUALITY')
  const entries = quality.length
    ? await tx.scoreEntry.findMany({ where: { scorecardId, bidId: { in: bids.map((b) => b.id) }, evaluatorMemberId: { in: counted }, submittedAt: { not: null } }, select: { bidId: true, criterionId: true, score: true } })
    : []
  const codeOf = new Map(quality.map((c) => [c.id, c.code]))
  const lowestNet = bids.reduce((m, b) => (b.netSatang < m ? b.netSatang : m), bids[0]!.netSatang)
  const ranking = rankBids(
    card.criteria.map((c) => ({ code: c.code, kind: c.kind as CriterionKind, weightBp: c.weightBp })),
    lowestNet,
    bids.map((b) => {
      const scores: Record<string, number[]> = Object.fromEntries(quality.map((c) => [c.code, []]))
      for (const e of entries) if (e.bidId === b.id) scores[codeOf.get(e.criterionId)!]!.push(e.score)
      return { ref: b.id, net: b.netSatang, submittedAt: b.submittedAt!, supplierId: b.supplierId, scores }
    }),
  )
  const supplierOf = new Map(bids.map((b) => [b.id, b.supplierId]))
  const totalOf = new Map(ranking.totals.map((t) => [t.ref, t]))
  return {
    rows: ranking.ranking.map((ref, i) => {
      const t = totalOf.get(ref)!
      return { bidId: ref, supplierId: supplierOf.get(ref)!, rank: i + 1, priceBp: t.priceBp, criteria: t.criteria, totalBp: t.totalBp }
    }),
    topScoreBidId: ranking.ranking[0] ?? null,
    topIsLowest: ranking.topIsLowest,
  }
}

/** The ranking as an event carries it: bid and total, best first */
export const rankingData = (r: RfxRanking) => r.rows.map((row) => ({ bidId: row.bidId, totalBp: row.totalBp }))
