import { emptyAdapter } from './empty'

// The INVOICE approval subject (ADR-068). Filled by S8 (lane 2, BR-AP-05 BR-AP-06); until then the empty adapter of P1-07.
export const invoiceSubject = emptyAdapter('INVOICE')
