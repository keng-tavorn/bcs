import { normalizeInvoiceNo } from '../invoice'
import { formatQuantity } from '../receiving'
import { MS_PER_DAY } from '../money/constants'
import { allocateLargestRemainder, BP_PER_WHOLE, lineNet, lineNetsBeforeVat, parseQuantity, vatFromGross, vatFromNet, type Satang } from '../money/math'

// Three-way and two-way matching of a tier-2 invoice (spec §7.14 BR-MATCH-01 to BR-MATCH-13, ADR-122) and the VAT
// check of an invoice (§7.1 BR-VAT-05 to BR-VAT-07). Pure: the service reads the PO lines, what was received and
// invoiced, what each line still holds and what each budget line has available, and the organization's thresholds
// (settings.matching, never numbers in code), and stores the result with the policy it used (InvoiceMatch). Golden:
// tests/golden/matching.yaml and tests/golden/invoice-vat.yaml.

export type LineKind = 'GOODS' | 'SERVICE'

export interface MatchPolicy {
  /** Price tolerance: within when over × 10000 ≤ expected × priceTolBp AND over ≤ priceTolSatang (BR-MATCH-07) */
  readonly priceTolBp: number
  readonly priceTolSatang: Satang
  /** Quantity tolerance on goods (BR-MATCH-08); never used on services */
  readonly qtyTolBp: number
  /** The invoice's VAT rate: the VAT of the variance the DOA route is sized on (BR-AP-06) */
  readonly vatRateBp: number
}

export interface MatchPoLine {
  readonly line: number
  readonly ordered: string
  /** Before VAT */
  readonly unitPriceSatang: Satang
  /** Accepted on POSTED GRs including kept extras; for a service, the work confirmed */
  readonly accepted: string
  /** In other invoices that are PENDING_APPROVAL or later */
  readonly invoiced: string
  /** What the PO line still holds (COMMITTED) */
  readonly heldSatang: Satang
  readonly budgetLine: string
}

export interface MatchInvoiceLine {
  readonly poLine: number
  readonly qty: string
  readonly unitPriceSatang: Satang
  /** default true */
  readonly vatable?: boolean
}

export interface MatchInvoice {
  readonly lines: readonly MatchInvoiceLine[]
  /** A discount at the foot of the invoice, before VAT */
  readonly discountSatang?: Satang
  readonly priceIncludesVat?: boolean
  readonly isFinal?: boolean
}

export interface MatchInput {
  readonly kind: LineKind
  readonly poLines: readonly MatchPoLine[]
  /** AVAILABLE of each budget line */
  readonly available: Readonly<Record<string, Satang>>
  readonly invoice: MatchInvoice
  readonly poClosed?: boolean
}

export type LineFlag = 'PRICE_OVER_WITHIN' | 'PRICE_UNDER'

export interface MatchedLine {
  readonly line: number
  readonly poLine: number
  readonly discountSatang: Satang
  readonly netSatang: Satang
  readonly expectedSatang: Satang
  readonly overSatang: Satang
  readonly flags: readonly LineFlag[]
}

/** The order of the types of one line (BR-MATCH-09) */
export const LINE_EXCEPTION_TYPES = ['PRICE_OVER', 'QTY_NOT_RECEIVED', 'QTY_OVER_ORDERED', 'ACCEPTANCE_PENDING'] as const
export type LineExceptionType = (typeof LINE_EXCEPTION_TYPES)[number]

export type MatchExceptionResult =
  | { readonly type: LineExceptionType; readonly line: number; readonly poLine: number; readonly quantity: string | null; readonly amountSatang: Satang }
  | { readonly type: 'BUDGET_SHORT'; readonly budgetLine: string; readonly amountSatang: Satang }

export interface BudgetMove {
  readonly budgetLine: string
  /** AVAILABLE → COMMITTED */
  readonly holdMoreSatang: Satang
  /** COMMITTED → ACTUAL */
  readonly actualSatang: Satang
  /** COMMITTED → AVAILABLE (the last invoice of a closed PO) */
  readonly releaseSatang: Satang
}

