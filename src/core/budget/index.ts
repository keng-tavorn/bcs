import { lineNet, parseQuantity, roundHalfUpDiv, type Satang } from '../money/math'
import { QUANTITY_SCALE } from '../money/constants'

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
  /**
   * Money leaves the line by being spent (ACTUAL), and goes back OUTSIDE only by a transfer out or a decrease
   * (BUDGET_TRANSFER) or what an overrun did not use (BUDGET_OVERRUN) — BR-BUD-09 (S6)
   */
  readonly to: Bucket
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
  | { readonly code: 'VALIDATION_FAILED'; readonly reason: 'AMOUNT_NOT_POSITIVE' | 'RELEASABLE_EXCEEDS_RESERVED' | 'PO_INVOICED' | 'NOTHING_RESERVED' | 'NOT_OVER_BUDGET' }

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
    if (m.to === 'OUTSIDE') funded -= m.amount
    else buckets[BUCKET_FIELD[m.to]] += m.amount
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

// ---------- transfers and adjustments (S6-15 · BR-BUD-09 to BR-BUD-11 · ADR-104) ----------

/**
 * BR-BUD-10 at submit: the source line of a transfer or a decrease reserves the amount for it (AVAILABLE → RESERVED,
 * BUDGET_TRANSFER) — all of it or BUDGET_INSUFFICIENT; an OPEN line only (BR-BUD-08)
 */
