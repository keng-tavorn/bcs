import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { compareBids, criterionScoreBp, formatScore, priceScoreBp, rankBids, scorecardReveal, validateScorecard, weightedScoreBp, type CriterionInput, type EvaluatorStatus } from '@/core/sourcing'
import { loadYaml } from './doa-fixtures'

// tests/golden/rfx-scoring.yaml (spec §7.23 · S10-03): GC-SRC-01 to 14 and 37, the comparison table and scores of an
// RFx (BR-RFX-08 to BR-RFX-10). A supplier not registered for VAT bids at rate 0 (BR-VAT-04); the criterion PRICE is
// the price criterion, every other code a quality one; a bid's supplier is its ref.

interface Suite {
  vatRateBp: number
  cases: Array<{ id: string; title: string; fn: string; input: Record<string, unknown>; expect: unknown }>
}
interface BidIn {
  ref: string
  includesVat: boolean
  vatRegistered: boolean
  lines: Record<string, string>
}
interface RankIn {
  ref: string
  net: string
  submittedAt: string
  scores: Record<string, number[]>
}

const suite = loadYaml<Suite>('rfx-scoring.yaml')
const money = (s: bigint) => satangToAmount(s)
const criteriaOf = (weights: Record<string, number>): CriterionInput[] => Object.entries(weights).map(([code, weightBp]) => ({ code, kind: code === 'PRICE' ? 'PRICE' : 'QUALITY', weightBp }))

function run(fn: string, i: Record<string, unknown>): unknown {
  switch (fn) {
    case 'compareBids': {
      const lines = i.lines as Array<{ ref: string; quantity: string }>
      const bids = (i.bids as BidIn[]).map((b) => ({
        ref: b.ref,
        priceIncludesVat: b.includesVat,
        vatRateBp: b.vatRegistered ? suite.vatRateBp : 0,
        unitPrices: Object.fromEntries(Object.entries(b.lines).map(([k, v]) => [k, amountToSatang(v)])),
      }))
      const r = compareBids(lines, bids)
      return {
        bids: Object.fromEntries(r.bids.map((b) => [b.ref, { net: money(b.net), vat: money(b.vat), gross: money(b.gross), partial: b.partial, lineNet: Object.fromEntries(b.lineNet.map(([k, v]) => [k, money(v)])) }])),
        lowest: r.lowest,
        lowestNet: r.lowestNet === null ? null : money(r.lowestNet),
        lineLowest: Object.fromEntries(r.lineLowest),
      }
    }
    case 'priceScoreBp': {
      const lowest = amountToSatang(i.lowestNet as string)
      return Object.fromEntries(Object.entries(i.nets as Record<string, string>).map(([k, v]) => [k, priceScoreBp(lowest, amountToSatang(v))]))
    }
    case 'criterionScoreBp':
      return criterionScoreBp(i.scores as number[])
    case 'weightedScoreBp':
      return weightedScoreBp(i.criteria as Array<{ weightBp: number; scoreBp: number }>)
    case 'validateScorecard': {
      const r = validateScorecard(criteriaOf(i.weights as Record<string, number>))
      return r.ok ? { ok: true } : { error: r.error.code, ...r.error.details }
    }
    case 'scorecardReveal':
      return scorecardReveal(
        i.minEvaluators as number,
        (i.evaluators as Array<{ member: string; status: EvaluatorStatus }>).map((e) => ({ memberId: e.member, status: e.status })),
      )
    case 'rankBids': {
      const r = rankBids(
        criteriaOf(i.weights as Record<string, number>),
        amountToSatang(i.lowestNet as string),
        (i.bids as RankIn[]).map((b) => ({ ref: b.ref, net: amountToSatang(b.net), submittedAt: new Date(b.submittedAt), supplierId: b.ref, scores: b.scores })),
      )
      return {
        totals: Object.fromEntries(r.totals.map((t) => [t.ref, { priceBp: t.priceBp, ...t.criteria, totalBp: t.totalBp, total: formatScore(t.totalBp) }])),
        ranking: r.ranking,
        topIsLowest: r.topIsLowest,
      }
    }
    default:
      throw new Error(`unknown fn ${fn}`)
  }
}

describe('golden rfx-scoring.yaml', () => {
  it('has the cases of S10-03', () => expect(suite.cases.map((c) => c.id)).toEqual([...Array.from({ length: 14 }, (_, i) => `GC-SRC-${String(i + 1).padStart(2, '0')}`), 'GC-SRC-37']))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => expect(run(c.fn, c.input)).toEqual(c.expect))
  }
})
