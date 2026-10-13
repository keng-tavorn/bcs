import { MINUTES_PER_DAY, MS_PER_MINUTE } from '../money/constants'
import { amountToSatang, satangToAmount } from '../money/dto'
import { lineNet, parseQuantity, vatFromGross, vatFromNet, type Satang } from '../money/math'
import { isValidThaiTaxId, normalizeTaxId } from '../thai/taxid'
import { rateFor, taxDateOf, type TaxRateSnapshot } from '../vat'

// The checks of what the AI read (BR-AI-14 BR-AI-15, golden ai-verify): every amount again with src/core/money — each
// line, the base after the discount, VAT on the net or inside the gross (BR-VAT-03), the totals as read — and who and
// when: the seller's tax id and branch against the supplier of the context (the one the person chose or the PO's, never
// the one the AI read), the buyer, the date in Thai time, the currency. A check never fails the AI action: it marks the
// fields the person must confirm one by one (BR-AI-13, BR-AI-16).

export type CheckCode =
  | 'CURRENCY'
  | 'DISCOUNT_AMBIGUOUS'
  | 'LINE_AMOUNT'
  | 'NET_TOTAL'
  | 'GROSS_TOTAL'
  | 'VAT_AMOUNT'
  | 'VAT_RATE_MISSING'
  | 'NON_VAT_SELLER'
  | 'TAXID_CHECKSUM'
  | 'SELLER_MATCH'
  | 'SELLER_BRANCH'
  | 'BUYER_MATCH'
  | 'DOC_DATE_FUTURE'
  | 'DOC_DATE_OLD'

export interface ReadLine {
  readonly description?: string | null
  readonly qty?: string | null
  readonly unit?: string | null
  readonly unitPrice?: string | null
  readonly amount?: string | null
}

/** A reading as the checks see it (the Document Agent's schema, src/lib/ai-schemas/document.ts) */
export interface ReadingToCheck {
  readonly docType: string
  readonly docDate?: string | null
  readonly currency?: string | null
  readonly priceIncludesVat?: boolean | null
  readonly seller?: { readonly taxId?: string | null; readonly branch?: string | null } | null
  readonly buyer?: { readonly taxId?: string | null } | null
  readonly lines: readonly ReadLine[]
  readonly discountTotal?: string | null
  readonly net?: string | null
  readonly vat?: string | null
  readonly gross?: string | null
}

export interface RegisteredSupplier {
  readonly taxId: string
  readonly branch: string
  readonly vatRegistered: boolean
}

export interface CheckContext {
  readonly rates: readonly TaxRateSnapshot[]
  readonly orgTaxId: string
  readonly now: Date
  /** The supplier the person chose, or the PO's; null when there is none yet */
  readonly supplier: RegisteredSupplier | null
  /** The suppliers of the organization, for the VAT registration of a seller when there is no supplier of the context */
  readonly registry: readonly RegisteredSupplier[]
}

export interface CheckResult {
  readonly status: 'PASS' | 'WARN' | 'FAIL'
  readonly fail: readonly CheckCode[]
  readonly warn: readonly CheckCode[]
  readonly skip: readonly CheckCode[]
  /** Paths the person must confirm one by one because of a check ("*" = the whole document) */
  readonly flagged: readonly string[]
  readonly computed: { readonly net?: string; readonly vat?: string; readonly gross?: string }
  /** |VAT read − VAT computed| when VAT_AMOUNT ran */
  readonly vatDiff?: string
  /** The lines after negative ones moved to the discount (BR-AI-14) */
  readonly normalized: { readonly lines: readonly ReadLine[]; readonly discountTotal: string | null }
}

/** BR-IVC-01: VAT read and VAT computed may differ by 1.00 baht with a warning */
export const VAT_TOLERANCE_SATANG = 100n
/** A document older than this many days is warned about (366 or more) */
export const DOC_MAX_AGE_DAYS = 365