export function reserveTransfer(state: LineState, transferId: string, amount: Satang): BudgetResult {
  if (state.status !== 'OPEN') return fail({ code: 'BUDGET_LINE_CLOSED', status: state.status })
  if (amount <= 0n) return fail({ code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' })
  if (amount > state.buckets.available) return insufficient(state.buckets.available, amount)
  return ok(state, [{ from: 'AVAILABLE', to: 'RESERVED', amount, sourceType: 'BUDGET_TRANSFER', sourceId: transferId }])
}

/** A transfer rejected, returned or cancelled gives its reservation back (RESERVED → AVAILABLE); nothing reserved, nothing moves */
export function releaseTransfer(state: LineState, transferId: string): BudgetResult {
  const held = allocationOf(state, 'BUDGET_TRANSFER', transferId).reserved
  return ok(state, held > 0n ? [{ from: 'RESERVED', to: 'AVAILABLE', amount: held, sourceType: 'BUDGET_TRANSFER', sourceId: transferId }] : [])
}

/** BR-BUD-09 at approval, source line: the reservation comes back and leaves the line (AVAILABLE → OUTSIDE): its funded goes down */
export function transferOut(state: LineState, transferId: string): BudgetResult {
  const held = allocationOf(state, 'BUDGET_TRANSFER', transferId).reserved
  if (held <= 0n) return fail({ code: 'VALIDATION_FAILED', reason: 'NOTHING_RESERVED' })
  return ok(state, [
    { from: 'RESERVED', to: 'AVAILABLE', amount: held, sourceType: 'BUDGET_TRANSFER', sourceId: transferId },
    { from: 'AVAILABLE', to: 'OUTSIDE', amount: held, sourceType: 'BUDGET_TRANSFER', sourceId: transferId },
  ])
}

/** BR-BUD-09 at approval, destination line of a transfer or an increase: OUTSIDE → AVAILABLE, its funded goes up; an OPEN line only */
export function transferIn(state: LineState, transferId: string, amount: Satang): BudgetResult {
  if (state.status !== 'OPEN') return fail({ code: 'BUDGET_LINE_CLOSED', status: state.status })
  if (amount <= 0n) return fail({ code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' })
  return ok(state, [{ from: 'OUTSIDE', to: 'AVAILABLE', amount, sourceType: 'BUDGET_TRANSFER', sourceId: transferId }])
}

export type TransferKind = 'TRANSFER' | 'INCREASE' | 'DECREASE'

/**
 * BR-BUD-11: the DOA input of a BUDGET_TRANSFER — the amount moved as net with no VAT, the department of the source
 * line (TRANSFER, DECREASE) or of the destination (INCREASE), and the one who sent it as the conflict
 */
export function transferDoaInput(input: {
  readonly kind: TransferKind
  readonly fromDepartmentId: string | null
  readonly toDepartmentId: string | null
  readonly amountSatang: Satang
  readonly submitterMemberId: string
}): { documentType: 'BUDGET_TRANSFER'; amount: { netSatang: Satang; vatSatang: Satang }; chargedDepartmentId: string; conflictMemberIds: string[] } {
  const department = input.kind === 'INCREASE' ? input.toDepartmentId : input.fromDepartmentId
  if (!department) throw new RangeError(`a ${input.kind} names the line it ${input.kind === 'INCREASE' ? 'adds to' : 'takes from'}`)
  return { documentType: 'BUDGET_TRANSFER', amount: { netSatang: input.amountSatang, vatSatang: 0n }, chargedDepartmentId: department, conflictMemberIds: [input.submitterMemberId] }
}

// ---------- over-budget approval (S6-16 · BR-BUD-12 to BR-BUD-15, BR-BUD-18 · ADR-105 · OQ-104) ----------

/**
 * BR-BUD-12: the DOA input of an OVER_BUDGET approval. `needSatang` (M) is what the request still has to reserve on the
 * line — its amount on the line less what it already reserves there — and X = M − available is the amount approved to
 * fund, as net with no VAT, under the department that owns the line, the requester as the conflict. X ≤ 0: the line
 * has enough, NOT_OVER_BUDGET.
 */
export function overrunDoaInput(input: {
  readonly needSatang: Satang
  readonly availableSatang: Satang
  readonly lineDepartmentId: string
  readonly requesterMemberId: string
}):
  | { readonly ok: true; readonly input: { documentType: 'OVER_BUDGET'; amount: { netSatang: Satang; vatSatang: Satang }; chargedDepartmentId: string; conflictMemberIds: string[] } }
  | { readonly ok: false; readonly error: BudgetError } {
  const shortfall = input.needSatang - input.availableSatang
  if (shortfall <= 0n) return { ok: false, error: { code: 'VALIDATION_FAILED', reason: 'NOT_OVER_BUDGET' } }
  return { ok: true, input: { documentType: 'OVER_BUDGET', amount: { netSatang: shortfall, vatSatang: 0n }, chargedDepartmentId: input.lineDepartmentId, conflictMemberIds: [input.requesterMemberId] } }
}

/** What an overrun earmarks on the line (its BUDGET_OVERRUN allocation) */
export const earmarkOf = (state: LineState, overrunId: string): Satang => allocationOf(state, 'BUDGET_OVERRUN', overrunId).reserved

/**
 * BR-BUD-13 at approval: X enters the line (OUTSIDE → AVAILABLE) and is earmarked for the request at once (AVAILABLE →
 * RESERVED, BUDGET_OVERRUN), so it is never anyone else's available budget; an OPEN line only (BR-BUD-08)
 */
export function earmarkOverrun(state: LineState, overrunId: string, amount: Satang): BudgetResult {
  if (state.status !== 'OPEN') return fail({ code: 'BUDGET_LINE_CLOSED', status: state.status })
  if (amount <= 0n) return fail({ code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' })
  return ok(state, [
    { from: 'OUTSIDE', to: 'AVAILABLE', amount, sourceType: 'BUDGET_OVERRUN', sourceId: overrunId },
    { from: 'AVAILABLE', to: 'RESERVED', amount, sourceType: 'BUDGET_OVERRUN', sourceId: overrunId },
  ])
}

/** An overrun's result also tells what of X the request used and what went back OUTSIDE */
export type OverrunResult = (Extract<BudgetResult, { ok: true }> & { readonly used: Satang; readonly returned: Satang }) | Extract<BudgetResult, { ok: false }>

/**
 * BR-BUD-14 when the request is sent: needed = max(0, M − available) with M the total of its lines. More than the
 * earmark X → BUDGET_INSUFFICIENT and nothing moves. Otherwise the earmark comes back, what the request does not need
 * (X − needed) leaves the line, and the request's lines reserve M — all or nothing, an OPEN line only.
 */
export function consumeOverrun(state: LineState, overrunId: string, lines: readonly { readonly requestLineId: string; readonly amount: Satang }[]): OverrunResult {
  if (state.status !== 'OPEN') return fail({ code: 'BUDGET_LINE_CLOSED', status: state.status }) as OverrunResult
  if (lines.some((l) => l.amount <= 0n)) return fail({ code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' }) as OverrunResult
  const earmark = earmarkOf(state, overrunId)
  if (earmark <= 0n) return fail({ code: 'VALIDATION_FAILED', reason: 'NOTHING_RESERVED' }) as OverrunResult
  const total = sum(lines.map((l) => l.amount))
  const available = state.buckets.available
  const needed = total > available ? total - available : 0n
  if (needed > earmark) return insufficient(available + earmark, total) as OverrunResult
  const returned = earmark - needed
  const movements: Movement[] = [{ from: 'RESERVED', to: 'AVAILABLE', amount: earmark, sourceType: 'BUDGET_OVERRUN', sourceId: overrunId }]
  if (returned > 0n) movements.push({ from: 'AVAILABLE', to: 'OUTSIDE', amount: returned, sourceType: 'BUDGET_OVERRUN', sourceId: overrunId })
  for (const l of lines) movements.push({ from: 'AVAILABLE', to: 'RESERVED', amount: l.amount, sourceType: 'REQUEST_LINE', sourceId: l.requestLineId })
  return { ok: true, state: applyMovements(state, movements), movements, used: needed, returned }
}

/** BR-BUD-15: an approved overrun not used (cancelled, its request cancelled, or past lapsesAt) gives its earmark back and X leaves the line */
export function lapseOverrun(state: LineState, overrunId: string): Extract<OverrunResult, { ok: true }> {
  const earmark = earmarkOf(state, overrunId)
  if (earmark <= 0n) return { ok: true, state, movements: [], used: 0n, returned: 0n }
  const movements: Movement[] = [
    { from: 'RESERVED', to: 'AVAILABLE', amount: earmark, sourceType: 'BUDGET_OVERRUN', sourceId: overrunId },
    { from: 'AVAILABLE', to: 'OUTSIDE', amount: earmark, sourceType: 'BUDGET_OVERRUN', sourceId: overrunId },
  ]
  return { ok: true, state: applyMovements(state, movements), movements, used: 0n, returned: earmark }
}

/**
 * BR-BUD-18: what one command gave back of a request on a line — Σ (RESERVED or COMMITTED → AVAILABLE) − Σ (AVAILABLE →
 * RESERVED or COMMITTED) over the movements of the allocations in `keys` (its request lines and the PO lines ordered
 * from them), never below zero
 */
export function netReturned(movements: readonly Movement[], keys: ReadonlySet<string>): Satang {
  let net = 0n
  for (const m of movements) {
    if (!keys.has(allocationKey(m.sourceType, m.sourceId))) continue
    if (m.to === 'AVAILABLE' && (m.from === 'RESERVED' || m.from === 'COMMITTED')) net += m.amount
    if (m.from === 'AVAILABLE' && (m.to === 'RESERVED' || m.to === 'COMMITTED')) net -= m.amount
  }
  return net > 0n ? net : 0n
}

/**
 * BR-BUD-18 after use: of what a command gave back (`given`, from netReturned), s = min(outstanding, given) leaves the
 * line (AVAILABLE → OUTSIDE, BUDGET_OVERRUN), to the overrun used last first, so the amount funded for the request never
 * becomes another document's available budget. Never more than the line has available.
 */
export function returnAfterUse(
  state: LineState,
  given: Satang,
  overruns: readonly { readonly id: string; readonly outstanding: Satang }[],
): { readonly ok: true; readonly state: LineState; readonly movements: readonly Movement[]; readonly returned: ReadonlyMap<string, Satang> } {
  let left = given < state.buckets.available ? given : state.buckets.available
  const movements: Movement[] = []
  const returned = new Map<string, Satang>()
  for (const o of overruns) {
    const s = o.outstanding < left ? o.outstanding : left
    if (s <= 0n) continue
    movements.push({ from: 'AVAILABLE', to: 'OUTSIDE', amount: s, sourceType: 'BUDGET_OVERRUN', sourceId: o.id })
    returned.set(o.id, s)
    left -= s
  }
  return { ok: true, state: applyMovements(state, movements), movements, returned }
}

// ---------- split cost (S6-17 · BR-BUD-16 · ADR-106 · OQ-106) ----------

/**
 * The "แบ่งบรรทัด" button: one line becomes one line per part, each the part's quantity at the same unit price, its
 * amount rounded once (BR-MONEY-02 (1)). The parts' amounts may add up to more or less than the line's by up to
 * (parts − 1) satang; the screen shows `total` against `original` before the split is saved.
 */
export function splitLine(unitPriceSatang: Satang, parts: readonly string[]): { nets: Satang[]; total: Satang; original: Satang } {
  if (parts.length < 2 || parts.some((p) => parseQuantity(p) <= 0n)) throw new RangeError('a split has two parts or more, each above zero')
  const nets = parts.map((p) => lineNet(p, unitPriceSatang))
  const quantity = parts.reduce((s, p) => s + parseQuantity(p), 0n)
  return { nets, total: sum(nets), original: roundHalfUpDiv(quantity * unitPriceSatang, QUANTITY_SCALE) }
}

/**
 * BR-BUD-16: the department a request split over budget lines charges — the one whose lines add up to the most before
 * VAT; on a tie, the department of the tied line with the lowest lineNo
 */
export function chargedDepartmentOf(lines: readonly { readonly lineNo: number; readonly departmentId: string; readonly netSatang: Satang }[]): string {
  if (lines.length === 0) throw new RangeError('a request has lines')
  const totals = new Map<string, { net: Satang; first: number }>()
  for (const l of lines) {
    const t = totals.get(l.departmentId)
    totals.set(l.departmentId, { net: (t?.net ?? 0n) + l.netSatang, first: Math.min(t?.first ?? l.lineNo, l.lineNo) })
  }
  return [...totals].sort(([, a], [, b]) => (a.net === b.net ? a.first - b.first : a.net > b.net ? -1 : 1))[0]![0]
}
