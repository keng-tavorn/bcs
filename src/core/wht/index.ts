import { allocateLargestRemainder, BP_PER_WHOLE, roundHalfUpDiv, vatFromNet, type Satang } from '../money/math'

// Withholding tax (spec §7.14, BR-WHT-01 to BR-WHT-10, ADR-127). Phase 1 withholds at payment only (OQ-122). The rate
// and the form come from the organization's WhtIncomeType, never from here; the minimum base is a setting
// (settings.wht.minimumBase). Every amount is satang; the tax is rounded half up once per (income type, rate) of a
// payment (BR-MONEY-02 rule 3) and shared back over its documents by largest remainder (rule 4).

export interface Withholding {
  readonly vatSatang: Satang
  readonly whtSatang: Satang
  /** net + VAT − WHT */
  readonly payableSatang: Satang
}

/** One document paid alone (GC-WHT-01, GC-WHT-17): VAT on the amount before VAT, the tax on the same base */
export function withholding(netSatang: Satang, vatRateBp: number, whtRateBp: number): Withholding {
  if (netSatang < 0n) throw new RangeError('the amount before VAT cannot be below zero')
  assertRate(whtRateBp)
  const { vat, gross } = vatFromNet(netSatang, vatRateBp)
  const wht = roundHalfUpDiv(netSatang * BigInt(whtRateBp), BP_PER_WHOLE)
  return { vatSatang: vat, whtSatang: wht, payableSatang: gross - wht }
}

function assertRate(rateBp: number): void {
  if (!Number.isInteger(rateBp) || rateBp < 0) throw new RangeError(`invalid withholding rate: ${rateBp} bp`)
}

export type PayeeType = 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN'
/** The form an income type allows: either return by payee (PND3_53), or one return only */
export type WhtTypeForm = 'PND3_53' | 'PND53' | 'PND3'
export type WhtReturnForm = 'PND3' | 'PND53'

/** BR-WHT-04: the return of a payee for an income type, or the refusal */
export function returnForm(payeeType: PayeeType, typeForm: WhtTypeForm): { readonly ok: true; readonly form: WhtReturnForm } | { readonly ok: false; readonly code: 'WHT_FORM_PAYEE_MISMATCH' | 'VALIDATION_FAILED'; readonly reason: 'FOREIGN_PAYEE' | null } {
  if (payeeType === 'FOREIGN') return { ok: false, code: 'VALIDATION_FAILED', reason: 'FOREIGN_PAYEE' }
  const form: WhtReturnForm = payeeType === 'INDIVIDUAL' ? 'PND3' : 'PND53'
  if (typeForm !== 'PND3_53' && typeForm !== form) return { ok: false, code: 'WHT_FORM_PAYEE_MISMATCH', reason: null }
  return { ok: true, form }
}

export interface WhtForPaymentInput {
  readonly payeeType: PayeeType
  /** null: goods, nothing is withheld (BR-WHT-03) */
  readonly incomeType: string | null
  readonly rateBp: number
  readonly typeForm: WhtTypeForm | null
  /** The PO's amount before VAT (the contract), against the minimum (BR-WHT-06) */
  readonly poNetSatang: Satang
  readonly baseSatang: Satang
  readonly minimumBaseSatang: Satang
}

export type WhtForPayment =
  | { readonly ok: true; readonly form: WhtReturnForm | null; readonly whtSatang: Satang; readonly reason: 'BELOW_MINIMUM' | 'NOT_APPLICABLE' | null }
  | { readonly ok: false; readonly code: 'WHT_FORM_PAYEE_MISMATCH' | 'VALIDATION_FAILED'; readonly reason: 'FOREIGN_PAYEE' | null }

/** The tax of one base of one document paid alone (BR-WHT-04 to BR-WHT-06) */
export function whtForPayment(input: WhtForPaymentInput): WhtForPayment {
  if (input.baseSatang < 0n || input.poNetSatang < 0n || input.minimumBaseSatang < 0n) throw new RangeError('amounts cannot be below zero')
  if (input.incomeType === null || input.typeForm === null) return { ok: true, form: null, whtSatang: 0n, reason: 'NOT_APPLICABLE' }
  assertRate(input.rateBp)
  const form = returnForm(input.payeeType, input.typeForm)
  if (!form.ok) return form
  // the same contract withholds on every payment once it reaches the minimum, however small the payment (BR-WHT-06)
  if (input.poNetSatang < input.minimumBaseSatang) return { ok: true, form: form.form, whtSatang: 0n, reason: 'BELOW_MINIMUM' }
  return { ok: true, form: form.form, whtSatang: roundHalfUpDiv(input.baseSatang * BigInt(input.rateBp), BP_PER_WHOLE), reason: null }
}

export interface WhtLine {
  /** The document (an invoice or a retention), in the order of the payment (by document number) */
  readonly doc: string
  readonly incomeType: string
  readonly rateBp: number
  readonly baseSatang: Satang
}

