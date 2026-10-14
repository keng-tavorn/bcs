// What the withholding-tax and retention commands answer their screens (S8-13, spec §14.2, §9.9 rule 7): success with
// what the screen shows next, or the error code with the screen-safe parts of its details — never the service's raw
// message. The browser turns the code into words (./failure-text.ts).

export type TaxFailure = {
  readonly ok: false
  readonly code: string
  /** VALIDATION_FAILED: which field is wrong (CODE, NAME, RATE, MONTH, INPUT) */
  readonly field?: string
  /** RETENTION_NOT_DUE: the due date in the reader's language; absent when the PO is not received in full */
  readonly date?: string
}

export type TaxOutcome = { readonly ok: true } | TaxFailure

export type RevealOutcome = { readonly ok: true; readonly taxId: string } | TaxFailure

export type ExportOutcome =
  | { readonly ok: true; readonly fileId: string; readonly rowCount: number; readonly total: string; readonly checksum: string }
  | TaxFailure

/** No answer came back from the server action (the connection dropped): pressing again runs it once (spec §4.3) */
export const NO_ANSWER: TaxFailure = { ok: false, code: 'NO_ANSWER' }
