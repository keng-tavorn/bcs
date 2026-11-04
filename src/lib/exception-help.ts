import { EXCEPTION_HELP_MESSAGE_MAX_CHARS } from './constants'

// What the helper of an invoice's differences (NEW-126 · ADR-081) shares between its service and its screen: the ways it
// may offer, in the order the service lists them, and the longest message a person may send from it.

export const HELP_FIXES = ['VARIANCE', 'PO_CHANGE', 'RECEIVE', 'ASK', 'EMAIL_SUPPLIER', 'RECHECK', 'DISMISS_DUPLICATE', 'REOPEN', 'REJECT', 'BUDGET_TRANSFER'] as const
export type HelpFix = (typeof HELP_FIXES)[number]

/** The longest message a person may send from the helper, in characters */
export const HELP_MESSAGE_MAX = EXCEPTION_HELP_MESSAGE_MAX_CHARS
