import { amountToSatang } from '@/core/money/dto'
import { BP_PER_WHOLE, roundHalfUpDiv, type Satang } from '@/core/money/math'
import type { ComparisonFacts } from './comparison'

// The facts of an RFx's bids that code works out from the comparison table alone (S10-16 · BR-AI-32), apart from the
// database so the evaluation set of the Sourcing Agent (S10-19 · scripts/ai-eval-sourcing.ts) gives Claude the text
// the agent gives it for the same bids. ai-assist.ts reads the RFx and its scores and builds RfxBidFacts with these.

export interface RfxBidFacts {
  readonly rfxEventId: string
  readonly number: string | null
  readonly status: string
  readonly table: ComparisonFacts
  /** Basis points of the lowest complete bid (BR-AI-32): the highest complete bid's distance from it */
  readonly spreadBp: number | null
  /** The incumbent nearest the lowest that is not the lowest itself, with its gap in bp of the lowest (BR-AI-32) */
  readonly incumbent: { readonly supplierCode: string; readonly gapBp: number } | null
  /** The scores once the scorecard is revealed, best first: total and each quality criterion as the page shows it */
  readonly scores: readonly { readonly supplierCode: string; readonly rank: number; readonly total: string; readonly criteria: Readonly<Record<string, string>> }[]
}

const bpOver = (value: Satang, lowest: Satang): number => Number(roundHalfUpDiv((value - lowest) * BP_PER_WHOLE, lowest))

/**
 * BR-AI-32's two distances, both in bp of the lowest complete bid (as priceScoreBp): the highest complete bid's (spreadBp)
 * and the incumbent nearest the lowest that is not the lowest itself (gapBp). Scene 9: spread (305,500 − 300,950) × 10000
 * ÷ 300,950 = 151.19 → 151; SP0024 and SP0029 both sold STEEL on a PO within the window, so the incumbent is SP0024,
 * the nearer: (303,738.32 − 300,950) × 10000 ÷ 300,950 = 92.65 → 93 (S10-18).
 */
export function bidSpread(table: ComparisonFacts): Pick<RfxBidFacts, 'spreadBp' | 'incumbent'> {
  const complete = table.bids.filter((b) => !b.partial)
  if (complete.length === 0) return { spreadBp: null, incumbent: null }
  const net = (b: (typeof complete)[number]) => amountToSatang(b.net)
  const lowest = complete.reduce((m, b) => (net(b) < net(m) ? b : m))
  const lowestNet = net(lowest)
  if (lowestNet <= 0n) return { spreadBp: null, incumbent: null }
  const highestNet = complete.reduce((m, b) => (net(b) > m ? net(b) : m), lowestNet)
  const incumbent = complete.filter((b) => b.tags.includes('INCUMBENT') && b !== lowest).sort((a, b) => (net(a) < net(b) ? -1 : net(a) > net(b) ? 1 : 0))[0]
  return { spreadBp: bpOver(highestNet, lowestNet), incumbent: incumbent ? { supplierCode: incumbent.supplierCode, gapBp: bpOver(net(incumbent), lowestNet) } : null }
}
