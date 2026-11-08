import { BP_PER_WHOLE, roundHalfUpDiv, type Satang } from '../money/math'
import { err, ok, type Result } from '../result'

// Scorecards and ranking of an RFx (spec §7.23, BR-RFX-09 BR-RFX-10 · ADR-205). Scores are not money: whole basis
// points 0–10000, each rounded half up once at the point the rule names. Weights and the minimum count of evaluators
// come from the RFx (settings.sourcing.defaultWeightsBp, minEvaluators · OQ-206); no number of the rule is in here.

const FULL_BP = Number(BP_PER_WHOLE)
const MAX_SCORE = 100
const POINT_BP = 100n

export type CriterionKind = 'PRICE' | 'QUALITY'

export interface CriterionInput {
  readonly code: string
  readonly kind: CriterionKind
  readonly weightBp: number
}

/** BR-RFX-09: the price score of a bid, the lowest complete amount before VAT over its own (the lowest = 10000) */
export function priceScoreBp(lowestNet: Satang, net: Satang): number {
  if (lowestNet <= 0n || net < lowestNet) throw new RangeError('the lowest amount must be positive and not above the bid')
  return Number(roundHalfUpDiv(lowestNet * BP_PER_WHOLE, net))
}

/** BR-RFX-09: one quality criterion of a bid, the evaluators' whole scores 0–100 averaged into basis points, rounded once */
export function criterionScoreBp(scores: readonly number[]): number {
  if (scores.length === 0) throw new RangeError('no score to average')
  if (scores.some((s) => !Number.isInteger(s) || s < 0 || s > MAX_SCORE)) throw new RangeError('a score is a whole number from 0 to 100')
  const sum = scores.reduce((a, b) => a + BigInt(b), 0n)
  return Number(roundHalfUpDiv(sum * POINT_BP, BigInt(scores.length)))
}

/** BR-RFX-10: Σ weight × criterion score ÷ 10000, rounded once at the end */
export function weightedScoreBp(criteria: ReadonlyArray<{ readonly weightBp: number; readonly scoreBp: number }>): number {
  const sum = criteria.reduce((a, c) => a + BigInt(c.weightBp) * BigInt(c.scoreBp), 0n)
  return Number(roundHalfUpDiv(sum, BP_PER_WHOLE))
}

/** BR-RFX-09: one PRICE criterion, whole weights from 0 to 10000 that add up to 10000 */
export function validateScorecard(criteria: readonly CriterionInput[]): Result<void> {
  if (criteria.filter((c) => c.kind === 'PRICE').length !== 1) return err('VALIDATION_FAILED', 'a scorecard has exactly one price criterion', { reason: 'PRICE_CRITERION' })
  if (criteria.some((c) => !Number.isInteger(c.weightBp) || c.weightBp < 0 || c.weightBp > FULL_BP)) return err('VALIDATION_FAILED', 'a weight is a whole number of basis points from 0 to 10000', { reason: 'WEIGHT_INVALID' })
  const sum = criteria.reduce((a, c) => a + c.weightBp, 0)
  return sum === FULL_BP ? ok(undefined) : err('VALIDATION_FAILED', 'the weights must add up to 10000', { reason: 'WEIGHTS_SUM', sum })
}

export type EvaluatorStatus = 'ASSIGNED' | 'SUBMITTED' | 'RECUSED'

export interface Reveal {
  readonly revealed: boolean
  /** Evaluators not recused who have not submitted, in the order given */
  readonly missing: readonly string[]
  /** Evaluators who submitted */
  readonly counted: number
  /** Everyone has submitted but fewer than the minimum did (PROCUREMENT adds an evaluator) */
  readonly reason?: 'MIN_EVALUATORS'
}

/** BR-RFX-09: scores are revealed once every evaluator not recused has submitted and at least `minEvaluators` did */
export function scorecardReveal(minEvaluators: number, evaluators: ReadonlyArray<{ readonly memberId: string; readonly status: EvaluatorStatus }>): Reveal {
  const missing = evaluators.filter((e) => e.status === 'ASSIGNED').map((e) => e.memberId)
  const counted = evaluators.filter((e) => e.status === 'SUBMITTED').length
  if (missing.length > 0) return { revealed: false, missing, counted }
  if (counted < minEvaluators) return { revealed: false, missing, counted, reason: 'MIN_EVALUATORS' }
  return { revealed: true, missing, counted }
}

export interface RankBidInput {
  readonly ref: string
  /** Amount before VAT of the complete bid */
  readonly net: Satang
  readonly submittedAt: Date
  /** Tie-break of last resort (deterministic) */
  readonly supplierId: string
  /** Quality criterion code → the scores of the evaluators who submitted */
  readonly scores: Readonly<Record<string, readonly number[]>>
}

export interface RankedBid {
  readonly ref: string
  readonly priceBp: number
  /** Quality criterion code → its score in basis points */
  readonly criteria: Readonly<Record<string, number>>
  readonly totalBp: number
}

export interface Ranking {
  /** In the order the bids were given */
  readonly totals: readonly RankedBid[]
  /** Refs, best first: higher total, then lower amount before VAT, then earlier submitted, then supplier id */
  readonly ranking: readonly string[]
  /** The first ranked is (one of) the lowest by amount before VAT; false → the award shows "not the lowest" */
  readonly topIsLowest: boolean
}

/**
 * BR-RFX-09 BR-RFX-10: the weighted total of each complete bid and the ranking. `criteria` must pass
 * validateScorecard; the price criterion is scored by code, the quality ones from the evaluators' scores.
 */
export function rankBids(criteria: readonly CriterionInput[], lowestNet: Satang, bids: readonly RankBidInput[]): Ranking {
  const checked = validateScorecard(criteria)
  if (!checked.ok) throw new RangeError(`invalid scorecard: ${String(checked.error.details?.reason)}`)
  const rows = bids.map((bid) => {
    const priceBp = priceScoreBp(lowestNet, bid.net)
    const scored: Record<string, number> = {}
    const parts = criteria.map((c) => {
      if (c.kind === 'PRICE') return { weightBp: c.weightBp, scoreBp: priceBp }
      const scores = bid.scores[c.code]
      if (!scores) throw new RangeError(`bid ${bid.ref} has no score for ${c.code}`)
      scored[c.code] = criterionScoreBp(scores)
      return { weightBp: c.weightBp, scoreBp: scored[c.code]! }
    })
    return { bid, ranked: { ref: bid.ref, priceBp, criteria: scored, totalBp: weightedScoreBp(parts) } }
  })
  const order = [...rows].sort((a, b) => {
    if (a.ranked.totalBp !== b.ranked.totalBp) return b.ranked.totalBp - a.ranked.totalBp
    if (a.bid.net !== b.bid.net) return a.bid.net < b.bid.net ? -1 : 1
    const at = a.bid.submittedAt.getTime() - b.bid.submittedAt.getTime()
    if (at !== 0) return at
    return a.bid.supplierId < b.bid.supplierId ? -1 : a.bid.supplierId > b.bid.supplierId ? 1 : 0
  })
  return { totals: rows.map((r) => r.ranked), ranking: order.map((r) => r.bid.ref), topIsLowest: order.length > 0 && order[0]!.bid.net === lowestNet }
}

/** A score in basis points as the screens and facts show it: 9538 → "95.38" */
export function formatScore(bp: number): string {
  if (!Number.isInteger(bp) || bp < 0) throw new RangeError(`invalid score: ${bp}`)
  return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`
}