const DAY_MS = MINUTES_PER_DAY * MS_PER_MINUTE
const has = (v: string | null | undefined): v is string => v !== null && v !== undefined && v.trim() !== ''
const money = (v: string | null | undefined): Satang | null => {
  if (!has(v)) return null
  try {
    return amountToSatang(v.replace(/,/g, ''))
  } catch {
    return null
  }
}
const quantityOk = (v: string | null | undefined) => {
  try {
    return has(v) && parseQuantity(v) >= 0n
  } catch {
    return false
  }
}
const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d) / DAY_MS
}

export function verifyReading(reading: ReadingToCheck, ctx: CheckContext): CheckResult {
  const fail = new Set<CheckCode>()
  const warn = new Set<CheckCode>()
  const skip = new Set<CheckCode>()
  const flagged = new Set<string>()
  const computed: { net?: string; vat?: string; gross?: string } = {}
  let vatDiff: string | undefined
  const failOn = (code: CheckCode, ...paths: string[]) => {
    fail.add(code)
    paths.forEach((p) => flagged.add(p))
  }
  const warnOn = (code: CheckCode, ...paths: string[]) => {
    warn.add(code)
    paths.forEach((p) => flagged.add(p))
  }
  const invoice = reading.docType === 'TAX_INVOICE'

  // A document in another currency is never turned into values of a form (NG-9)
  if (has(reading.currency) && reading.currency.trim().toUpperCase() !== 'THB') {
    failOn('CURRENCY', '*')
    return { status: 'FAIL', fail: [...fail], warn: [], skip: [], flagged: [...flagged], computed, normalized: { lines: reading.lines, discountTotal: reading.discountTotal ?? null } }
  }

  // BR-AI-14: a negative line is a discount; a discount in both places is ambiguous and stops the totals
  const negative = reading.lines.map((l, i) => ({ i, amount: money(l.amount) })).filter((x) => x.amount !== null && x.amount < 0n)
  const discountRead = money(reading.discountTotal)
  const ambiguous = negative.length > 0 && discountRead !== null
  const kept = negative.length && !ambiguous ? reading.lines.filter((_, i) => !negative.some((n) => n.i === i)) : reading.lines
  const discount: Satang = ambiguous ? 0n : (discountRead ?? 0n) + negative.reduce((n, x) => n - x.amount!, 0n)
  const normalized = { lines: kept, discountTotal: ambiguous ? reading.discountTotal! : discount > 0n || discountRead !== null ? satangToAmount(discount) : null }

  const priced = reading.docType !== 'DELIVERY_NOTE' && (has(reading.net) || has(reading.vat) || has(reading.gross))
  if (!priced) {
    for (const code of ['LINE_AMOUNT', 'NET_TOTAL', 'VAT_AMOUNT', 'GROSS_TOTAL'] as const) skip.add(code)
  } else {
    // Each line: quantity × unit price rounded half up must be the amount read, to the satang (BR-MONEY-02)
    let sum: Satang = 0n
    reading.lines.forEach((l, i) => {
      const price = money(l.unitPrice)
      const amount = money(l.amount)
      if (price === null || !quantityOk(l.qty)) {
        if (amount !== null && !negative.some((n) => n.i === i)) sum += amount
        return
      }
      const line = lineNet(l.qty!, price)
      if (amount !== null && line !== amount) failOn('LINE_AMOUNT', `lines.${i}.amount`)
      if (!negative.some((n) => n.i === i) || ambiguous) sum += line
    })
    if (ambiguous) {
      failOn('DISCOUNT_AMBIGUOUS', 'discountTotal', ...negative.map((n) => `lines.${n.i}.amount`), 'net', 'vat', 'gross')
      for (const code of ['NET_TOTAL', 'VAT_AMOUNT', 'GROSS_TOTAL'] as const) skip.add(code)
    } else {
      const base = sum - discount
      const net = money(reading.net)
      const vat = money(reading.vat)
      const gross = money(reading.gross)
      const sellerTaxId = has(reading.seller?.taxId) ? normalizeTaxId(reading.seller.taxId) : null
      const registered = ctx.supplier ?? ctx.registry.find((s) => s.taxId === sellerTaxId && s.branch === (reading.seller?.branch ?? '00000')) ?? null
      const vatRegistered = registered?.vatRegistered ?? true
      const date = has(reading.docDate) && /^\d{4}-\d{2}-\d{2}$/.test(reading.docDate) ? reading.docDate : null
      const rate = date ? rateFor(date, ctx.rates) : null
      let vatComputed: Satang | null = null
      if (!vatRegistered) vatComputed = 0n
      else if (rate?.ok) vatComputed = reading.priceIncludesVat ? vatFromGross(base, rate.rateBp).vat : vatFromNet(base, rate.rateBp).vat
      if (reading.priceIncludesVat) {
        if (gross !== base) failOn('GROSS_TOTAL', 'gross')
        if (net !== null && gross !== null && vat !== null && net !== gross - vat) failOn('NET_TOTAL', 'net')
        computed.gross = satangToAmount(base)
        if (vatComputed !== null) {
          computed.vat = satangToAmount(vatComputed)
          computed.net = satangToAmount(base - vatComputed)
        }
      } else {
        if (net !== base) failOn('NET_TOTAL', 'net')
        if (gross !== null && net !== null && vat !== null && gross !== net + vat) failOn('GROSS_TOTAL', 'gross')
        computed.net = satangToAmount(base)
        if (vatComputed !== null) {
          computed.vat = satangToAmount(vatComputed)
          computed.gross = satangToAmount(base + vatComputed)
        }
      }
      if (!vatRegistered) {
        // BR-VAT-04: a seller not registered for VAT charges none
        skip.add('VAT_AMOUNT')
        if (vat !== null && vat !== 0n) failOn('NON_VAT_SELLER', 'vat')
      } else if (!rate?.ok) {
        failOn('VAT_RATE_MISSING', 'vat', 'gross')
        skip.add('VAT_AMOUNT')
      } else if (vat !== null) {
        // A registered seller with a rate always has vatComputed
        const expected = vatComputed!
        const diff = vat > expected ? vat - expected : expected - vat
        vatDiff = satangToAmount(diff)
        if (diff > VAT_TOLERANCE_SATANG) failOn('VAT_AMOUNT', 'vat')
        else if (diff > 0n) warnOn('VAT_AMOUNT', 'vat')
      }
    }
  }

  // BR-AI-15: the seller against the supplier of the context, the buyer against the organization
  const sellerTaxId = reading.seller?.taxId
  if (has(sellerTaxId) && !isValidThaiTaxId(sellerTaxId)) failOn('TAXID_CHECKSUM', 'seller.taxId')
  if (!ctx.supplier) {
    skip.add('SELLER_MATCH')
    skip.add('SELLER_BRANCH')
  } else {
    if (!has(sellerTaxId) || normalizeTaxId(sellerTaxId) !== ctx.supplier.taxId) failOn('SELLER_MATCH', 'seller.taxId')
    if ((reading.seller?.branch ?? null) !== ctx.supplier.branch) (invoice ? failOn : warnOn)('SELLER_BRANCH', 'seller.branch')
  }
  const buyer = reading.buyer?.taxId
  if (has(buyer) && normalizeTaxId(buyer) !== ctx.orgTaxId) (invoice ? failOn : warnOn)('BUYER_MATCH', 'buyer.taxId')
  if (has(reading.docDate) && /^\d{4}-\d{2}-\d{2}$/.test(reading.docDate)) {
    const age = dayNumber(taxDateOf(ctx.now)) - dayNumber(reading.docDate)
    if (age < 0) failOn('DOC_DATE_FUTURE', 'docDate')
    else if (age > DOC_MAX_AGE_DAYS) warnOn('DOC_DATE_OLD', 'docDate')
  }

  const status = fail.size ? 'FAIL' : warn.size ? 'WARN' : 'PASS'
  return { status, fail: [...fail], warn: [...warn], skip: [...skip], flagged: [...flagged], computed, ...(vatDiff === undefined ? {} : { vatDiff }), normalized }
}
