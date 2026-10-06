import { QUANTITY_SCALE } from '../money/constants'
import { lineNet, parseQuantity, type Satang } from '../money/math'

// Receiving against one PO line (spec §7.11, BR-GR-01 to BR-GR-04): what is accepted, which variance the receipt makes,
// the PO status it leads to, and how the PO's hold on the budget changes once the variances that need approval are
// approved (BR-GR-04). Quantities are decimal text with up to four decimals; amounts are quantity × PO unit price,
// rounded once (BR-MONEY-02 (1)).

export type ExcessDisposition = 'RETURN_EXCESS' | 'ACCEPT_EXCESS'
export type VarianceType = 'OVER' | 'SHORT'

export interface ReceiptInput {
  /** Ordered on the PO line */
  readonly ordered: string
  readonly unitPriceSatang: Satang
  /** Received in all so far */
  readonly received: string
  /** settings.receiving.overTolerancePct (OQ-20 default 0): an excess up to this share of the ordered quantity is accepted at once */
  readonly tolerancePct: number
  /** For an excess beyond the tolerance: send it back, or keep it with an approval (BR-GR-03) */
  readonly disposition?: ExcessDisposition
  /** Close the line although less than ordered came (CLOSE_SHORT, needs approval) */
  readonly closeShort?: boolean
}

export interface VarianceResult {
  readonly type: VarianceType
  readonly quantity: string
  readonly amountSatang: Satang
  /** BR-GR-03: ACCEPT_EXCESS and CLOSE_SHORT go to the GR_VARIANCE approver; RETURN_EXCESS does not */
  readonly needsApproval: boolean
}

export interface ReceiptResult {
  readonly poStatus: 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED'
  readonly accepted: string
  readonly variances: readonly VarianceResult[]
  /** BR-GR-02, BR-GR-04: more held (+) for an accepted excess, less held (−) for what never comes */
  readonly commitDeltaSatang: Satang
}

