// The subjects an e-mail action link names in its heading (messages actionLink.subject): every subject of an approval
// route (APPROVAL_SUBJECTS of src/core/sod, which tests/unit/subject-names.test.ts compares this with · P1-07), so a
// budget transfer or a PO change is never headed as a purchase request
export const LINK_SUBJECTS = [
  'REQUEST',
  'PURCHASE_ORDER',
  'VARIANCE',
  'DOA_VERSION',
  'ORG_AUTHORITY_CHANGE',
  'BUDGET_TRANSFER',
  'BUDGET_OVERRUN',
  'WORKFLOW_VERSION',
  'INVOICE',
  'PO_CHANGE',
  'PAYMENT_RUN',
  'BANK_ACCOUNT_CHANGE',
] as const

export type LinkSubject = (typeof LINK_SUBJECTS)[number]

/** The subject of a link by its type; a type the list lacks reads as a purchase request (the first kind of link) */
export const linkSubjectOf = (type: string): LinkSubject => LINK_SUBJECTS.find((s) => s === type) ?? 'REQUEST'