export interface PoLineMove {
  readonly poLine: number
  readonly budgetLine: string
  readonly holdMoreSatang: Satang
  readonly actualSatang: Satang
  readonly releaseSatang: Satang
}

export interface MatchResult {
  readonly result: 'MATCHED' | 'EXCEPTION'
  readonly lines: readonly MatchedLine[]
  readonly netSatang: Satang
  readonly exceptions: readonly MatchExceptionResult[]
  /** MATCHED only: the moves per budget line, in the order the PO lines name them */
  readonly budget: readonly BudgetMove[]
  /** MATCHED only: the same moves per PO line (the ledger is written per PO line) */
  readonly poLineMoves: readonly PoLineMove[]
  /** When every exception is PRICE_OVER: what the variance approval is sized on (BR-AP-06) */
  readonly doaAmount: { readonly netSatang: Satang; readonly vatSatang: Satang; readonly line: number } | null
}

const max0 = (n: bigint) => (n > 0n ? n : 0n)

function poLineOf(input: { readonly poLines: readonly MatchPoLine[] }, line: number): MatchPoLine {
  const found = input.poLines.find((p) => p.line === line)
  if (!found) throw new RangeError(`invoice line names PO line ${line}, which is not on the PO`)
  return found
}

/** BR-MATCH-06: each line's amount before VAT less its share of the foot discount (largest remainder by amount) */
export function invoiceLineNets(invoice: MatchInvoice, vatRateBp: number): { amounts: Satang[]; discounts: Satang[]; nets: Satang[] } {
  const seen = new Set<number>()
  for (const l of invoice.lines) {
    if (seen.has(l.poLine)) throw new RangeError(`PO line ${l.poLine} appears twice on the invoice`)
    seen.add(l.poLine)
  }
  const lines = invoice.lines.map((l) => ({ quantity: l.qty, unitPriceSatang: l.unitPriceSatang, vatable: l.vatable }))
  const amounts = invoice.priceIncludesVat ? lineNetsBeforeVat(lines, vatRateBp, true) : lines.map((l) => lineNet(l.quantity, l.unitPriceSatang))
  const discount = invoice.discountSatang ?? 0n
  const total = amounts.reduce((a, b) => a + b, 0n)
  if (discount < 0n || discount > total) throw new RangeError('the discount must be between zero and the invoice amount')
  const discounts = allocateLargestRemainder(discount, amounts)
  return { amounts, discounts, nets: amounts.map((a, i) => a - discounts[i]!) }
}

function lineExceptions(kind: LineKind, po: MatchPoLine, qty: bigint, policy: MatchPolicy, line: number): MatchExceptionResult[] {
  const out: MatchExceptionResult[] = []
  const accepted = parseQuantity(po.accepted)
  const invoiced = parseQuantity(po.invoiced)
  const exception = (type: LineExceptionType, quantity: bigint) =>
    out.push({ type, line, poLine: po.line, quantity: formatQuantity(quantity), amountSatang: lineNet(formatQuantity(quantity), po.unitPriceSatang) })
  if (kind === 'GOODS') {
    const left = max0(accepted - invoiced)
    if (qty * BP_PER_WHOLE > left * (BP_PER_WHOLE + BigInt(policy.qtyTolBp))) exception('QTY_NOT_RECEIVED', qty - left)
    return out
  }
  const orderLeft = max0(parseQuantity(po.ordered) - invoiced)
  if (qty > orderLeft) exception('QTY_OVER_ORDERED', qty - orderLeft)
  const within = qty < orderLeft ? qty : orderLeft
  const acceptedLeft = max0(accepted - invoiced)
  if (within > acceptedLeft) exception('ACCEPTANCE_PENDING', within - acceptedLeft)
  return out
}

interface BudgetEffect {
  readonly budget: BudgetMove[]
  readonly poLineMoves: PoLineMove[]
  /** Per budget line, what the hold needs beyond what is available, in the order the PO lines name them */
  readonly short: Array<{ budgetLine: string; amountSatang: Satang }>
}