/** 60000 → "6", 25000 → "2.5": quantity ×10⁴ back to decimal text without trailing zeros */
export function formatQuantity(scaled: bigint): string {
  const whole = scaled / QUANTITY_SCALE
  const fraction = (scaled % QUANTITY_SCALE).toString().padStart(4, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

const amountOf = (scaledQuantity: bigint, unitPriceSatang: Satang) => lineNet(formatQuantity(scaledQuantity), unitPriceSatang)

export function receive(input: ReceiptInput): ReceiptResult {
  if (!Number.isInteger(input.tolerancePct) || input.tolerancePct < 0) throw new RangeError(`invalid tolerance: ${input.tolerancePct}`)
  const ordered = parseQuantity(input.ordered)
  const received = parseQuantity(input.received)

  if (received < ordered) {
    if (!input.closeShort) return { poStatus: 'PARTIALLY_RECEIVED', accepted: formatQuantity(received), variances: [], commitDeltaSatang: 0n }
    // CLOSE_SHORT: what never came is given back once the variance is approved (BR-GR-04)
    const short = ordered - received
    const amount = amountOf(short, input.unitPriceSatang)
    return { poStatus: 'CLOSED', accepted: formatQuantity(received), variances: [{ type: 'SHORT', quantity: formatQuantity(short), amountSatang: amount, needsApproval: true }], commitDeltaSatang: -amount }
  }
  if (received === ordered) return { poStatus: 'RECEIVED', accepted: formatQuantity(received), variances: [], commitDeltaSatang: 0n }

  // An excess: the part within the tolerance is accepted at once and held at the PO price (BR-GR-02); what lies beyond
  // it is a variance, returned or — once approved — kept and held too (BR-GR-03, BR-GR-04)
  const excess = received - ordered
  const tolerated = (ordered * BigInt(input.tolerancePct)) / 100n
  const within = excess < tolerated ? excess : tolerated
  const beyond = excess - within
  const heldWithin = amountOf(within, input.unitPriceSatang)
  if (beyond === 0n) return { poStatus: 'RECEIVED', accepted: formatQuantity(received), variances: [], commitDeltaSatang: heldWithin }
  const beyondAmount = amountOf(beyond, input.unitPriceSatang)
  if (input.disposition === 'ACCEPT_EXCESS') {
    return {
      poStatus: 'RECEIVED',
      accepted: formatQuantity(received),
      variances: [{ type: 'OVER', quantity: formatQuantity(beyond), amountSatang: beyondAmount, needsApproval: true }],
      commitDeltaSatang: heldWithin + beyondAmount,
    }
  }
  // RETURN_EXCESS (and no disposition yet): the excess beyond the tolerance goes back
  return {
    poStatus: 'RECEIVED',
    accepted: formatQuantity(ordered + within),
    variances: [{ type: 'OVER', quantity: formatQuantity(beyond), amountSatang: beyondAmount, needsApproval: false }],
    commitDeltaSatang: heldWithin,
  }
}

export interface IncrementInput {
  /** Ordered on the PO line, ×10⁴ */
  readonly ordered: bigint
  readonly unitPriceSatang: Satang
  /** Accepted on earlier GRs (with the excess already kept), ×10⁴ */
  readonly acceptedBefore: bigint
  /** What this GR takes after its rejected part, ×10⁴ */
  readonly received: bigint
  readonly tolerancePct: number
  /** For an excess beyond the tolerance (BR-GR-03) */
  readonly disposition?: ExcessDisposition
}

export interface IncrementResult {
  /** Accepted by this GR now: the excess waiting for approval or going back is not in it, ×10⁴ */
  readonly accepted: bigint
  /** Of that, kept beyond the ordered quantity within the tolerance, ×10⁴ (BR-GR-02) */
  readonly withinTolerance: bigint
  /** Held more at once for it, at the PO price (BR-GR-02) */
  readonly holdSatang: Satang
  /** The excess beyond the tolerance, if any: returned (RETURN_EXCESS) or kept once approved (ACCEPT_EXCESS) */
  readonly over: { readonly quantity: bigint; readonly amountSatang: Satang; readonly needsApproval: boolean } | null
}

/**
 * One more GR on a PO line (BR-GR-01 to BR-GR-03): what lies beyond the ordered quantity is first accepted within
 * the tolerance left (`ordered × tolerancePct`, for all GRs of the line together) and held at once; the rest is an OVER
 * variance that goes back or waits for approval. The same result as `receive` for a single GR (GC-GR-02, 03, 05).
 */
export function receiveIncrement(input: IncrementInput): IncrementResult {
  if (!Number.isInteger(input.tolerancePct) || input.tolerancePct < 0) throw new RangeError(`invalid tolerance: ${input.tolerancePct}`)
  if (input.received < 0n || input.acceptedBefore < 0n || input.ordered <= 0n) throw new RangeError('quantities of zero or more and an ordered quantity above zero are needed')
  const extraBefore = input.acceptedBefore > input.ordered ? input.acceptedBefore - input.ordered : 0n
  const after = input.acceptedBefore + input.received
  const extraAfter = after > input.ordered ? after - input.ordered : 0n
  const newExtra = extraAfter - extraBefore
  const tolerated = (input.ordered * BigInt(input.tolerancePct)) / 100n
  const toleranceLeft = tolerated > extraBefore ? tolerated - extraBefore : 0n
  const within = newExtra < toleranceLeft ? newExtra : toleranceLeft
  const beyond = newExtra - within
  const holdSatang = within > 0n ? amountOf(within, input.unitPriceSatang) : 0n
  if (beyond === 0n) return { accepted: input.received, withinTolerance: within, holdSatang, over: null }
  return {
    accepted: input.received - beyond,
    withinTolerance: within,
    holdSatang,
    over: { quantity: beyond, amountSatang: amountOf(beyond, input.unitPriceSatang), needsApproval: input.disposition === 'ACCEPT_EXCESS' },
  }
}

/** BR-GR-04: what a CLOSE_SHORT gives back for a line — what never came, at the PO price */
export function shortOf(ordered: bigint, accepted: bigint, cancelled: bigint, unitPriceSatang: Satang): { readonly quantity: bigint; readonly amountSatang: Satang } {
  const short = ordered - cancelled - accepted
  return short > 0n ? { quantity: short, amountSatang: amountOf(short, unitPriceSatang) } : { quantity: 0n, amountSatang: 0n }
}