export interface WhtGroup {
  readonly incomeType: string
  readonly rateBp: number
  readonly baseSatang: Satang
  readonly whtSatang: Satang
  /** The group's tax shared back over its documents: one WithholdingTax row each */
  readonly docs: ReadonlyArray<{ readonly doc: string; readonly whtSatang: Satang }>
}

export type PaymentWithholding =
  | { readonly ok: true; readonly groups: readonly WhtGroup[]; readonly whtSatang: Satang }
  | { readonly ok: false; readonly code: 'VALIDATION_FAILED'; readonly reason: 'WHT_BASE_NEGATIVE' }

/**
 * BR-WHT-10: the tax of one payment. The bases of every document are added per (income type, rate) and the tax is
 * rounded once per group; the group's tax is shared back over its documents by largest remainder of their bases, ties
 * to the document that comes first. Groups keep the order of their first line.
 */
export function paymentWithholding(lines: readonly WhtLine[]): PaymentWithholding {
  const groups = new Map<string, { incomeType: string; rateBp: number; lines: WhtLine[] }>()
  for (const line of lines) {
    assertRate(line.rateBp)
    const key = `${line.incomeType}\u0000${line.rateBp}`
    const group = groups.get(key) ?? { incomeType: line.incomeType, rateBp: line.rateBp, lines: [] }
    group.lines.push(line)
    groups.set(key, group)
  }
  const out: WhtGroup[] = []
  for (const g of groups.values()) {
    const base = g.lines.reduce((a, l) => a + l.baseSatang, 0n)
    if (base < 0n || g.lines.some((l) => l.baseSatang < 0n)) return { ok: false, code: 'VALIDATION_FAILED', reason: 'WHT_BASE_NEGATIVE' }
    const wht = roundHalfUpDiv(base * BigInt(g.rateBp), BP_PER_WHOLE)
    const shares = allocateLargestRemainder(wht, g.lines.map((l) => l.baseSatang))
    out.push({ incomeType: g.incomeType, rateBp: g.rateBp, baseSatang: base, whtSatang: wht, docs: g.lines.map((l, i) => ({ doc: l.doc, whtSatang: shares[i]! })) })
  }
  return { ok: true, groups: out, whtSatang: out.reduce((a, g) => a + g.whtSatang, 0n) }
}

export interface InvoiceWhtLine {
  /** The income type of the line, or null (goods, BR-WHT-03) */
  readonly incomeType: string | null
  readonly rateBp: number
  /** The line's amount before VAT after the foot discount (BR-MATCH-06) */
  readonly netSatang: Satang
}

/**
 * BR-WHT-05: the bases of one invoice, one per (income type, rate): each line's amount before VAT less its share of the
 * retention (largest remainder over the lines' amounts), nothing when the PO is below the minimum (BR-WHT-06).
 */
export function whtBases(input: { readonly doc: string; readonly lines: readonly InvoiceWhtLine[]; readonly retentionSatang: Satang; readonly poNetSatang: Satang; readonly minimumBaseSatang: Satang }): WhtLine[] {
  if (input.poNetSatang < input.minimumBaseSatang) return []
  const retention = allocateLargestRemainder(input.retentionSatang, input.lines.map((l) => l.netSatang))
  const bases = new Map<string, WhtLine>()
  input.lines.forEach((l, i) => {
    if (l.incomeType === null) return
    const key = `${l.incomeType}\u0000${l.rateBp}`
    const before = bases.get(key)
    bases.set(key, { doc: input.doc, incomeType: l.incomeType, rateBp: l.rateBp, baseSatang: (before?.baseSatang ?? 0n) + l.netSatang - retention[i]! })
  })
  return [...bases.values()]
}

/**
 * BR-WHT-05: the bases of a released retention paid: the retention shared over the invoice's lines as whtBases shares
 * it, so each (income type, rate) of the invoice withholds on its own part — nothing when the PO is below the minimum
 */
export function retentionWhtBases(input: { readonly doc: string; readonly lines: readonly InvoiceWhtLine[]; readonly retentionSatang: Satang; readonly poNetSatang: Satang; readonly minimumBaseSatang: Satang }): WhtLine[] {
  if (input.poNetSatang < input.minimumBaseSatang) return []
  const shares = allocateLargestRemainder(input.retentionSatang, input.lines.map((l) => l.netSatang))
  const bases = new Map<string, WhtLine>()
  input.lines.forEach((l, i) => {
    if (l.incomeType === null) return
    const key = `${l.incomeType}\u0000${l.rateBp}`
    bases.set(key, { doc: input.doc, incomeType: l.incomeType, rateBp: l.rateBp, baseSatang: (bases.get(key)?.baseSatang ?? 0n) + shares[i]! })
  })
  return [...bases.values()]
}
