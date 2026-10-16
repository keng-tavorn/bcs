/**
 * Independent oracle of the payment-run rules (S9 · ADR-072 decision 4).
 *
 * Written only from spec.md §7.19 (BR-PAY-02 to BR-PAY-07, BR-PAY-12),
 * BR-WHT-10, BR-MONEY-02, docs/sub-specs/S9.md and the golden suite
 * tests/golden/payment-run.yaml, without reading the engine in src/core.
 * A property test feeds random input to both and compares every field, so
 * this file must stay self-contained: no imports, no dependencies.
 *
 * Conventions
 * - Money is bigint satang (1 baht = 100 satang); never number.
 * - Days are canonical "YYYY-MM-DD" strings (proleptic Gregorian calendar).
 * - "Today" is the calendar date in Thai time (Asia/Bangkok, UTC+7, no DST)
 *   of the instant `at`.
 * - Input that no rule gives an error code to (an impossible date, a rate
 *   that is not a whole number of basis points, an unknown flag) throws a
 *   RangeError instead of returning a result.
 */

// ---------------------------------------------------------------------------
// Public types (shapes fixed by the differential test)
// ---------------------------------------------------------------------------

export type OracleWeekday = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN'

export interface OracleCalendar {
  workdays: readonly OracleWeekday[]
  holidays: readonly string[]
}

export interface OracleDoc {
  kind: 'INVOICE' | 'RETENTION'
  payable: bigint
  whtLines: ReadonlyArray<{ incomeType: string; rateBp: number; base: bigint }>
}

export type OracleItem =
  | {
      ok: true
      payable: bigint
      whtLines: Array<{ incomeType: string; rateBp: number; base: bigint; wht: bigint }>
      wht: bigint
      transfer: bigint
    }
  | { ok: false; code: 'PAYMENT_ITEM_NOT_POSITIVE'; transfer: bigint }
  | { ok: false; code: 'VALIDATION_FAILED'; reason: 'WHT_BASE_NEGATIVE' }

export type OracleRun =
  | {
      ok: true
      items: Array<{ seq: number; code: string; payable: bigint; wht: bigint; transfer: bigint }>
      totals: { payable: bigint; wht: bigint; transfer: bigint; itemCount: number; documentCount: number }
    }
  | ({ ok: false; supplierCode: string } & Exclude<OracleItem, { ok: true }>)

// ---------------------------------------------------------------------------
// Calendar days without Date objects
// ---------------------------------------------------------------------------
// A day is held as an integer count of days since 1970-01-01. The civil-date
// conversion below is the classic era/day-of-era algorithm, so no time zone or
// Date parsing quirk (two-digit years, local time) can leak in.

const WEEKDAYS: readonly OracleWeekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const DAY_MS = 86_400_000
const THAI_UTC_OFFSET_MS = 7 * 3_600_000

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yearOfEra = y - era * 400
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146_097 + dayOfEra - 719_468
}

function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468
  const era = Math.floor(z / 146_097)
  const dayOfEra = z - era * 146_097
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  )
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
  const mp = Math.floor((5 * dayOfYear + 2) / 153)
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day }
}

/**
 * Parses a canonical "YYYY-MM-DD" day.
 * SPEC SILENT: an impossible or non-canonical date (2026-02-30, 2026-2-3,
 * a timestamp) has no error code in BR-PAY-02/03/06/12; it is a programming
 * error of the caller, so it throws instead of being rolled over like Date.
 */
