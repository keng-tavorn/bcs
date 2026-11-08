import { TZDate } from '@date-fns/tz'
import { MS_PER_DAY } from '../money/constants'

// Supplier documents (S7 · docs/sub-specs/S7.md · golden supplier-documents): the dates of a document (BR-SDOC ข้อ 02),
// its state on a day (BR-SDOC ข้อ 02 ข้อ 04), whether it may be verified (BR-SDOC ข้อ 03 · BR-PORTAL ข้อ 07) and which
// verified copies a new one replaces (BR-SDOC ข้อ 03). Dates are calendar dates "YYYY-MM-DD" of Asia/Bangkok, never
// business days. normalizeScope is the one definition S10 and S11 use too. Pure.

/** A date-only value: "2027-05-01" */
export type IsoDate = string

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** "2026-11-03" + 179 → "2027-05-01" (UTC midnight arithmetic: a date has no time zone of its own) */
export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10)
}

/** The date of an instant in a time zone (BR-SDOC ข้อ 02: Asia/Bangkok) */
export function dateIn(at: Date, timezone: string): IsoDate {
  const local = new TZDate(at.getTime(), timezone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
}

export interface DocumentTypeTerms {
  /** null: the document states its own expiry (an ISO certificate) */
  readonly validityDays: number | null
  readonly reminderDaysBefore: number
}

export type DocumentDates =
  | { readonly ok: true; readonly expiresOn: IsoDate; readonly remindOn: IsoDate; readonly statedExpiresOn?: IsoDate }
  | { readonly ok: false; readonly code: 'VALIDATION_FAILED'; readonly reason: 'VALIDITY_DAYS' | 'EXPIRY_REQUIRED' | 'EXPIRY_BEFORE_ISSUE' | 'ISSUED_IN_FUTURE' | 'DATE' }

/**
 * BR-SDOC ข้อ 02: a type with validityDays lasts that many days including the day it was issued (expiresOn = issuedOn +
 * validityDays − 1), and the expiry printed on the document is kept as statedExpiresOn only; a type without one takes
 * the printed expiry. remindOn = max(expiresOn − reminderDaysBefore, issuedOn) (GC-SUP-34 to 42). `today`, when given,
 * refuses a document issued after it.
 */
export function documentExpiry(terms: DocumentTypeTerms, document: { readonly issuedOn: IsoDate; readonly expiresOn?: IsoDate | null }, today?: IsoDate): DocumentDates {
  const stated = document.expiresOn ?? null
  if (!ISO_DATE.test(document.issuedOn) || (stated !== null && !ISO_DATE.test(stated))) return { ok: false, code: 'VALIDATION_FAILED', reason: 'DATE' }
  if (terms.validityDays !== null && (!Number.isInteger(terms.validityDays) || terms.validityDays <= 0)) return { ok: false, code: 'VALIDATION_FAILED', reason: 'VALIDITY_DAYS' }
  if (today !== undefined && document.issuedOn > today) return { ok: false, code: 'VALIDATION_FAILED', reason: 'ISSUED_IN_FUTURE' }
  let expiresOn: IsoDate
  if (terms.validityDays !== null) expiresOn = addDays(document.issuedOn, terms.validityDays - 1)
  else if (stated === null) return { ok: false, code: 'VALIDATION_FAILED', reason: 'EXPIRY_REQUIRED' }
  else expiresOn = stated
  if (expiresOn < document.issuedOn) return { ok: false, code: 'VALIDATION_FAILED', reason: 'EXPIRY_BEFORE_ISSUE' }
  const reminder = addDays(expiresOn, -terms.reminderDaysBefore)
  const remindOn = reminder < document.issuedOn ? document.issuedOn : reminder
  return { ok: true, expiresOn, remindOn, ...(terms.validityDays !== null && stated !== null ? { statedExpiresOn: stated } : {}) }
}

export type SupplierDocumentState = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED' | 'SUPERSEDED'

/**
 * BR-SDOC ข้อ 02 ข้อ 04: a verified document on the day of `now` in the time zone — EXPIRED the day after expiresOn,
 * reminder due from remindOn (GC-SUP-43 to 46). A document in any other state stays as it is and is not reminded of.
 */
export function documentStatus(
  document: { readonly status?: SupplierDocumentState; readonly expiresOn: IsoDate; readonly remindOn: IsoDate },
  now: Date,
  timezone: string,
): { status: SupplierDocumentState; reminderDue: boolean } {
  const status = document.status ?? 'VERIFIED'
  if (status !== 'VERIFIED') return { status, reminderDue: false }
  const today = dateIn(now, timezone)
  return { status: today > document.expiresOn ? 'EXPIRED' : 'VERIFIED', reminderDue: today >= document.remindOn }
}

export type ScanState = 'PENDING' | 'CLEAN' | 'INFECTED'

/** BR-SDOC ข้อ 03 · BR-PORTAL ข้อ 07: only a PENDING document whose file was scanned CLEAN may be verified (GC-SUP-47) */
export function canVerify(document: { readonly status: SupplierDocumentState; readonly scanStatus: ScanState }): { ok: true } | { ok: false; code: 'VALIDATION_FAILED' | 'INVALID_STATE_TRANSITION'; reason: string } {
  if (document.status !== 'PENDING') return { ok: false, code: 'INVALID_STATE_TRANSITION', reason: document.status }
  if (document.scanStatus === 'PENDING') return { ok: false, code: 'VALIDATION_FAILED', reason: 'FILE_NOT_SCANNED' }
  if (document.scanStatus === 'INFECTED') return { ok: false, code: 'VALIDATION_FAILED', reason: 'FILE_INFECTED' }
  return { ok: true }
}

const SPACES = /\s+/gu

/**
 * BR-SDOC ข้อ 03: the scope of a certificate as copies of one type are told apart — NFC, trimmed, lower case, every run
 * of white space (tab and no-break space too) one space; null is '' (GC-SUP-52 to 54). SupplierDocument.scopeKey keeps it.
 */
export function normalizeScope(scope: string | null): string {
  return scope === null ? '' : scope.normalize('NFC').replace(SPACES, ' ').trim().toLowerCase()
}

/**
 * BR-SDOC ข้อ 03: the verified copies a newly verified document replaces — every one of a single-instance type, else
 * those of the same scope after normalizeScope — and the ones it keeps, each in the order given.
 */
export function supersedeTargets<T extends { readonly id: string; readonly scope: string | null }>(
  type: { readonly singleInstance: boolean },
  newDocument: { readonly scope: string | null },
  verified: readonly T[],
): { supersedes: string[]; keeps: string[] } {
  const key = normalizeScope(newDocument.scope)
  const replaced = (d: T) => type.singleInstance || normalizeScope(d.scope) === key
  return { supersedes: verified.filter(replaced).map((d) => d.id), keeps: verified.filter((d) => !replaced(d)).map((d) => d.id) }
}
