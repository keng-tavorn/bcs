import { MS_PER_DAY } from '../money/constants'
import type { Satang } from '../money/math'
import { addDays, partsOf } from '../thai/day'
import { taxDateOf } from '../vat'
import { paymentWithholding, type WhtLine } from '../wht'

// The payment run, pure (docs/sub-specs/S9.md, spec §7.19 BR-PAY-02 to BR-PAY-07 and BR-PAY-12): what an item pays
// from its invoices and released retentions, the run's totals and order, the pay date it proposes and accepts, the
// documents it proposes, the transfer dates it accepts, the flags of an item and the key of the flags the approver is
// shown. Days are "YYYY-MM-DD"; "today" is the Thai date of the instant the caller passes (no clock here).

export type Weekday = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN'
const WEEKDAYS: readonly Weekday[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
/** How far a pay date is looked for: a calendar with no working day that far is wrong, never an endless search */
const SEARCH_DAYS = 366

/** The organization's working days: its workdays of the week less its holidays (BR-SLA-01) */
export interface PayCalendar {
  readonly workdays: readonly Weekday[]
  readonly holidays: readonly string[]
}

export interface PaymentPolicy {
  readonly runWeekdays: readonly Weekday[]
  readonly holidayShift: 'PREVIOUS' | 'NEXT'
  readonly recentBankChangeDays: number
}

/** Days since 1970-01-01 of a real calendar day; "2026-02-30" or any other text throws instead of becoming 2 March */
function dayNumber(day: string): number {
  const p = partsOf(day)
  if (!p) throw new RangeError(`not a calendar day: ${day}`)
  return Date.UTC(p.year, p.month - 1, p.date) / MS_PER_DAY
}
const dayOf = (n: number) => new Date(n * MS_PER_DAY).toISOString().slice(0, 10)
const weekdayOf = (n: number) => WEEKDAYS[new Date(n * MS_PER_DAY).getUTCDay()]!
const isWorkday = (n: number, calendar: PayCalendar) => calendar.workdays.includes(weekdayOf(n)) && !calendar.holidays.includes(dayOf(n))

// ---------- BR-PAY-04: one item per supplier ----------

export interface ItemDocument {
  readonly kind: 'INVOICE' | 'RETENTION'
  /** Its own reference, in the order of the payment (for the tax shared back per document) */
  readonly doc: string
  /** Of an invoice: its payable as S8 computed it; of a retention: its amount */
  readonly payableSatang: Satang
  /** The tax bases of the document (whtBases or retentionWhtBases of S8) */
  readonly whtLines: ReadonlyArray<{ readonly incomeType: string; readonly rateBp: number; readonly baseSatang: Satang }>
}

export interface ItemWhtLine {
  readonly incomeType: string
  readonly rateBp: number
  readonly baseSatang: Satang
  readonly whtSatang: Satang
}

export type BuiltItem =
  | { readonly ok: true; readonly payableSatang: Satang; readonly whtLines: readonly ItemWhtLine[]; readonly whtSatang: Satang; readonly transferSatang: Satang; readonly docs: ReadonlyArray<{ readonly doc: string; readonly whtSatang: Satang }> }
  | { readonly ok: false; readonly code: 'PAYMENT_ITEM_NOT_POSITIVE'; readonly transferSatang: Satang }
  | { readonly ok: false; readonly code: 'VALIDATION_FAILED'; readonly reason: 'WHT_BASE_NEGATIVE' }

/**
 * What an item pays: the payables of its documents, less the tax of all their bases added per (income type, rate) and
 * rounded once per group (paymentWithholding of S8, BR-WHT-10); what is transferred must be more than nothing
 */
export function buildItem(docs: readonly ItemDocument[]): BuiltItem {
  const payable = docs.reduce((a, d) => a + d.payableSatang, 0n)
  const lines: WhtLine[] = docs.flatMap((d) => d.whtLines.map((l) => ({ doc: d.doc, incomeType: l.incomeType, rateBp: l.rateBp, baseSatang: l.baseSatang })))
  const tax = paymentWithholding(lines)
  if (!tax.ok) return { ok: false, code: tax.code, reason: tax.reason }
  const transfer = payable - tax.whtSatang
  if (transfer <= 0n) return { ok: false, code: 'PAYMENT_ITEM_NOT_POSITIVE', transferSatang: transfer }
  return {
    ok: true,
    payableSatang: payable,
    whtLines: tax.groups.map((g) => ({ incomeType: g.incomeType, rateBp: g.rateBp, baseSatang: g.baseSatang, whtSatang: g.whtSatang })),
    whtSatang: tax.whtSatang,
    transferSatang: transfer,
    docs: tax.groups.flatMap((g) => g.docs),
  }
}

// ---------- BR-PAY-05: the run ----------

export interface RunSupplier {
  readonly code: string
  readonly docs: readonly ItemDocument[]
}

export interface RunItem {
  readonly seq: number
  readonly code: string
  readonly payableSatang: Satang
  readonly whtSatang: Satang
  readonly transferSatang: Satang
}

export type BuiltRun =
  | { readonly ok: true; readonly items: readonly RunItem[]; readonly totals: { readonly payableSatang: Satang; readonly whtSatang: Satang; readonly transferSatang: Satang; readonly itemCount: number; readonly documentCount: number } }
  | ({ readonly supplierCode: string } & Extract<BuiltItem, { ok: false }>)

/** The items numbered by supplier code and the run's totals, the sum of its items; one item per supplier (BR-PAY-05) */
export function buildRun(suppliers: readonly RunSupplier[]): BuiltRun {
  if (new Set(suppliers.map((s) => s.code)).size !== suppliers.length) throw new RangeError('one item per supplier: a supplier code is given twice')
  const items: RunItem[] = []
  for (const [i, s] of [...suppliers].sort((a, b) => (a.code < b.code ? -1 : 1)).entries()) {
    const built = buildItem(s.docs)
    if (!built.ok) return { ...built, supplierCode: s.code }
    items.push({ seq: i + 1, code: s.code, payableSatang: built.payableSatang, whtSatang: built.whtSatang, transferSatang: built.transferSatang })
  }
  const sum = (f: (i: RunItem) => Satang) => items.reduce((a, i) => a + f(i), 0n)
  return {
    ok: true,
    items,
    totals: { payableSatang: sum((i) => i.payableSatang), whtSatang: sum((i) => i.whtSatang), transferSatang: sum((i) => i.transferSatang), itemCount: items.length, documentCount: suppliers.reduce((a, s) => a + s.docs.length, 0) },
  }
}

// ---------- BR-PAY-02: the pay date ----------

/**
 * The pay date proposed from today: the first day from today on one of the run's weekdays; a holiday moves it to the
 * working day before (PREVIOUS) or after (NEXT), and a day moved before today gives way to the next run (OQ-130)
 */
export function nextRunDate(today: string, policy: Pick<PaymentPolicy, 'runWeekdays' | 'holidayShift'>, calendar: PayCalendar): string {
  if (policy.runWeekdays.length === 0) throw new RangeError('a run needs one weekday at least')
  const start = dayNumber(today)
  const step = policy.holidayShift === 'PREVIOUS' ? -1 : 1
  for (let n = start; n < start + SEARCH_DAYS; n++) {
    if (!policy.runWeekdays.includes(weekdayOf(n))) continue
    let candidate = n
    while (!isWorkday(candidate, calendar) && Math.abs(candidate - n) < SEARCH_DAYS) candidate += step
    if (isWorkday(candidate, calendar) && candidate >= start) return dayOf(candidate)
  }
  throw new RangeError('no working day to pay on within a year: check the business calendar')
}

export type PayDateCheck = { readonly ok: true } | { readonly ok: false; readonly code: 'PAYMENT_DATE_INVALID'; readonly reason: 'PAST' | 'NOT_BUSINESS_DAY' }

/** A pay date is today or later in Thai time, and a working day (checked at create, update, submit and approval) */
export function checkPayDate(payDate: string, at: Date, calendar: PayCalendar): PayDateCheck {
  if (payDate < taxDateOf(at)) return { ok: false, code: 'PAYMENT_DATE_INVALID', reason: 'PAST' }
  if (!isWorkday(dayNumber(payDate), calendar)) return { ok: false, code: 'PAYMENT_DATE_INVALID', reason: 'NOT_BUSINESS_DAY' }
  return { ok: true }
}

// ---------- BR-PAY-03: the documents proposed ----------

export interface PayableDocument {
  readonly id: string
  readonly kind: 'INVOICE' | 'RETENTION'
  /** Of an invoice; a released retention is proposed whatever its date */
  readonly dueDate?: string | null
}

/** Invoices due on or before the pay date and every released retention, in the order given */
export function proposeDocuments<T extends PayableDocument>(payDate: string, docs: readonly T[]): T[] {
  return docs.filter((d) => d.kind === 'RETENTION' || (d.dueDate !== undefined && d.dueDate !== null && d.dueDate <= payDate))
}

// ---------- BR-PAY-12: the transfer date of a result ----------

export type PaidOnCheck = { readonly ok: true } | { readonly ok: false; readonly code: 'VALIDATION_FAILED'; readonly reason: 'PAID_ON_BEFORE_PAY_DATE' | 'PAID_ON_FUTURE' }

/** The bank's transfer date is between the pay date and today in Thai time */
export function checkPaidOn(payDate: string, paidOn: string, at: Date): PaidOnCheck {
  if (paidOn < payDate) return { ok: false, code: 'VALIDATION_FAILED', reason: 'PAID_ON_BEFORE_PAY_DATE' }
  if (paidOn > taxDateOf(at)) return { ok: false, code: 'VALIDATION_FAILED', reason: 'PAID_ON_FUTURE' }
  return { ok: true }
}

// ---------- BR-PAY-06 BR-PAY-07: flags ----------

/** In the order of BR-PAY-06: the first four need the preparer's reason before the run is sent */
export const PAYMENT_FLAGS = ['REGISTRY_CHANGED', 'SUPPLIER_INACTIVE', 'RISK_OVERRIDE_EXPIRED', 'PREVIOUSLY_EXPORTED', 'BANK_ACCOUNT_RECENTLY_CHANGED', 'BANK_CHANGE_PENDING', 'SHARED_BANK_ACCOUNT'] as const
export type PaymentFlag = (typeof PAYMENT_FLAGS)[number]
const REASON_FLAGS: readonly PaymentFlag[] = PAYMENT_FLAGS.slice(0, 4)

export interface FlagInput {
  readonly payDate: string
  readonly supplier: { readonly registryFlag: string; readonly status: string; readonly taxId: string | null }
  /** The account the item is paid into: the day it came into force (Thai date) and whether the seed made it */
  readonly account: { readonly activatedOn: string; readonly fromSeed: boolean }
  /** The approvals past a risk of S11 (none in phase 1) */
  readonly riskOverrides?: ReadonlyArray<{ readonly expiresOn: string }>
  /** A document of the item was released from a run whose file was downloaded (releasedAfterExport) */
  readonly previouslyExported?: boolean
  /** A change of the supplier's account waits */
  readonly pendingChange?: boolean
  /** The tax ids of the other suppliers whose ACTIVE account is the same */
  readonly sameAccountTaxIds?: readonly (string | null)[]
}

export function itemFlags(input: FlagInput, policy: Pick<PaymentPolicy, 'recentBankChangeDays'>): { readonly flags: readonly PaymentFlag[]; readonly requiresReason: boolean } {
  const on = new Set<PaymentFlag>()
  if (input.supplier.registryFlag !== 'NONE') on.add('REGISTRY_CHANGED')
  if (input.supplier.status !== 'ACTIVE') on.add('SUPPLIER_INACTIVE')
  if ((input.riskOverrides ?? []).some((o) => o.expiresOn < input.payDate)) on.add('RISK_OVERRIDE_EXPIRED')
  if (input.previouslyExported) on.add('PREVIOUSLY_EXPORTED')
  if (!input.account.fromSeed && input.account.activatedOn >= addDays(input.payDate, -policy.recentBankChangeDays)) on.add('BANK_ACCOUNT_RECENTLY_CHANGED')
  if (input.pendingChange) on.add('BANK_CHANGE_PENDING')
  // the branches of one tax id share an account without a flag; a supplier without a tax id is never known to be the
  // same one, so sharing with or as one is flagged
  if ((input.sameAccountTaxIds ?? []).some((t) => t === null || input.supplier.taxId === null || t !== input.supplier.taxId)) on.add('SHARED_BANK_ACCOUNT')
  const flags = PAYMENT_FLAGS.filter((f) => on.has(f))
  return { flags, requiresReason: flags.some((f) => REASON_FLAGS.includes(f)) }
}

/** "<supplier code>:<flag>+<flag>" of every item with flags, by supplier code, joined with ";" ('' without any) */
export function flagsKey(items: ReadonlyArray<{ readonly code: string; readonly flags: readonly PaymentFlag[] }>): string {
  return [...items]
    .filter((i) => i.flags.length > 0)
    .sort((a, b) => (a.code < b.code ? -1 : 1))
    .map((i) => `${i.code}:${PAYMENT_FLAGS.filter((f) => i.flags.includes(f)).join('+')}`)
    .join(';')
}
