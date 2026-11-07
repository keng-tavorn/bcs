import { TZDate } from '@date-fns/tz'
import { MS_PER_MINUTE } from '../money/constants'
import { addBusinessMinutes, businessMinutesBetween, type BusinessCalendar } from '../sla'
import { isValidThaiTaxId, normalizeTaxId } from '../thai/taxid'

// Supplier onboarding (S7 · docs/sub-specs/S7.md · golden supplier-onboarding): the duplicate check of an invitation or
// an application (BR-SUP ข้อ 09), the OTP check of the portal (BR-PORTAL ข้อ 02), the SLA of an application waiting for
// the supplier (BR-SUP ข้อ 12) and the business days of KPI G-7 (BR-SUP ข้อ 13). Pure: the server passes the
// existing suppliers and open applications, the stored hashes and the instant; nothing here reads, draws or guesses.

// ---------- names (BR-SUP ข้อ 09) ----------

/**
 * The words that only say what kind of company a name belongs to, longest first so "co., ltd." goes before "ltd.".
 * Lower case: names are lower-cased before they are compared.
 */
export const LEGAL_FORM_WORDS = [
  'ห้างหุ้นส่วนจำกัด',
  'ห้างหุ้นส่วนสามัญ',
  'จำกัด (มหาชน)',
  'company limited',
  'บริษัท',
  '(มหาชน)',
  'co., ltd.',
  'co.,ltd.',
  'limited',
  'บมจ.',
  'บจก.',
  'หจก.',
  'หสน.',
  'จำกัด',
  'บจ.',
  'ltd.',
  'inc.',
  'ltd',
  'plc',
  'inc',
] as const

const LATIN = /[a-z]/
/** Where a Thai legal word may touch the rest of the name: a space, a dot or a bracket (or the end of the text) */
const THAI_EDGE = /^[\s.()]$/
/** A trailing bracket such as "(สาขาชลบุรี)": kept, so two branches of one company never read as the same name */
const TRAILING_BRACKET = /\s*\([^()]*\)\s*$/
/** What is dropped once the words are gone */
const SEPARATORS = /[\s.,-]+/g

const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** An English word counts only as a whole word: no a–z or 0–9 right before or after it ("prince" keeps its "inc") */
const LATIN_WORDS = LEGAL_FORM_WORDS.filter((w) => LATIN.test(w)).map((w) => new RegExp(`(?<![a-z0-9])${escaped(w)}(?![a-z0-9])`, 'g'))
const THAI_WORDS = LEGAL_FORM_WORDS.filter((w) => !LATIN.test(w))

/** A Thai legal word at the head of the name, followed by a space, a dot or a bracket (or ending in a dot itself) */
function dropThaiHead(text: string): string {
  for (const word of THAI_WORDS) {
    if (!text.startsWith(word)) continue
    const next = text.charAt(word.length)
    if (word.endsWith('.') || next === '' || THAI_EDGE.test(next)) return text.slice(word.length).trimStart()
  }
  return text
}

/** A Thai legal word at the tail of the name, after a space, a dot or a bracket; a trailing bracket of its own stays */
function dropThaiTail(text: string): string {
  for (const word of THAI_WORDS) {
    if (!text.endsWith(word)) continue
    const before = text.charAt(text.length - word.length - 1)
    if (before === '' || THAI_EDGE.test(before)) return text.slice(0, text.length - word.length).trimEnd()
  }
  const bracket = TRAILING_BRACKET.exec(text)
  if (bracket && bracket.index > 0) {
    const head = text.slice(0, bracket.index)
    const dropped = dropThaiTail(head)
    if (dropped !== head) return dropped + bracket[0]
  }
  return text
}

/**
 * BR-SUP ข้อ 09: a name as the duplicate check compares it — NFC, trimmed, lower case, without the words of its legal
 * form (whole words only), without spaces, dots, commas and dashes; a bracket at the end is kept (GC-SUP-09 to 13, 48).
 * Repeated until it holds still, so it is idempotent.
 */
export function normalizeSupplierName(name: string): string {
  let text = name.normalize('NFC').trim().toLowerCase()
  // Until nothing changes, so normalizing twice gives what normalizing once gave (dropping the separators may join
  // "l td" into a word of its own)
  for (let changed = true; changed; ) {
    const before = text
    for (const word of LATIN_WORDS) text = text.replace(word, ' ')
    text = dropThaiTail(dropThaiHead(text.trim())).replace(SEPARATORS, '')
    changed = text !== before
  }
  return text
}

/** An e-mail as the duplicate check compares it: trimmed and lower case */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

