import { lineNet, parseQuantity, type Satang } from '@/core/money/math'
import { formatQuantity, receiveIncrement, shortOf, type ExcessDisposition, type IncrementResult } from '@/core/receiving'
import type { TenantTx } from '@/server/db/tenant'

// Where one PO line stands for receiving (spec §6.4, BR-GR-01 to BR-GR-04, BR-BUD-06, NEW-32): what is still on order —
// the ordered quantity less what an approved CLOSE_SHORT gave up — and what is taken already: the goods accepted so far,
// plus damaged goods the receiver asked to keep that wait for the GR_VARIANCE approver (they are on site and count once
// approved). One calculation for gr.post, its preview, the request to close short and its approval, so goods are never
// counted twice: what was received and what was given up together never exceed the ordered quantity, goods beyond what is
// still on order are an excess (returned, or kept with an approval and held), and a close-short gives back only what
// never came. Quantities are ×10⁴; amounts satang before VAT, rounded once (BR-MONEY-02).

export interface LineStanding {
  /** Ordered on the PO line */
  readonly ordered: bigint
  /** Accepted on posted receipts, the excess kept included */
  readonly received: bigint
  /** Given up by an approved close-short */
  readonly cancelled: bigint
  /** Damaged goods kept once approved: ACCEPT_DAMAGED variances still waiting (counted as taken until decided) */
  readonly keepPending: bigint
}

const atLeastZero = (value: bigint): bigint => (value > 0n ? value : 0n)

/** Still on order: what an approved close-short gave up is no longer ordered */
export const onOrder = (line: LineStanding): bigint => atLeastZero(line.ordered - line.cancelled)

/** Still to come: on order, less what was accepted and the damaged goods waiting to be kept */
export const stillToCome = (line: LineStanding): bigint => atLeastZero(onOrder(line) - line.received - line.keepPending)

/**
 * One more receipt on the line (receiveIncrement, BR-GR-02, BR-GR-03) measured against what is still on order, the
 * damaged goods waiting to be kept counted as taken: beyond it lies the excess, of which the tolerance share of the
 * on-order quantity is accepted and held at once. A line with nothing left on order takes every unit as an excess.
 */
export function receiveOnLine(
  line: LineStanding,
  input: { readonly unitPriceSatang: Satang; readonly received: bigint; readonly tolerancePct: number; readonly disposition?: ExcessDisposition | undefined },
): IncrementResult {
  const base = onOrder(line)
  const acceptedBefore = line.received + line.keepPending
  if (base > 0n) {
    return receiveIncrement({ ordered: base, unitPriceSatang: input.unitPriceSatang, acceptedBefore, received: input.received, tolerancePct: input.tolerancePct, ...(input.disposition ? { disposition: input.disposition } : {}) })
  }
  if (input.received <= 0n) return { accepted: 0n, withinTolerance: 0n, holdSatang: 0n, over: null }
  return {
    accepted: 0n,
    withinTolerance: 0n,
    holdSatang: 0n,
    over: { quantity: input.received, amountSatang: lineNet(formatQuantity(input.received), input.unitPriceSatang), needsApproval: input.disposition === 'ACCEPT_EXCESS' },
  }
}

/** BR-GR-04: what closing the line short gives up now — what is still to come, at the PO price */
export function shortNow(line: LineStanding, unitPriceSatang: Satang): { readonly quantity: bigint; readonly amountSatang: Satang } {
  return shortOf(onOrder(line), line.received + line.keepPending, 0n, unitPriceSatang)
}

const scaled = (d: { toString(): string }): bigint => parseQuantity(d.toString())

/** The standing of PO lines as stored (quantity, receivedQuantity, cancelledQuantity) with their pending keeps */
export function standingOf(line: { quantity: { toString(): string }; receivedQuantity: { toString(): string }; cancelledQuantity: { toString(): string } }, keepPending: bigint): LineStanding {
  return { ordered: scaled(line.quantity), received: scaled(line.receivedQuantity), cancelled: scaled(line.cancelledQuantity), keepPending }
}

/** Damaged goods waiting to be kept (ACCEPT_DAMAGED, PENDING_APPROVAL), per PO line, ×10⁴ */
export async function keepPendingByLine(tx: Pick<TenantTx, 'variance'>, poLineIds: readonly string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  if (poLineIds.length === 0) return out
  const waiting = await tx.variance.findMany({ where: { poLineId: { in: [...poLineIds] }, disposition: 'ACCEPT_DAMAGED', status: 'PENDING_APPROVAL' }, select: { poLineId: true, quantity: true } })
  for (const v of waiting) out.set(v.poLineId, (out.get(v.poLineId) ?? 0n) + scaled(v.quantity))
  return out
}
