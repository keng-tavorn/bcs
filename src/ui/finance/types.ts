// What the finance screens show (S4-08, S4-17, S4-09): plain JSON a server action or route hands to the browser — money
// arrives as text already formatted with thousands separators and two decimals (from BigInt satang on the server, never
// a float), dates in the reader's language.

/** One PO line's share of an invoice (BR-IVC-04) */
export interface InvoicePartView {
  readonly poLineId: string
  readonly description: string
  /** "CON-OPEX-2569 · ค่าใช้จ่ายดำเนินงาน ฝ่ายก่อสร้าง" */
  readonly budgetLine: string
  readonly amount: string
}

/** What moves from committed to actual on one budget line (FR-P2P-008 AC2) */
export interface BudgetMoveView {
  readonly budgetLineId: string
  readonly budgetLine: string
  readonly amount: string
}

/** AC3: what a last invoice gives back — now on a closed PO, or when procurement closes the PO */
export interface GiveBackView {
  readonly when: 'NOW' | 'ON_CLOSE'
  readonly amount: string
  /** Lines still waiting for goods: closing the PO waits for them */
  readonly unsettledLines: number
}

/** What recording the invoice will do, calculated by the server before anything is written (§9.9 principle 3) */
export interface InvoicePreviewView {
  readonly invoiceNo: string
  /** As the reader's language shows a date */
  readonly invoiceDate: string
  readonly net: string
  readonly vat: string
  readonly gross: string
  /** "7" (percent) or null when the PO has no rate */
  readonly vatRate: string | null
  readonly expectedVat: string
  readonly vatWarning: boolean
  readonly parts: readonly InvoicePartView[]
  readonly moves: readonly BudgetMoveView[]
  readonly heldBefore: string
  readonly heldAfter: string
  readonly isFinal: boolean
  readonly giveBack: GiveBackView | null
  /** BR-IVC-05, decided by the server from the stored file: read from the e-Tax file, or typed */
  readonly source: 'ETAX_XML' | 'MANUAL'
  /** A file goes with the invoice */
  readonly withFile: boolean
}

/** What happened once the invoice was recorded, as the server answered */
export interface InvoiceDoneView {
  readonly invoiceNo: string
  readonly parts: readonly InvoicePartView[]
  readonly moves: readonly BudgetMoveView[]
  readonly vatWarning: { readonly expected: string; readonly given: string } | null
  readonly isFinal: boolean
  /** Where the server recorded the values as coming from (BR-IVC-05) */
  readonly parsedFrom: 'ETAX_XML' | 'MANUAL'
  /** Final on a closed PO: what went back to the budget; final on an open PO: what goes back when it closes */
  readonly giveBack: GiveBackView | null
  /** What the PO still holds now */
  readonly heldAfter: string
  /** More invoices may follow on this PO */
  readonly more: boolean
}

/** The values read from an e-Tax file (BR-IVC-05), as the form takes them */
export interface EtaxPrefillView {
  readonly invoiceNo: string
  /** YYYY-MM-DD, for the date field */
  readonly invoiceDate: string
  /** Baht with two decimals, no separators ("32100.00") */
  readonly net: string
  readonly vat: string
  readonly gross: string
  /** "0-9999-99000-01-2" */
  readonly sellerTaxId: string
  readonly sellerBranch: string | null
}

export type EtaxProblemKey = 'XML_UNREADABLE' | 'NOT_AN_ETAX_INVOICE' | 'VALUE_MISSING' | 'TAX_ID_MISMATCH'

/**
 * What the invoice form sends, for the check and for recording: amounts as typed (separators allowed); the server
 * cleans and checks them again. Never where the values came from: the server decides that from the file (BR-IVC-05).
 */
export interface InvoiceFormInput {
  readonly poId: string
  readonly invoiceNo: string
  readonly invoiceDate: string
  readonly net: string
  readonly vat: string
  readonly isFinal: boolean
  /** The file the e-Tax reader kept, when it goes with the invoice */
  readonly sourceFileId: string | null
}
