import type { Satang } from '../money/math'

// Budget ledger engine (spec §7.7, ADR-021): the budget of one line sits in buckets, and every movement moves money
// from one bucket to another — fund, reserve, hold, actualize, release. The engine is pure: each operation takes the
// state of one budget line and returns the next state with the movements to append to the ledger, or an error with
// the state untouched. Amounts are satang before VAT (BR-BUD-03). The service keeps the state in BudgetLineBalance
// (the buckets) and BudgetAllocation (what each document line holds), locked FOR UPDATE (INV-BUD-05).

export const BUCKETS = ['OUTSIDE', 'AVAILABLE', 'RESERVED', 'COMMITTED', 'ACTUAL'] as const
export type Bucket = (typeof BUCKETS)[number]
// BUDGET_TRANSFER and BUDGET_OVERRUN (S6): the reservation of a transfer's source line and the earmark of an overrun
export type SourceType = 'REQUEST_LINE' | 'PO_LINE' | 'IMPORT' | 'BUDGET_TRANSFER' | 'BUDGET_OVERRUN'
export type BudgetLineStatus = 'OPEN' | 'FROZEN' | 'CLOSED'

export interface Buckets {
  readonly available: Satang
  readonly reserved: Satang
  readonly committed: Satang
  readonly actual: Satang
}

/** What one document line holds (BudgetAllocation) */
export interface Allocation {
  readonly reserved: Satang
  readonly committed: Satang
  readonly actual: Satang
}

export interface LineState {
  readonly status: BudgetLineStatus
  /** Everything funded into the line (OUTSIDE → AVAILABLE): the four buckets always add up to it (INV-BUD-01) */
  readonly funded: Satang
  readonly buckets: Buckets
  /** By `${sourceType}:${sourceId}` of request lines and PO lines */
  readonly allocations: Readonly<Record<string, Allocation>>
}

export interface Movement {
  readonly from: Bucket
  /** Money only leaves the line by being spent (ACTUAL); nothing goes back OUTSIDE */
  readonly to: Exclude<Bucket, 'OUTSIDE'>
  readonly amount: Satang
  readonly sourceType: SourceType
  readonly sourceId: string
}

export type BudgetError =
  /** BR-BUD-02: what is left and how much is missing */
  | { readonly code: 'BUDGET_INSUFFICIENT'; readonly available: Satang; readonly shortfall: Satang }
  /** BR-BUD-08: a FROZEN or CLOSED line takes no new reservation */
  | { readonly code: 'BUDGET_LINE_CLOSED'; readonly status: BudgetLineStatus }
  /** An invoice above what the PO line still holds (GC-BUD-06) */
  | { readonly code: 'INVOICE_EXCEEDS_COMMITTED'; readonly remaining: Satang }
  /** A request that contradicts the state: an amount not above zero, or releasing more than a request line holds */
  | { readonly code: 'VALIDATION_FAILED'; readonly reason: 'AMOUNT_NOT_POSITIVE' | 'RELEASABLE_EXCEEDS_RESERVED' | 'PO_INVOICED' }

export type BudgetResult = { readonly ok: true; readonly state: LineState; readonly movements: readonly Movement[] } | { readonly ok: false; readonly error: BudgetError }

export const EMPTY_ALLOCATION: Allocation = { reserved: 0n, committed: 0n, actual: 0n }

/** A line with nothing in it yet */
export function emptyLine(status: BudgetLineStatus = 'OPEN'): LineState {
  return { status, funded: 0n, buckets: { available: 0n, reserved: 0n, committed: 0n, actual: 0n }, allocations: {} }
}

export const allocationKey = (sourceType: SourceType, sourceId: string) => `${sourceType}:${sourceId}`

const BUCKET_FIELD: Readonly<Record<Exclude<Bucket, 'OUTSIDE'>, keyof Buckets>> = {
  AVAILABLE: 'available',
  RESERVED: 'reserved',
  COMMITTED: 'committed',
  ACTUAL: 'actual',
}
const ALLOCATION_FIELD: Readonly<Partial<Record<Bucket, keyof Allocation>>> = { RESERVED: 'reserved', COMMITTED: 'committed', ACTUAL: 'actual' }

/** Applies movements to a state; the operations below have already checked every bucket stays at zero or above. */
function applyMovements(state: LineState, movements: readonly Movement[]): LineState {
  const buckets: Record<keyof Buckets, Satang> = { ...state.buckets }
  const allocations: Record<string, Allocation> = { ...state.allocations }
  let funded = state.funded
  for (const m of movements) {
    if (m.from === 'OUTSIDE') funded += m.amount
    else buckets[BUCKET_FIELD[m.from]] -= m.amount
    buckets[BUCKET_FIELD[m.to]] += m.amount
    if (m.sourceType === 'IMPORT') continue
    const key = allocationKey(m.sourceType, m.sourceId)
    const current: Record<keyof Allocation, Satang> = { ...(allocations[key] ?? EMPTY_ALLOCATION) }
    const out = ALLOCATION_FIELD[m.from]
    const into = ALLOCATION_FIELD[m.to]
    if (out) current[out] -= m.amount
    if (into) current[into] += m.amount
    allocations[key] = current
  }
  return { ...state, funded, buckets, allocations }
}

