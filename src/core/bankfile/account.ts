import { bankOf } from './banks'

// BR-SUP-07: an account number as the bank's passbook writes it (dashes and spaces allowed) is kept as its digits only,
// 10 to 12 of them; the bank code is one of the list in the program (ADR-131); the account's name has no control
// character (it goes into the bank file as one field of one line). Shown masked: every digit but the last four is "•".

export type AccountReason = 'ACCOUNT_NO_FORMAT' | 'ACCOUNT_NO_LENGTH' | 'BANK_CODE_UNKNOWN' | 'ACCOUNT_NAME_FORMAT'
export type CheckedAccount = { readonly ok: true; readonly accountNo: string; readonly masked: string } | { readonly ok: false; readonly code: 'VALIDATION_FAILED'; readonly reason: AccountReason }

const ACCOUNT_DIGITS = { min: 10, max: 12 } as const
/** The passbook's dashes and spaces; a tab, a line break or any other character is not a separator */
const SEPARATORS = /[- ]/g
const CONTROL = /\p{Cc}/u
const MASK = '•'
const SHOWN_DIGITS = 4

/** "••••••0016": every digit but the last four hidden */
export function maskAccount(accountNo: string): string {
  return MASK.repeat(Math.max(accountNo.length - SHOWN_DIGITS, 0)) + accountNo.slice(-SHOWN_DIGITS)
}

/**
 * The account number kept and shown, or why it is refused: what the number is made of before how many digits it has
 * (a number with a letter is wrong whatever its length; one of dashes and spaces only is a number of no digits), then
 * the bank, then the name
 */
export function normalizeAccount(input: { readonly bankCode: string; readonly accountNo: string; readonly accountName?: string }): CheckedAccount {
  const digits = input.accountNo.replace(SEPARATORS, '')
  if (/[^0-9]/.test(digits)) return refused('ACCOUNT_NO_FORMAT')
  if (digits.length < ACCOUNT_DIGITS.min || digits.length > ACCOUNT_DIGITS.max) return refused('ACCOUNT_NO_LENGTH')
  if (!bankOf(input.bankCode)) return refused('BANK_CODE_UNKNOWN')
  if (input.accountName !== undefined && CONTROL.test(input.accountName)) return refused('ACCOUNT_NAME_FORMAT')
  return { ok: true, accountNo: digits, masked: maskAccount(digits) }
}

const refused = (reason: AccountReason): CheckedAccount => ({ ok: false, code: 'VALIDATION_FAILED', reason })
