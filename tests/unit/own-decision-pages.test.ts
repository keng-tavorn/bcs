import { describe, expect, it } from 'vitest'
import { ownDecisionPage } from '@/app/(workspace)/tasks/_parts/own-pages'

// S9-09 (BR-PAY-07, BR-DOA-25): the task of a payment run or a bank account change opens on the subject's own page, where
// the approver acknowledges the flags the page shows (their key goes with the approval) or sees both accounts before
// the step-up; every other subject is decided on /tasks/[id].

describe('[FR-PAY-101/AC5] the task of a payment run is decided on the run’s page', () => {
  it('a payment run and a bank account change open on their own pages; other subjects stay on /tasks/[id]', () => {
    expect(ownDecisionPage({ subjectType: 'PAYMENT_RUN', subjectId: 'r1' })).toBe('/finance/payments/r1')
    expect(ownDecisionPage({ subjectType: 'BANK_ACCOUNT_CHANGE', subjectId: 'c1' })).toBe('/finance/bank-accounts/changes/c1')
    for (const subjectType of ['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'INVOICE', 'PO_CHANGE', 'DOA_VERSION']) expect(ownDecisionPage({ subjectType, subjectId: 'x' })).toBeNull()
  })
})