/** BR-MATCH-11: hold more where the invoice takes more than the PO line holds, then move the invoice to ACTUAL */
function budgetEffect(input: { poLines: readonly VariancePoLine[]; available: Readonly<Record<string, Satang>>; poClosed?: boolean; isFinal?: boolean }, netByPoLine: Map<number, Satang>): BudgetEffect {
  const release = input.poClosed === true && input.isFinal === true
  const poLineMoves: PoLineMove[] = input.poLines.map((p) => {
    const net = netByPoLine.get(p.line) ?? 0n
    const holdMore = max0(net - p.heldSatang)
    return { poLine: p.line, budgetLine: p.budgetLine, holdMoreSatang: holdMore, actualSatang: net, releaseSatang: release ? p.heldSatang + holdMore - net : 0n }
  })
  const byLine = new Map<string, { hold: Satang; actual: Satang; release: Satang }>()
  for (const m of poLineMoves) {
    const b = byLine.get(m.budgetLine) ?? { hold: 0n, actual: 0n, release: 0n }
    byLine.set(m.budgetLine, { hold: b.hold + m.holdMoreSatang, actual: b.actual + m.actualSatang, release: b.release + m.releaseSatang })
  }
  const budget = [...byLine].map(([budgetLine, b]) => ({ budgetLine, holdMoreSatang: b.hold, actualSatang: b.actual, releaseSatang: b.release }))
  const short = budget
    .map((b) => ({ budgetLine: b.budgetLine, amountSatang: b.holdMoreSatang - (input.available[b.budgetLine] ?? 0n) }))
    .filter((s) => s.amountSatang > 0n)
  return { budget, poLineMoves, short }
}

/** Matches one invoice against its PO (BR-MATCH-05 to BR-MATCH-11). The channel is never an input (BR-AP-01). */
export function matchInvoice(input: MatchInput, policy: MatchPolicy): MatchResult {
  const { nets, discounts } = invoiceLineNets(input.invoice, policy.vatRateBp)
  const lines: MatchedLine[] = []
  const exceptions: MatchExceptionResult[] = []
  input.invoice.lines.forEach((il, i) => {
    const po = poLineOf(input, il.poLine)
    const line = i + 1
    const qty = parseQuantity(il.qty)
    const net = nets[i]!
    const expected = lineNet(il.qty, po.unitPriceSatang)
    const over = max0(net - expected)
    const flags: LineFlag[] = []
    if (over > 0n) {
      const within = over * BP_PER_WHOLE <= expected * BigInt(policy.priceTolBp) && over <= policy.priceTolSatang
      if (within) flags.push('PRICE_OVER_WITHIN')
      else exceptions.push({ type: 'PRICE_OVER', line, poLine: po.line, quantity: null, amountSatang: over })
    } else if (net < expected) flags.push('PRICE_UNDER')
    exceptions.push(...lineExceptions(input.kind, po, qty, policy, line))
    lines.push({ line, poLine: po.line, discountSatang: discounts[i]!, netSatang: net, expectedSatang: expected, overSatang: over, flags })
  })
  const netSatang = nets.reduce((a, b) => a + b, 0n)
  if (exceptions.length > 0) {
    const allPrice = exceptions.every((e) => e.type === 'PRICE_OVER')
    let doaAmount: MatchResult['doaAmount'] = null
    if (allPrice) {
      const priceOver = exceptions as Array<Extract<MatchExceptionResult, { line: number }>>
      const net = priceOver.reduce((a, e) => a + e.amountSatang, 0n)
      // the line with the largest variance names the owning department; the lower line number on a tie (BR-AP-06)
      const top = priceOver.reduce((a, e) => (e.amountSatang > a.amountSatang ? e : a))
      doaAmount = { netSatang: net, vatSatang: vatFromNet(net, policy.vatRateBp).vat, line: top.line }
    }
    return { result: 'EXCEPTION', lines, netSatang, exceptions, budget: [], poLineMoves: [], doaAmount }
  }
  const effect = budgetEffect({ poLines: input.poLines, available: input.available, poClosed: input.poClosed, isFinal: input.invoice.isFinal }, netsByPoLine(input.invoice, nets))
  if (effect.short.length > 0) {
    return { result: 'EXCEPTION', lines, netSatang, exceptions: effect.short.map((s) => ({ type: 'BUDGET_SHORT', ...s })), budget: [], poLineMoves: [], doaAmount: null }
  }
  return { result: 'MATCHED', lines, netSatang, exceptions: [], budget: effect.budget, poLineMoves: effect.poLineMoves, doaAmount: null }
}

