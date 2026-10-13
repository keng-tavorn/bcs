import { emptyAdapter } from './empty'

// The BANK_ACCOUNT_CHANGE approval subject (ADR-068). Filled by S9 (lane 2, BR-SUP-06); its channels stay off (BR-DOA-25); until then the empty adapter of P1-07.
export const bankAccountChangeSubject = emptyAdapter('BANK_ACCOUNT_CHANGE')
