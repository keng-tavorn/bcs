// S9-09: subjects decided on a page of their own rather than on /tasks/[id] — a payment run, whose approval sends the
// key of the flags the page showed and their acknowledgement (BR-PAY-07), and a bank account change, which shows the
// old and the new account side by side and is always decided with the step-up (BR-DOA-25). Their task opens there.

const OWN_PAGES: Readonly<Record<string, (subjectId: string) => string>> = {
  PAYMENT_RUN: (id) => `/finance/payments/${id}`,
  BANK_ACCOUNT_CHANGE: (id) => `/finance/bank-accounts/changes/${id}`,
}

/** The page the task of this subject is decided on, or null when it is /tasks/[id] itself */
export function ownDecisionPage(task: { readonly subjectType: string; readonly subjectId: string }): string | null {
  return OWN_PAGES[task.subjectType]?.(task.subjectId) ?? null
}
