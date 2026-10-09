// The statuses the lists filter by, as plain data with nothing else imported, so a page's address filters
// (src/app/(workspace)/_tracking/list-filters.ts) read them without loading the database client

/** Every status a request may have: a purchase request's and a new-supplier request's */
export const REQUEST_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'PARTIALLY_ORDERED', 'ORDERED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'SUBMITTED', 'DONE'] as const

export const PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED', 'REJECTED'] as const
