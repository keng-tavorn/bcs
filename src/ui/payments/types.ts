import type { PayOutcome } from './outcome'

// What the payment run screens draw (S9-09), as plain JSON from the server's view: amounts in satang as decimal
// strings, days as yyyy-mm-dd, times as ISO strings, accounts masked to their bank and last four digits. The screens
// format them in the reader's language (money with two decimals and thousands separators, Buddhist-era dates).

export interface NameView {
  readonly th: string
  readonly en: string | null
}

export interface MaskedAccountView {
  readonly code: string | null
  readonly bankCode: string
  readonly bankName: string | null
  readonly bankShort: string | null
  readonly last4: string
}

export interface RunDocumentView {
  readonly kind: 'INVOICE' | 'RETENTION'
  readonly id: string
  readonly number: string | null
  readonly supplierInvoiceNo: string | null
  readonly dueDate: string | null
  readonly payableSatang: string
}

export interface RunItemView {
  readonly id: string
  readonly seq: number | null
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
  readonly account: MaskedAccountView | null
  readonly payableSatang: string
  readonly whtSatang: string
  readonly transferSatang: string
  readonly flags: readonly string[]
  readonly flagReason: string | null
  readonly reasonNeeded: boolean
  readonly status: 'INCLUDED' | 'PAID' | 'FAILED'
  readonly paidOn: string | null
  readonly bankReference: string | null
  readonly failureReason: string | null
  readonly documents: ReadonlyArray<RunDocumentView & { readonly status: 'HELD' | 'PAID' | 'RELEASED' }>
  readonly advice: { readonly status: string; readonly sentAt: string | null; readonly sendings: number } | null
}

export interface RunFileView {
  readonly id: string
  readonly version: number
  readonly fileName: string
  readonly sha256Short: string
  readonly itemCount: number
  readonly totalSatang: string
  readonly generatedBy: NameView
  readonly generatedAt: string
  readonly firstDownloadedAt: string | null
  readonly status: 'CURRENT' | 'SUPERSEDED'
  readonly reason: string | null
}

export interface AddableSupplierView {
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly hasAccount: boolean }
  readonly documents: readonly RunDocumentView[]
}

/** A server action of the run's page: the raw input and one submission's idempotency key */
export type PayAction = (input: unknown, idempotencyKey: string) => Promise<PayOutcome>

export interface RunActions {
  readonly addDocuments: PayAction
  readonly removeDocuments: PayAction
  readonly setFlagReason: PayAction
  readonly submit: PayAction
  readonly cancelDraft: PayAction
  readonly generateFile: PayAction
  readonly regenerateFile: PayAction
  readonly downloadFile: PayAction
  readonly markSent: PayAction
  readonly revertSent: PayAction
  readonly cancelApproved: PayAction
  readonly recordResults: PayAction
  readonly resendAdvice: PayAction
}

/** Names in the reader's language when the organization gave one */
export const nameIn = (locale: string, name: { readonly th: string; readonly en: string | null }): string => (locale === 'en' && name.en ? name.en : name.th)
export const supplierName = (locale: string, s: { readonly nameTh: string; readonly nameEn: string | null }): string => (locale === 'en' && s.nameEn ? s.nameEn : s.nameTh)
