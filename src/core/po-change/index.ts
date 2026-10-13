import { approvePo, rejectPo, releaseHold, reserve, submitPo, type BudgetResult, type LineState } from '../budget'
import { documentTotals, parseQuantity, type Satang } from '../money/math'
import { formatQuantity } from '../receiving'

// A change to a sent PO (ADR-125, BR-POC-01 to BR-POC-03, OQ-126): what each line may become against what was received
// and invoiced and what is left of its request line, the new totals of the whole PO (the DOA amount of PO_CHANGE), and
// the budget moves of a change composed from the PO functions of ../budget — reserved at submit for an increase,
// held at approval, given back on a decrease or a rejection. Nothing here changes ../budget (S6 owns it in round P1).

export interface ChangeLine {
  /** Ordered on the PO now */
  readonly ordered: string
  readonly received: string
  /** In invoices from PENDING_APPROVAL on (BR-MATCH-08) */
  readonly invoiced: string
  /** What the request line still has that no PO orders */
  readonly requestLeft: string
  readonly unitPriceSatang: Satang
  readonly vatable: boolean
  readonly change?: { readonly newQty?: string; readonly newUnitPriceSatang?: Satang }
}

export type ChangeRefusal =
  | { readonly code: 'PO_CHANGE_BELOW_PROGRESS'; readonly reason: 'RECEIVED' | 'INVOICED' | 'LINE_INVOICED'; readonly line: number }
  | { readonly code: 'PO_CHANGE_EXCEEDS_REQUEST'; readonly left: string; readonly line: number }

export type ChangeTotals =
  | { readonly ok: true; readonly lines: ReadonlyArray<{ readonly quantity: string; readonly unitPriceSatang: Satang }>; readonly netSatang: Satang; readonly vatSatang: Satang; readonly grossSatang: Satang }
  | ({ readonly ok: false } & ChangeRefusal)

/** BR-POC-01, BR-POC-02: every line checked against its progress, then the new totals at the PO's VAT rate */
export function changeTotals(lines: readonly ChangeLine[], vatRateBp: number): ChangeTotals {
  const next: Array<{ quantity: string; unitPriceSatang: Satang; vatable: boolean }> = []
  for (const [i, l] of lines.entries()) {
    const ordered = parseQuantity(l.ordered)
    const qty = l.change?.newQty !== undefined ? parseQuantity(l.change.newQty) : ordered
    // only a quantity that changes is held to the progress: a line left as it is may have been received beyond its
    // quantity within the tolerance (BR-GR-02), and stays so
    if (qty !== ordered && qty < parseQuantity(l.received)) return { ok: false, code: 'PO_CHANGE_BELOW_PROGRESS', reason: 'RECEIVED', line: i + 1 }
    if (qty !== ordered && qty < parseQuantity(l.invoiced)) return { ok: false, code: 'PO_CHANGE_BELOW_PROGRESS', reason: 'INVOICED', line: i + 1 }
    const price = l.change?.newUnitPriceSatang ?? l.unitPriceSatang
    // the price of a line with an invoice stays: the invoice was matched at it
    if (price !== l.unitPriceSatang && parseQuantity(l.invoiced) > 0n) return { ok: false, code: 'PO_CHANGE_BELOW_PROGRESS', reason: 'LINE_INVOICED', line: i + 1 }
    const left = parseQuantity(l.requestLeft)
    if (qty > ordered + left) return { ok: false, code: 'PO_CHANGE_EXCEEDS_REQUEST', left: formatQuantity(left), line: i + 1 }
    next.push({ quantity: formatQuantity(qty), unitPriceSatang: price, vatable: l.vatable })
  }
  const totals = documentTotals(next, vatRateBp, false)
  return { ok: true, lines: next.map(({ quantity, unitPriceSatang }) => ({ quantity, unitPriceSatang })), netSatang: totals.net, vatSatang: totals.vat, grossSatang: totals.gross }
}

/** One line of a change for the budget: the new amount less the old (delta) and what the request gives with an increase */
export interface ChangeBudgetLine {
  readonly poLineId: string
  readonly requestLineId: string
  readonly deltaSatang: Satang
  /** Releasable of the quantity added from the request line (BR-BUD-05) */
  readonly addedReleasableSatang: Satang
}

/** At submit: an increase reserves max(delta − addedReleasable, 0) in the name of the PO line (BUDGET_INSUFFICIENT) */
export function submitChange(state: LineState, line: ChangeBudgetLine): BudgetResult {
  if (line.deltaSatang <= 0n) return submitPo(state, { poLineId: line.poLineId, need: 0n, sources: [] })
  return submitPo(state, { poLineId: line.poLineId, need: line.deltaSatang, sources: [{ requestLineId: line.requestLineId, releasable: line.addedReleasableSatang }] })
}

/**
 * At approval, each clause of BR-POC-03 on its own — the money and the quantity of a line may move opposite ways (a
 * price cut with more units, a price rise with fewer): the change gives back its reservation and the added quantity's
 * releasable, then holds the delta (a negative delta gives back as much of the hold); the quantity removed (`decrease`,
 * whenever the quantity went down) is, RETURN_TO_POOL, reserved for the request line again. An added quantity with a
 * delta that does not hold more is held through approvePo for its releasable, then given back down to the delta.
 */
export function approveChange(state: LineState, line: ChangeBudgetLine, decrease: { readonly disposition: 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES'; readonly removedReleasableSatang: Satang } | null): BudgetResult {
  const steps: Array<(s: LineState) => BudgetResult> = []
  const added = line.addedReleasableSatang
  if (line.deltaSatang > 0n) {
    steps.push((s) => approvePo(s, { poLineId: line.poLineId, need: line.deltaSatang, sources: added > 0n ? [{ requestLineId: line.requestLineId, releasable: added }] : [] }))
  } else if (added > 0n) {
    steps.push((s) => approvePo(s, { poLineId: line.poLineId, need: added, sources: [{ requestLineId: line.requestLineId, releasable: added }] }))
    steps.push((s) => releaseHold(s, line.poLineId, added - line.deltaSatang))
  } else {
    steps.push((s) => rejectPo(s, line.poLineId))
    if (line.deltaSatang < 0n) steps.push((s) => releaseHold(s, line.poLineId, -line.deltaSatang))
  }
  if (decrease?.disposition === 'RETURN_TO_POOL' && decrease.removedReleasableSatang > 0n) steps.push((s) => reserve(s, [{ requestLineId: line.requestLineId, amount: decrease.removedReleasableSatang }]))
  let current: BudgetResult = { ok: true, state, movements: [] }
  for (const step of steps) {
    const next = step(current.state)
    if (!next.ok) return next
    current = { ok: true, state: next.state, movements: [...current.movements, ...next.movements] }
  }
  return current
}

/** Not approved, returned or cancelled: the reservation of the change comes back */
export function rejectChange(state: LineState, poLineId: string): BudgetResult {
  return rejectPo(state, poLineId)
}