// ---------- duplicates (BR-SUP ข้อ 09) ----------

/** A supplier of the organization (any status) or an open application, as the check sees it */
export interface ExistingSupplier {
  /** What the warning names: a supplier's code or an application's number or id */
  readonly ref: string
  readonly taxId: string | null
  readonly branchCode: string | null
  readonly nameTh: string
  /** Supplier.email and the e-mails of its contacts (an application: its contacts) */
  readonly emails: readonly string[]
}

/** What was typed in an invitation or an application */
export interface SupplierCandidate {
  /** null for a foreign payee without a Thai taxpayer id: (ก) and (ข) are skipped (GC-SUP-49) */
  readonly taxId: string | null
  readonly branchCode: string | null
  readonly nameTh: string
  readonly email: string | null
}

export type DuplicateWarningCode = 'SAME_TAXID_OTHER_BRANCH' | 'DUPLICATE_NAME' | 'DUPLICATE_EMAIL'
export interface DuplicateWarning {
  readonly code: DuplicateWarningCode
  readonly matches: readonly string[]
}

export type DuplicateCheck =
  | { readonly ok: true; readonly warnings: readonly DuplicateWarning[] }
  | { readonly ok: false; readonly code: 'VALIDATION_FAILED'; readonly reason: 'TAXID_CHECKSUM' }
  | { readonly ok: false; readonly code: 'DUPLICATE_SUPPLIER'; readonly reason: 'DUPLICATE_TAXID'; readonly matches: readonly string[] }

/**
 * BR-SUP ข้อ 09: (ก) the same taxpayer id and branch blocks, with no warnings beside it · (ข) the same id at another
 * branch, (ค) the same name once normalized, (ง) the same e-mail warn, in that order, each with the refs it matched in
 * the order given. A taxpayer id that fails its check digit is refused before anything is compared.
 */
export function findSupplierDuplicates(candidate: SupplierCandidate, existing: readonly ExistingSupplier[]): DuplicateCheck {
  const taxId = candidate.taxId === null || candidate.taxId.trim() === '' ? null : normalizeTaxId(candidate.taxId)
  if (taxId !== null && !isValidThaiTaxId(taxId)) return { ok: false, code: 'VALIDATION_FAILED', reason: 'TAXID_CHECKSUM' }
  const warnings: DuplicateWarning[] = []
  const add = (code: DuplicateWarningCode, matches: readonly ExistingSupplier[]) => {
    if (matches.length) warnings.push({ code, matches: matches.map((m) => m.ref) })
  }
  if (taxId !== null) {
    const sameId = existing.filter((e) => e.taxId !== null && normalizeTaxId(e.taxId) === taxId)
    const sameBranch = sameId.filter((e) => e.branchCode === candidate.branchCode)
    if (sameBranch.length) return { ok: false, code: 'DUPLICATE_SUPPLIER', reason: 'DUPLICATE_TAXID', matches: sameBranch.map((m) => m.ref) }
    add('SAME_TAXID_OTHER_BRANCH', sameId)
  }
  const name = normalizeSupplierName(candidate.nameTh)
  add(
    'DUPLICATE_NAME',
    existing.filter((e) => normalizeSupplierName(e.nameTh) === name),
  )
  const email = candidate.email === null ? '' : normalizeEmail(candidate.email)
  add(
    'DUPLICATE_EMAIL',
    email === '' ? [] : existing.filter((e) => e.emails.some((x) => normalizeEmail(x) === email)),
  )
  return { ok: true, warnings }
}

// ---------- OTP (BR-PORTAL ข้อ 02) ----------

export interface OtpSettings {
  readonly otpMinutes: number
  readonly otpMaxAttempts: number
  readonly otpLockMinutes: number
}

/** A challenge as stored: the hash of its code, never the code (NFR-SEC-09) */
export interface OtpChallenge {
  readonly createdAt: Date
  readonly codeHash: string
  readonly attempts: number
  readonly lockedUntil: Date | null
}

export type OtpCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'OTP_LOCKED' }
  | { readonly ok: false; readonly code: 'OTP_EXPIRED' }
  | { readonly ok: false; readonly code: 'OTP_INVALID'; readonly attempts: number; readonly remaining: number }
  /** The wrong code that used the last attempt: the challenge is locked from now on */
  | { readonly ok: false; readonly code: 'OTP_LOCKED'; readonly attempts: number; readonly lockedUntil: Date }

