import { emptyAdapter } from './empty'

// The PAYMENT_RUN approval subject (ADR-068). Filled by S9 (lane 2, BR-PAY-08); until then the empty adapter of P1-07.
export const paymentRunSubject = emptyAdapter('PAYMENT_RUN')
