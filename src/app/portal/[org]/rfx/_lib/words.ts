import type { getTranslations } from 'next-intl/server'
import { formatEnglishBeDate, formatEnglishBeDateTime, formatThaiDate, formatThaiDateTime } from '@/core/thai'
import { BID_FILES_MAX, MS_PER_HOUR, MS_PER_MINUTE } from '@/lib/constants'

// What the RFx pages of the portal share (S10-07): the contact's language — its own SupplierContact.locale, not the
// browser's cookie (docs/sub-specs/S10.md "/portal/rfx") — its dates, the time left before the close, and the words of
// ?error= and ?reason= as the routes send them back (an unknown code reads as a failure).

export type PortalT = Awaited<ReturnType<typeof getTranslations<'portal'>>>
export type PortalLocale = 'th' | 'en'

export const contactLocale = (contact: { readonly locale: string }): PortalLocale => (contact.locale === 'en' ? 'en' : 'th')

export const RFX_KINDS = ['RFQ', 'RFP', 'RFI'] as const
export const rfxKindOf = (kind: string): (typeof RFX_KINDS)[number] => ((RFX_KINDS as readonly string[]).includes(kind) ? (kind as (typeof RFX_KINDS)[number]) : 'RFQ')

export const dateTimeOf = (locale: PortalLocale, d: Date) => (locale === 'en' ? formatEnglishBeDateTime(d) : formatThaiDateTime(d))
/** A calendar day stored at UTC midnight reads as the same day in Bangkok */
export const dayOf = (locale: PortalLocale, d: Date) => (locale === 'en' ? formatEnglishBeDate(d) : formatThaiDate(d))

/** The time left before the close, as days and hours, or hours and minutes in the last day; null once closed */
export function remainingText(t: PortalT, closesAt: Date | null, now: Date): string | null {
  if (!closesAt) return null
  const ms = closesAt.getTime() - now.getTime()
  if (ms <= 0) return null
  const hours = Math.floor(ms / MS_PER_HOUR)
  if (hours >= 24) return t('rfx.detail.remaining', { days: Math.floor(hours / 24), hours: hours % 24 })
  return t('rfx.detail.remainingHours', { hours, minutes: Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE) })
}

const ERRORS = [
  'NOT_FOUND',
  'RFX_CLOSED',
  'SUPPLIER_NOT_APPROVED',
  'VAT_INCLUSIVE_NOT_ALLOWED',
  'QUESTION_CUTOFF_PASSED',
  'CONFLICT_VERSION',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_STATE_TRANSITION',
  'VALIDATION_FAILED',
  'TAX_RATE_NOT_CONFIGURED',
  'FILE_INFECTED',
  'RATE_LIMITED',
  'PRIVACY_NOTICE_OUTDATED',
  'MODULE_DISABLED',
] as const
const REASONS = ['PRICE', 'RFI_NO_PRICE', 'TYPE_NOT_ALLOWED', 'TOO_LARGE', 'EMPTY'] as const

/** The words of a refusal the routes sent back in ?error= ?reason= ?lines= */
export function rfxErrorText(t: PortalT, code: string, reason?: string, lines?: string): string {
  if (code === 'BID_INCOMPLETE') return t('rfx.errors.BID_INCOMPLETE', { lines: lines ?? '-' })
  if (reason === 'TOO_MANY_FILES') return t('rfx.reasons.TOO_MANY_FILES', { max: BID_FILES_MAX })
  if (reason && (REASONS as readonly string[]).includes(reason)) return t(`rfx.reasons.${reason as (typeof REASONS)[number]}`)
  return (ERRORS as readonly string[]).includes(code) ? t(`rfx.errors.${code as (typeof ERRORS)[number]}`) : t('rfx.errors.FAILED')
}

/** The words of a refusal for the bid form's file buttons (JSON answers), keyed as they come: reason first, then code */
export function fileErrorWords(t: PortalT): Record<string, string> {
  const out: Record<string, string> = { TOO_MANY_FILES: t('rfx.reasons.TOO_MANY_FILES', { max: BID_FILES_MAX }) }
  for (const r of REASONS) out[r] = t(`rfx.reasons.${r}`)
  for (const c of ERRORS) out[c] = t(`rfx.errors.${c}`)
  return out
}