/** Compares two hashes in time that does not depend on where they first differ */
export function sameHash(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/**
 * BR-PORTAL ข้อ 02: locked (now < lockedUntil) → expired (now ≥ createdAt + otpMinutes) → the code. A wrong code counts
 * an attempt; the one that reaches otpMaxAttempts locks the challenge for otpLockMinutes (GC-SUP-20 to 25, 50).
 */
export function verifyOtp(challenge: OtpChallenge, attemptHash: string, now: Date, settings: OtpSettings): OtpCheck {
  if (challenge.lockedUntil !== null && now.getTime() < challenge.lockedUntil.getTime()) return { ok: false, code: 'OTP_LOCKED' }
  if (now.getTime() >= challenge.createdAt.getTime() + settings.otpMinutes * MS_PER_MINUTE) return { ok: false, code: 'OTP_EXPIRED' }
  if (sameHash(challenge.codeHash, attemptHash)) return { ok: true }
  const attempts = challenge.attempts + 1
  if (attempts >= settings.otpMaxAttempts) return { ok: false, code: 'OTP_LOCKED', attempts, lockedUntil: new Date(now.getTime() + settings.otpLockMinutes * MS_PER_MINUTE) }
  return { ok: false, code: 'OTP_INVALID', attempts, remaining: settings.otpMaxAttempts - attempts }
}

// ---------- SLA of an application (BR-SUP ข้อ 12) and KPI G-7 (BR-SUP ข้อ 13) ----------

export interface ApplicationSlaSettings {
  readonly applicationReminderBusinessDays: number
  readonly applicationEscalateBusinessDays: number
  readonly applicationExpireDays: number
}

/** Business minutes of one business day of the calendar (08:30–17:30 → 540) */
export function businessDayMinutes(calendar: BusinessCalendar): number {
  const minutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    return h! * 60 + m!
  }
  return minutes(calendar.end) - minutes(calendar.start)
}

/**
 * BR-SUP ข้อ 12: remind after applicationReminderBusinessDays from the last activity, escalate once after
 * applicationEscalateBusinessDays from the invitation (activity never moves it · GC-SUP-51), expire
 * applicationExpireDays calendar days after the invitation (GC-SUP-26 to 29).
 */
export function applicationSla(
  application: { readonly invitedAt: Date; readonly lastActivityAt: Date },
  settings: ApplicationSlaSettings,
  calendar: BusinessCalendar,
): { remindAt: Date; escalateAt: Date; expiresAt: Date } {
  const day = businessDayMinutes(calendar)
  const invited = new TZDate(application.invitedAt.getTime(), calendar.timezone)
  const expiresAt = new TZDate(
    invited.getFullYear(),
    invited.getMonth(),
    invited.getDate() + settings.applicationExpireDays,
    invited.getHours(),
    invited.getMinutes(),
    invited.getSeconds(),
    invited.getMilliseconds(),
    calendar.timezone,
  )
  return {
    remindAt: addBusinessMinutes(application.lastActivityAt, settings.applicationReminderBusinessDays * day, calendar),
    escalateAt: addBusinessMinutes(application.invitedAt, settings.applicationEscalateBusinessDays * day, calendar),
    expiresAt: new Date(expiresAt.getTime()),
  }
}

const TENTHS = 10

/** "2.1" from 21 tenths */
const tenthsText = (tenths: number) => `${Math.floor(tenths / TENTHS)}.${tenths % TENTHS}`
const tenthsOf = (text: string) => {
  const [whole, fraction = '0'] = text.split('.')
  return Number(whole) * TENTHS + Number(`${fraction}0`.charAt(0))
}

/**
 * BR-SUP ข้อ 13: the business days from invitation to approval of each application, one decimal rounded half up
 * (businessMinutesBetween ÷ the minutes of a business day · GC-SUP-30). Whole numbers only, no floating point.
 */
export function g7BusinessDays(applications: ReadonlyArray<{ readonly invitedAt: Date; readonly decidedAt: Date }>, calendar: BusinessCalendar): string[] {
  const day = businessDayMinutes(calendar)
  return applications.map((a) => {
    const minutes = businessMinutesBetween(a.invitedAt, a.decidedAt, calendar)
    return tenthsText(Math.floor((minutes * TENTHS * 2 + day) / (day * 2)))
  })
}

/** BR-SUP ข้อ 13: the lower median of the business days (the lower of the two middle values), null of none (GC-SUP-31 to 33) */
export function g7Median(days: readonly string[]): string | null {
  if (days.length === 0) return null
  const sorted = days.map(tenthsOf).sort((a, b) => a - b)
  return tenthsText(sorted[Math.floor((sorted.length - 1) / 2)]!)
}
