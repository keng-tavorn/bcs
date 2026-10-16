import { formatSatang } from '@/core/money/format'
import { formatEnglishBeDay, formatThaiDay } from '@/core/thai/day'
import type { MaskedAccountView } from './types'

// The payment run screens' formatting (§9.9 rule 6, FR-PLT-002 AC3), the same on the server and in the browser: money
// from satang as a decimal string with thousands separators and two decimals (never a float), days in the Buddhist era
// in the reader's language, and an account as its bank and last four digits — the full number never reaches the page.

export const money = (satang: string): string => formatSatang(BigInt(satang))

export const dayText = (locale: string, day: string): string => (locale === 'en' ? formatEnglishBeDay(day) : formatThaiDay(day)) ?? day

/** The bank's name in Thai, its short name in English, its code when the list has neither */
export const bankText = (locale: string, account: MaskedAccountView): string => (locale === 'en' ? (account.bankShort ?? account.bankCode) : (account.bankName ?? account.bankCode))

/** The values of payRun.account.masked / withCode */
export const accountValues = (locale: string, account: MaskedAccountView) => ({ code: account.code ?? '', bank: bankText(locale, account), last4: account.last4 })

/** The event's key under payRun.history.event: its type with dots as underscores (a key cannot hold a dot) */
export const eventKey = (type: string): string => type.replace(/\./g, '_')