function parseDay(value: string, what: string): number {
  if (typeof value !== 'string') throw new RangeError(`${what}: expected a YYYY-MM-DD string`)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new RangeError(`${what}: not a YYYY-MM-DD date: ${value}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`${what}: impossible date: ${value}`)
  }
  return daysFromCivil(year, month, day)
}

function formatDay(days: number): string {
  const { year, month, day } = civilFromDays(days)
  if (year < 0 || year > 9999) throw new RangeError(`date out of range: day ${days}`)
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function weekdayOf(days: number): OracleWeekday {
  // 1970-01-01 (day 0) was a Thursday, index 3 when Monday is 0.
  return WEEKDAYS[(((days + 3) % 7) + 7) % 7] as OracleWeekday
}

/** Today's date in Thai time (UTC+7, no daylight saving) of the instant `at`. */
function thaiToday(at: Date): number {
  const ms = at instanceof Date ? at.getTime() : Number.NaN
  if (!Number.isFinite(ms)) throw new RangeError('at: not a valid instant')
  return Math.floor((ms + THAI_UTC_OFFSET_MS) / DAY_MS)
}

function weekdaySet(list: readonly OracleWeekday[], what: string): Set<OracleWeekday> {
  const set = new Set<OracleWeekday>()
  for (const weekday of list) {
    if (!WEEKDAYS.includes(weekday)) throw new RangeError(`${what}: unknown weekday ${String(weekday)}`)
    set.add(weekday)
  }
  return set
}

/**
 * Business day of the organisation (BR-SLA-01): a working weekday of the
 * calendar that is not in the Holiday table.
 * SPEC SILENT: an empty `workdays` list is taken literally (no day is a
 * business day) rather than falling back to the Mon–Fri default of
 * BR-SLA-01, because the oracle receives the calendar already resolved.
 */
function businessDayTest(calendar: OracleCalendar): (days: number) => boolean {
  const workdays = weekdaySet(calendar.workdays, 'calendar.workdays')
  const holidays = new Set<number>()
  for (const holiday of calendar.holidays) holidays.add(parseDay(holiday, 'calendar.holidays'))
  return (days) => workdays.has(weekdayOf(days)) && !holidays.has(days)
}

// ---------------------------------------------------------------------------
// Amount of one item (BR-PAY-04 · BR-WHT-10 · BR-MONEY-02 (3))
// ---------------------------------------------------------------------------

const BASIS_POINTS = 10_000n

/** Half-up division of a non-negative numerator (BR-MONEY-02). */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n)
}

function assertSatang(value: bigint, what: string): void {
  if (typeof value !== 'bigint') throw new RangeError(`${what}: money must be bigint satang`)
}

/**
 * SPEC SILENT: BR-WHT-10 does not bound the rate. A rate must be a whole
 * number of basis points from 0 to 10000 (0%–100%); anything else is input
 * the rate table could never hold, so it throws.
 */
function assertRateBp(rateBp: number): void {
  if (!Number.isSafeInteger(rateBp) || rateBp < 0 || rateBp > 10_000) {
    throw new RangeError(`rateBp: expected a whole number from 0 to 10000, got ${String(rateBp)}`)
  }
}

/**
 * One payment item = every document of one supplier in the run.
 * payable = Σ payable of the documents (S8 already applied VAT and retention).
 * wht     = bases of all documents added per (income type, rate), each group
 *           rounded half-up once (BR-WHT-10), groups in order of first
 *           appearance.
 * transfer = payable − wht and must be > 0 (PAYMENT_ITEM_NOT_POSITIVE).
 */
export function oracleBuildItem(docs: readonly OracleDoc[]): OracleItem {
  let payable = 0n
  const groups: Array<{ incomeType: string; rateBp: number; base: bigint }> = []
  const groupIndex = new Map<string, number>()

  for (const doc of docs) {
    if (doc.kind !== 'INVOICE' && doc.kind !== 'RETENTION') {
      throw new RangeError(`doc.kind: unknown kind ${String(doc.kind)}`)
    }
    assertSatang(doc.payable, 'doc.payable')
    // SPEC SILENT: a single document's payable or line base is not checked
    // for sign here. BR-PAY-04 only constrains the item's transfer (> 0) and
    // BR-WHT-10 only the base of a whole group (≥ 0); the S8 tables already
    // keep stored amounts ≥ 0, so a negative value is summed as given.
    payable += doc.payable
    for (const line of doc.whtLines) {
      assertRateBp(line.rateBp)
      assertSatang(line.base, 'whtLine.base')
      const key = JSON.stringify([line.incomeType, line.rateBp])
      const index = groupIndex.get(key)
      const group = index === undefined ? undefined : groups[index]
      if (group) {
        group.base += line.base
      } else {
        groupIndex.set(key, groups.length)
        groups.push({ incomeType: line.incomeType, rateBp: line.rateBp, base: line.base })
      }
    }
  }

  // SPEC SILENT: when a group base is negative and the item would also not be
  // positive, WHT_BASE_NEGATIVE wins: the tax (BR-WHT-10) has to exist before
  // transfer = payable − wht can be checked (BR-PAY-04).
  if (groups.some((group) => group.base < 0n)) {
    return { ok: false, code: 'VALIDATION_FAILED', reason: 'WHT_BASE_NEGATIVE' }
  }

  // SPEC SILENT: a group whose bases add up to exactly 0 is kept as a line
  // with wht 0 (BR-WHT-10 keeps one result per group and gives no rule to
  // drop it).
  const whtLines = groups.map((group) => ({
    incomeType: group.incomeType,
    rateBp: group.rateBp,
    base: group.base,
    wht: divideHalfUp(group.base * BigInt(group.rateBp), BASIS_POINTS),
  }))
  const wht = whtLines.reduce((sum, line) => sum + line.wht, 0n)
  const transfer = payable - wht

  // SPEC SILENT: an item with no documents has payable 0 and transfer 0, so
  // it fails like GC-PAY-09 instead of needing its own code.
  if (transfer <= 0n) return { ok: false, code: 'PAYMENT_ITEM_NOT_POSITIVE', transfer }
  return { ok: true, payable, whtLines, wht, transfer }
}

// ---------------------------------------------------------------------------
// Totals of a run (BR-PAY-05)
// ---------------------------------------------------------------------------

/**
 * SPEC SILENT: "ordered by supplier code" does not name a collation. Codes
 * are compared by UTF-16 code unit (the same as a binary/"C" collation),
 * never by locale, so the order cannot depend on the machine.
 */
function compareCodes(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * One item per supplier, seq from 1 in supplier-code order, run totals = Σ of
 * the items. A failing item makes the whole run fail with that supplier's
 * code and error.
 */
export function oracleBuildRun(suppliers: ReadonlyArray<{ code: string; docs: readonly OracleDoc[] }>): OracleRun {
  // SPEC SILENT: two entries with the same supplier code are the same
  // supplier, and BR-PAY-04 allows one item per supplier, so their documents
  // are merged into one item (in input order) instead of making two items.
  const docsByCode = new Map<string, OracleDoc[]>()
  for (const supplier of suppliers) {
    const docs = docsByCode.get(supplier.code)
    if (docs) docs.push(...supplier.docs)
    else docsByCode.set(supplier.code, [...supplier.docs])
  }
  const ordered = [...docsByCode.entries()].sort(([a], [b]) => compareCodes(a, b))

  const items: Array<{ seq: number; code: string; payable: bigint; wht: bigint; transfer: bigint }> = []
  const totals = { payable: 0n, wht: 0n, transfer: 0n, itemCount: 0, documentCount: 0 }
  for (const [code, docs] of ordered) {
    const item = oracleBuildItem(docs)
    // SPEC SILENT: when several suppliers fail, the run reports the first one
    // in seq (supplier-code) order, whatever its error.
    if (!item.ok) return { ...item, supplierCode: code }
    items.push({ seq: items.length + 1, code, payable: item.payable, wht: item.wht, transfer: item.transfer })
    totals.payable += item.payable
    totals.wht += item.wht
    totals.transfer += item.transfer
    totals.documentCount += docs.length
  }
  totals.itemCount = items.length
  // SPEC SILENT: a run without suppliers is not an error here (all totals 0);
  // whether an empty run may be submitted is a service rule, not an amount.
  return { ok: true, items, totals }
}

// ---------------------------------------------------------------------------
// Pay date (BR-PAY-02)
// ---------------------------------------------------------------------------

/** How far ahead a proposed run date is searched before giving up. */
const RUN_DATE_SEARCH_DAYS = 3660

/**
 * Proposed pay date: the first day from today (inclusive) whose weekday is in
 * `runWeekdays`. If that day is not a business day it moves by
 * `holidayShift` (PREVIOUS = the business day before, NEXT = the business
 * day after); if a PREVIOUS move lands before today, the next run weekday is
 * tried instead.
 */
export function oracleNextRunDate(
  today: string,
  policy: { runWeekdays: readonly OracleWeekday[]; holidayShift: 'PREVIOUS' | 'NEXT' },
  calendar: OracleCalendar,
): string {
  const start = parseDay(today, 'today')
  const runDays = weekdaySet(policy.runWeekdays, 'policy.runWeekdays')
  if (policy.holidayShift !== 'PREVIOUS' && policy.holidayShift !== 'NEXT') {
    throw new RangeError(`policy.holidayShift: unknown value ${String(policy.holidayShift)}`)
  }
  const isBusinessDay = businessDayTest(calendar)
  const last = start + RUN_DATE_SEARCH_DAYS

  for (let candidate = start; candidate <= last; candidate++) {
    if (!runDays.has(weekdayOf(candidate))) continue
    // SPEC SILENT: "a holiday" is read as "not a business day", so a run
    // weekday that is not a working weekday (e.g. SAT in a Mon–Fri calendar)
    // also moves, because the proposal must pass the BR-PAY-02 check.
    if (isBusinessDay(candidate)) return formatDay(candidate)

    if (policy.holidayShift === 'PREVIOUS') {
      // The business day before the candidate; searching only down to today
      // is enough, because anything earlier is "before today" → next round.
      for (let day = candidate - 1; day >= start; day--) {
        if (isBusinessDay(day)) return formatDay(day)
      }
      continue
    }
    for (let day = candidate + 1; day <= candidate + RUN_DATE_SEARCH_DAYS; day++) {
      if (isBusinessDay(day)) return formatDay(day)
    }
  }
  // SPEC SILENT: an empty runWeekdays list, or a calendar with no business
  // day in reach, has no proposal and no error code; it throws.
  throw new RangeError('no payment run date can be proposed from this policy and calendar')
}

/**
 * The pay date must be a business day and not before today in Thai time.
 * SPEC SILENT: when both fail, NOT_BUSINESS_DAY is reported, following the
 * order in which BR-PAY-02 states the two conditions and their reasons.
 */
export function oracleCheckPayDate(
  payDate: string,
  at: Date,
  calendar: OracleCalendar,
): { ok: true } | { ok: false; code: 'PAYMENT_DATE_INVALID'; reason: 'PAST' | 'NOT_BUSINESS_DAY' } {
  const day = parseDay(payDate, 'payDate')
  const today = thaiToday(at)
  const isBusinessDay = businessDayTest(calendar)
  if (!isBusinessDay(day)) return { ok: false, code: 'PAYMENT_DATE_INVALID', reason: 'NOT_BUSINESS_DAY' }
  if (day < today) return { ok: false, code: 'PAYMENT_DATE_INVALID', reason: 'PAST' }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Proposed documents (BR-PAY-03)
// ---------------------------------------------------------------------------

/**
 * Proposes every invoice due on or before the pay date and every releasable
 * retention (a retention's dueDate, if any, is ignored).
 * SPEC SILENT: the result keeps the input order (and any repeated id), since
 * the rule filters and does not sort.
 */
export function oracleProposeDocuments(
  payDate: string,
  docs: ReadonlyArray<{ id: string; kind: 'INVOICE' | 'RETENTION'; dueDate?: string | null }>,
): string[] {
  const pay = parseDay(payDate, 'payDate')
  const proposed: string[] = []
  for (const doc of docs) {
    if (doc.kind === 'RETENTION') {
      proposed.push(doc.id)
    } else if (doc.kind === 'INVOICE') {
      // SPEC SILENT: an invoice without a due date is not proposed:
      // "dueDate ≤ payDate" cannot hold for a missing date (as in SQL), and
      // the preparer can still add it by hand as an early payment.
      if (doc.dueDate === undefined || doc.dueDate === null) continue
      if (parseDay(doc.dueDate, 'doc.dueDate') <= pay) proposed.push(doc.id)
    } else {
      throw new RangeError(`doc.kind: unknown kind ${String(doc.kind)}`)
    }
  }
  return proposed
}

// ---------------------------------------------------------------------------
// Transfer date of a PAID item (BR-PAY-12)
// ---------------------------------------------------------------------------

/**
 * payDate ≤ paidOn ≤ today in Thai time.
 * SPEC SILENT: when both fail (pay date in the future and paidOn between
 * today and the pay date), PAID_ON_BEFORE_PAY_DATE is reported, the order in
 * which BR-PAY-12 lists the two reasons.
 */
export function oracleCheckPaidOn(
  payDate: string,
  paidOn: string,
  at: Date,
): { ok: true } | { ok: false; code: 'VALIDATION_FAILED'; reason: 'PAID_ON_BEFORE_PAY_DATE' | 'PAID_ON_FUTURE' } {
  const pay = parseDay(payDate, 'payDate')
  const paid = parseDay(paidOn, 'paidOn')
  const today = thaiToday(at)
  if (paid < pay) return { ok: false, code: 'VALIDATION_FAILED', reason: 'PAID_ON_BEFORE_PAY_DATE' }
  if (paid > today) return { ok: false, code: 'VALIDATION_FAILED', reason: 'PAID_ON_FUTURE' }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Flags of an item (BR-PAY-06) and the flags key (BR-PAY-07)
// ---------------------------------------------------------------------------

/** Every flag in the order BR-PAY-06 lists them. */
const FLAG_ORDER = [
  'REGISTRY_CHANGED',
  'SUPPLIER_INACTIVE',
  'RISK_OVERRIDE_EXPIRED',
  'PREVIOUSLY_EXPORTED',
  'BANK_ACCOUNT_RECENTLY_CHANGED',
  'BANK_CHANGE_PENDING',
  'SHARED_BANK_ACCOUNT',
] as const

/** The first four flags need a reason from the preparer before submitting. */
const FLAGS_NEEDING_REASON: ReadonlySet<string> = new Set(FLAG_ORDER.slice(0, 4))

/**
 * SPEC SILENT: a tax id that is missing (null, or blank after trimming)
 * cannot prove two suppliers are branches of the same taxpayer, so it counts
 * as a different tax id; the flag is a warning that does not block payment
 * (OQ-132), so the cautious side is to raise it.
 */
function presentTaxId(taxId: string | null): string | null {
  if (taxId === null) return null
  const trimmed = taxId.trim()
  return trimmed === '' ? null : trimmed
}

export function oracleItemFlags(
  input: {
    payDate: string
    supplier: { registryFlag: string; status: string; taxId: string | null }
    account: { activatedOn: string; fromSeed: boolean }
    riskOverrides?: ReadonlyArray<{ expiresOn: string }>
    previouslyExported?: boolean
    pendingChange?: boolean
    sameAccountTaxIds?: ReadonlyArray<string | null>
  },
  policy: { recentBankChangeDays: number },
): { flags: string[]; requiresReason: boolean } {
  const pay = parseDay(input.payDate, 'payDate')
  const activatedOn = parseDay(input.account.activatedOn, 'account.activatedOn')
  // SPEC SILENT: the window is the 0–365 whole days that the settings schema
  // of S9 allows; anything else is a caller error.
  const window = policy.recentBankChangeDays
  if (!Number.isSafeInteger(window) || window < 0 || window > 365) {
    throw new RangeError(`policy.recentBankChangeDays: expected a whole number from 0 to 365, got ${String(window)}`)
  }

  const flags: string[] = []
  // REGISTRY_CHANGED: Supplier.registryFlag ≠ NONE (BR-SUP-04 · ADR-132).
  if (input.supplier.registryFlag !== 'NONE') flags.push('REGISTRY_CHANGED')
  // SUPPLIER_INACTIVE: Supplier.status has only ACTIVE and INACTIVE (§6),
  // so any status other than ACTIVE is treated as inactive.
  if (input.supplier.status !== 'ACTIVE') flags.push('SUPPLIER_INACTIVE')
  // RISK_OVERRIDE_EXPIRED: an S11 override with expiresOn < payDate; an
  // override that ends on the pay date itself is still valid (GC-PAY-31).
  const overrides = input.riskOverrides ?? []
  if (overrides.some((override) => parseDay(override.expiresOn, 'riskOverrides.expiresOn') < pay)) {
    flags.push('RISK_OVERRIDE_EXPIRED')
  }
  // PREVIOUSLY_EXPORTED: a document was released from a run whose file had
  // been downloaded (releasedAfterExport · OQ-136).
  if (input.previouslyExported === true) flags.push('PREVIOUSLY_EXPORTED')
  // BANK_ACCOUNT_RECENTLY_CHANGED: activatedOn ≥ payDate − N days; seed
  // accounts never count.
  if (!input.account.fromSeed && activatedOn >= pay - window) flags.push('BANK_ACCOUNT_RECENTLY_CHANGED')
  // BANK_CHANGE_PENDING: a bank account change request is still open.
  if (input.pendingChange === true) flags.push('BANK_CHANGE_PENDING')
  // SHARED_BANK_ACCOUNT: the same account is ACTIVE for a supplier with a
  // different tax id; branches of the same tax id do not count.
  const ownTaxId = presentTaxId(input.supplier.taxId)
  const shared = (input.sameAccountTaxIds ?? []).some((other) => {
    const otherTaxId = presentTaxId(other)
    return ownTaxId === null || otherTaxId === null || otherTaxId !== ownTaxId
  })
  if (shared) flags.push('SHARED_BANK_ACCOUNT')

  return { flags, requiresReason: flags.some((flag) => FLAGS_NEEDING_REASON.has(flag)) }
}

/**
 * Puts one item's flags in BR-PAY-06 order.
 * SPEC SILENT: a flag outside BR-PAY-06 throws (it cannot be placed in the
 * order), and a repeated flag is written once, because the flags of an item
 * are a set.
 */
function orderFlags(flags: readonly string[]): string[] {
  const rank = new Map<string, number>(FLAG_ORDER.map((flag, index) => [flag, index]))
  const unique = new Set<string>()
  for (const flag of flags) {
    if (!rank.has(flag)) throw new RangeError(`unknown payment flag ${flag}`)
    unique.add(flag)
  }
  return [...unique].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
}

/**
 * "<supplier code>:<flag>+<flag>" for each item that has flags, items in
 * supplier-code order joined by ";", flags in BR-PAY-06 order; "" when no
 * item has a flag. Not hashed.
 * SPEC SILENT: items with the same code keep their input order and are not
 * merged (a run has one item per supplier, so this only happens on bad input).
 */
export function oracleFlagsKey(items: ReadonlyArray<{ code: string; flags: readonly string[] }>): string {
  return items
    .map((item, index) => ({ code: item.code, flags: orderFlags(item.flags), index }))
    .filter((item) => item.flags.length > 0)
    .sort((a, b) => compareCodes(a.code, b.code) || a.index - b.index)
    .map((item) => `${item.code}:${item.flags.join('+')}`)
    .join(';')
}