function netsByPoLine(invoice: MatchInvoice, nets: readonly Satang[]): Map<number, Satang> {
  return new Map(invoice.lines.map((l, i) => [l.poLine, nets[i]!]))
}

export interface VariancePoLine {
  readonly line: number
  readonly heldSatang: Satang
  readonly budgetLine: string
}

export type VarianceApproval =
  | { readonly ok: true; readonly budget: readonly BudgetMove[]; readonly poLineMoves: readonly PoLineMove[] }
  | { readonly ok: false; readonly error: 'BUDGET_INSUFFICIENT'; readonly budgetLine: string; readonly shortfallSatang: Satang }

/**
 * The last step approves the variance (BR-MATCH-11): every line holds more for what it takes beyond what it holds —
 * the PRICE_OVER lines and the ones over within the tolerance alike — and the invoice moves to ACTUAL. A budget line
 * without enough available refuses the decision (BUDGET_INSUFFICIENT); the first such line in PO-line order is named.
 */
export function approveVariance(input: {
  readonly poLines: readonly VariancePoLine[]
  readonly available: Readonly<Record<string, Satang>>
  readonly invoice: MatchInvoice
  readonly poClosed?: boolean
  readonly vatRateBp?: number
}): VarianceApproval {
  for (const l of input.invoice.lines) if (!input.poLines.some((p) => p.line === l.poLine)) throw new RangeError(`invoice line names PO line ${l.poLine}, which is not on the PO`)
  const { nets } = invoiceLineNets(input.invoice, input.vatRateBp ?? 0)
  const effect = budgetEffect({ poLines: input.poLines, available: input.available, poClosed: input.poClosed, isFinal: input.invoice.isFinal }, netsByPoLine(input.invoice, nets))
  const short = effect.short[0]
  if (short) return { ok: false, error: 'BUDGET_INSUFFICIENT', budgetLine: short.budgetLine, shortfallSatang: short.amountSatang }
  return { ok: true, budget: effect.budget, poLineMoves: effect.poLineMoves }
}

// ---------- duplicates (BR-MATCH-12, BR-IVC-03) ----------

export interface DuplicateCandidate {
  readonly supplier: string
  readonly taxId: string | null
  readonly invoiceNo: string
  /** "YYYY-MM-DD" */
  readonly invoiceDate: string
  readonly grossSatang: Satang
}

export interface DuplicateExisting extends DuplicateCandidate {
  /** INVOICE = tier 2 (Invoice) · CONFIRMATION = tier 1 (InvoiceConfirmation, always in effect) */
  readonly table: 'INVOICE' | 'CONFIRMATION'
  readonly status: string
}

export interface DuplicateFindings {
  /** The same supplier and number (after normalizing) as an invoice in effect: the invoice cannot be submitted */
  readonly hard: 'DUPLICATE_INVOICE' | null
  /** The same tax id (any branch), the same total to the satang and dates at most 3 days apart, another number */
  readonly soft: ReadonlyArray<{ readonly invoiceNo: string; readonly days: number }>
}

const NOT_IN_EFFECT = new Set(['DRAFT', 'CANCELLED', 'REJECTED'])
const POSSIBLE_DUPLICATE_DAYS = 3