const ok = (state: LineState, movements: Movement[]): BudgetResult => ({ ok: true, state: applyMovements(state, movements), movements })
const fail = (error: BudgetError): BudgetResult => ({ ok: false, error })
const allocationOf = (state: LineState, sourceType: SourceType, sourceId: string) => state.allocations[allocationKey(sourceType, sourceId)] ?? EMPTY_ALLOCATION
const insufficient = (available: Satang, need: Satang): BudgetResult => fail({ code: 'BUDGET_INSUFFICIENT', available, shortfall: need - available })
const sum = (values: readonly Satang[]) => values.reduce((a, b) => a + b, 0n)

/** Import or top-up: OUTSIDE → AVAILABLE (FR-BUD-001 AC2) */
export function fund(state: LineState, amount: Satang, importId: string): BudgetResult {
  if (amount <= 0n) return fail({ code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' })
  return ok(state, [{ from: 'OUTSIDE', to: 'AVAILABLE', amount, sourceType: 'IMPORT', sourceId: importId }])
}

/**
 * Reserves for request lines (AVAILABLE → RESERVED): all of them or none, against the total (BR-BUD-02). A FROZEN or
 * CLOSED line takes no new reservation (BR-BUD-08).
 */
export function reserve(state: LineState, lines: readonly { readonly requestLineId: string; readonly amount: Satang }[]): BudgetResult {
  if (state.status !== 'OPEN') return fail({ code: 'BUDGET_LINE_CLOSED', status: state.status })
  if (lines.some((l) => l.amount <= 0n)) return fail({ code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' })
  const total = sum(lines.map((l) => l.amount))
  if (total > state.buckets.available) return insufficient(state.buckets.available, total)
  return ok(
    state,
    lines.map((l) => ({ from: 'AVAILABLE', to: 'RESERVED', amount: l.amount, sourceType: 'REQUEST_LINE', sourceId: l.requestLineId })),
  )
}

/** Releases what request lines hold reserved (RESERVED → AVAILABLE): a request rejected or cancelled, or resubmitted */
export function release(state: LineState, requestLineIds: readonly string[]): BudgetResult {
  const movements: Movement[] = []
  for (const id of requestLineIds) {
    const held = allocationOf(state, 'REQUEST_LINE', id).reserved
    if (held > 0n) movements.push({ from: 'RESERVED', to: 'AVAILABLE', amount: held, sourceType: 'REQUEST_LINE', sourceId: id })
  }
  return ok(state, movements)
}

/** One PO line and the request lines it orders (PoLineSource), with what each gives back when the PO is approved */
export interface PoLine {
  readonly poLineId: string
  /** The PO line's amount before VAT */
  readonly need: Satang
  readonly sources: readonly { readonly requestLineId: string; readonly releasable: Satang }[]
}

/**
 * BR-BUD-05 at PO submit: delta = need − Σ releasable; a positive delta is reserved for the PO line. Nothing moves
 * when the PO costs no more than what its request lines give back.
 */
export function submitPo(state: LineState, po: PoLine): BudgetResult {
  const delta = po.need - sum(po.sources.map((s) => s.releasable))
  if (delta <= 0n) return ok(state, [])
  if (state.status !== 'OPEN') return fail({ code: 'BUDGET_LINE_CLOSED', status: state.status })
  if (delta > state.buckets.available) return insufficient(state.buckets.available, delta)
  return ok(state, [{ from: 'AVAILABLE', to: 'RESERVED', amount: delta, sourceType: 'PO_LINE', sourceId: po.poLineId }])
}

/**
 * BR-BUD-05 at PO approval: the request lines give back their releasable, the PO line gives back its delta, then the
 * PO line holds its amount (AVAILABLE → COMMITTED). What the request lines did not order stays reserved.
 */
export function approvePo(state: LineState, po: PoLine): BudgetResult {
  if (po.need <= 0n) return fail({ code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' })
  const movements: Movement[] = []
  for (const s of po.sources) {
    if (s.releasable <= 0n) continue
    if (s.releasable > allocationOf(state, 'REQUEST_LINE', s.requestLineId).reserved) return fail({ code: 'VALIDATION_FAILED', reason: 'RELEASABLE_EXCEEDS_RESERVED' })
    movements.push({ from: 'RESERVED', to: 'AVAILABLE', amount: s.releasable, sourceType: 'REQUEST_LINE', sourceId: s.requestLineId })
  }
  const delta = allocationOf(state, 'PO_LINE', po.poLineId).reserved
  if (delta > 0n) movements.push({ from: 'RESERVED', to: 'AVAILABLE', amount: delta, sourceType: 'PO_LINE', sourceId: po.poLineId })
  const available = state.buckets.available + sum(movements.map((m) => m.amount))
  if (po.need > available) return insufficient(available, po.need)
  movements.push({ from: 'AVAILABLE', to: 'COMMITTED', amount: po.need, sourceType: 'PO_LINE', sourceId: po.poLineId })
  return ok(state, movements)
}

/** A PO rejected or returned gives back only the delta it reserved (GC-BUD-03) */
export function rejectPo(state: LineState, poLineId: string): BudgetResult {
  const delta = allocationOf(state, 'PO_LINE', poLineId).reserved
  return ok(state, delta > 0n ? [{ from: 'RESERVED', to: 'AVAILABLE', amount: delta, sourceType: 'PO_LINE', sourceId: poLineId }] : [])
}

/**
 * BR-BUD-06: cancelling a PO gives back what it holds. Only an approved PO gave its request lines' share back, so only
 * then does RETURN_TO_POOL reserve it again for them — all of it or, with BUDGET_INSUFFICIENT, nothing at all;
 * CANCEL_REQUEST_LINES leaves those lines cancelled. A PO with an invoice is closed, never cancelled.
 */
export function cancelPo(state: LineState, po: PoLine, disposition: 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES'): BudgetResult {
  const held = allocationOf(state, 'PO_LINE', po.poLineId)
  if (held.actual > 0n) return fail({ code: 'VALIDATION_FAILED', reason: 'PO_INVOICED' })
  const approved = held.committed > 0n
  const movements: Movement[] = []
  if (held.reserved > 0n) movements.push({ from: 'RESERVED', to: 'AVAILABLE', amount: held.reserved, sourceType: 'PO_LINE', sourceId: po.poLineId })
  if (approved) movements.push({ from: 'COMMITTED', to: 'AVAILABLE', amount: held.committed, sourceType: 'PO_LINE', sourceId: po.poLineId })
  if (disposition === 'RETURN_TO_POOL' && approved) {
    const back = po.sources.filter((s) => s.releasable > 0n)
    if (back.length) {
      if (state.status !== 'OPEN') return fail({ code: 'BUDGET_LINE_CLOSED', status: state.status })
      const available = state.buckets.available + sum(movements.map((m) => m.amount))
      const total = sum(back.map((s) => s.releasable))
      if (total > available) return insufficient(available, total)
      for (const s of back) movements.push({ from: 'AVAILABLE', to: 'RESERVED', amount: s.releasable, sourceType: 'REQUEST_LINE', sourceId: s.requestLineId })
    }
  }
  return ok(state, movements)
}

/**
 * BR-GR-02, BR-GR-04: a PO line holds more for goods kept beyond its quantity — at once within the tolerance, or once
 * an ACCEPT_EXCESS variance is approved (AVAILABLE → COMMITTED at the PO price). It is held for an existing document,
 * so a FROZEN or CLOSED budget line still takes it (BR-BUD-08); not enough left is BUDGET_INSUFFICIENT.
 */
export function holdMore(state: LineState, poLineId: string, amount: Satang): BudgetResult {
  if (amount <= 0n) return fail({ code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' })
  if (amount > state.buckets.available) return insufficient(state.buckets.available, amount)
  return ok(state, [{ from: 'AVAILABLE', to: 'COMMITTED', amount, sourceType: 'PO_LINE', sourceId: poLineId }])
}

/** BR-GR-04: a CLOSE_SHORT variance approved gives back what never comes (COMMITTED → AVAILABLE), at most what the line holds */
export function releaseHold(state: LineState, poLineId: string, amount: Satang): BudgetResult {
  if (amount <= 0n) return fail({ code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' })
  const held = allocationOf(state, 'PO_LINE', poLineId).committed
  const back = amount < held ? amount : held
  return ok(state, back > 0n ? [{ from: 'COMMITTED', to: 'AVAILABLE', amount: back, sourceType: 'PO_LINE', sourceId: poLineId }] : [])
}

/** An invoice confirmed for a PO line (COMMITTED → ACTUAL): never more than the line still holds (GC-BUD-06) */
export function actualize(state: LineState, poLineId: string, amount: Satang): BudgetResult {
  if (amount <= 0n) return fail({ code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' })
  const remaining = allocationOf(state, 'PO_LINE', poLineId).committed
  if (amount > remaining) return fail({ code: 'INVOICE_EXCEEDS_COMMITTED', remaining })
  return ok(state, [{ from: 'COMMITTED', to: 'ACTUAL', amount, sourceType: 'PO_LINE', sourceId: poLineId }])
}

/**
 * Closing a PO line gives back what it still holds (COMMITTED → AVAILABLE), except `keep`: received but not yet
 * invoiced, held until the invoice comes (BR-BUD-06, ADR-038 ข้อ 10).
 */
export function closePo(state: LineState, poLineId: string, keep: Satang = 0n): BudgetResult {
  const held = allocationOf(state, 'PO_LINE', poLineId).committed
  const kept = keep <= 0n ? 0n : keep < held ? keep : held
  const back = held - kept
  return ok(state, back > 0n ? [{ from: 'COMMITTED', to: 'AVAILABLE', amount: back, sourceType: 'PO_LINE', sourceId: poLineId }] : [])
}