function dayNumber(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new RangeError(`invalid date: ${date}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY
}

/** BR-MATCH-12. A draft, a rejected or a cancelled invoice is not in effect (INV-AP-06); a tier-1 confirmation always is. */
export function findDuplicates(candidate: DuplicateCandidate, existing: readonly DuplicateExisting[]): DuplicateFindings {
  const no = normalizeInvoiceNo(candidate.invoiceNo)
  const inEffect = existing.filter((e) => e.table === 'CONFIRMATION' || !NOT_IN_EFFECT.has(e.status))
  const hard = inEffect.some((e) => e.supplier === candidate.supplier && normalizeInvoiceNo(e.invoiceNo) === no) ? 'DUPLICATE_INVOICE' : null
  const soft = candidate.taxId === null ? [] : inEffect
    .filter((e) => e.taxId === candidate.taxId && e.grossSatang === candidate.grossSatang && normalizeInvoiceNo(e.invoiceNo) !== no)
    .map((e) => ({ invoiceNo: e.invoiceNo, days: Math.abs(dayNumber(candidate.invoiceDate) - dayNumber(e.invoiceDate)) }))
    .filter((e) => e.days <= POSSIBLE_DUPLICATE_DAYS)
  return { hard, soft }
}

// ---------- VAT of an invoice (BR-VAT-05 to BR-VAT-07) ----------

/** REGISTRY_* = Supplier.isVatRegistered is still true but Supplier.registryFlag says otherwise (BR-SUP-04) */
export type SupplierVatStatus = 'REGISTERED' | 'NOT_REGISTERED' | 'REGISTRY_VAT_CANCELLED' | 'REGISTRY_CEASED'

export interface InvoiceVatInput {
  /** The rate in effect on the invoice date in Thai time (BR-VAT-01) */
  readonly rateBp: number
  readonly supplierVat: SupplierVatStatus
  readonly lines: ReadonlyArray<{ readonly qty: string; readonly unitPriceSatang: Satang; readonly vatable?: boolean }>
  readonly priceIncludesVat?: boolean
  readonly discountSatang?: Satang
  readonly statedVatSatang: Satang
  /** settings.matching.vatTolAmount */
  readonly vatTolSatang: Satang
}

export interface InvoiceVatResult {
  /** The rate used: 0 for a supplier not registered for VAT (BR-VAT-04) */
  readonly rateBp: number
  readonly netSatang: Satang
  readonly computedVatSatang: Satang
  readonly computedGrossSatang: Satang
  /** Amount before VAT + the VAT the invoice states: what is paid when the check passes (BR-VAT-07) */
  readonly invoiceGrossSatang: Satang
  /** stated − computed */
  readonly diffSatang: Satang
  readonly status: 'OK' | 'VAT_MISMATCH' | 'VAT_SUPPLIER_NOT_REGISTERED'
}

/** BR-VAT-05 to BR-VAT-07: document VAT on the VAT-able lines after the foot discount, compared with the stated VAT */
export function checkInvoiceVat(input: InvoiceVatInput): InvoiceVatResult {
  const zeroRated = input.supplierVat === 'NOT_REGISTERED' || input.supplierVat === 'REGISTRY_VAT_CANCELLED'
  const rateBp = zeroRated ? 0 : input.rateBp
  const amounts = input.lines.map((l) => lineNet(l.qty, l.unitPriceSatang))
  const total = amounts.reduce((a, b) => a + b, 0n)
  const discount = input.discountSatang ?? 0n
  if (discount < 0n || discount > total) throw new RangeError('the discount must be between zero and the invoice amount')
  const discounts = allocateLargestRemainder(discount, amounts)
  const after = amounts.map((a, i) => a - discounts[i]!)
  const vatable = after.reduce((s, a, i) => (input.lines[i]!.vatable !== false ? s + a : s), 0n)
  const all = after.reduce((a, b) => a + b, 0n)
  let netSatang: Satang
  let computedVatSatang: Satang
  if (input.priceIncludesVat) {
    computedVatSatang = vatFromGross(vatable, rateBp).vat
    netSatang = all - computedVatSatang
  } else {
    computedVatSatang = vatFromNet(vatable, rateBp).vat
    netSatang = all
  }
  const diffSatang = input.statedVatSatang - computedVatSatang
  const abs = diffSatang < 0n ? -diffSatang : diffSatang
  const notRegistered = input.supplierVat !== 'REGISTERED'
  const status = notRegistered && input.statedVatSatang > 0n ? 'VAT_SUPPLIER_NOT_REGISTERED' : abs > input.vatTolSatang ? 'VAT_MISMATCH' : 'OK'
  return {
    rateBp,
    netSatang,
    computedVatSatang,
    computedGrossSatang: netSatang + computedVatSatang,
    invoiceGrossSatang: netSatang + input.statedVatSatang,
    diffSatang,
    status,
  }
}
