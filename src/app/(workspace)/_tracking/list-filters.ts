import { createLoader, createParser, createSerializer, parseAsString, parseAsStringLiteral } from 'nuqs/server'
import { PO_STATUSES, REQUEST_STATUSES } from '@/server/queries/statuses'

// The filters of the lists the home page links to, kept in the address with nuqs (spec §9.10, FR-VIS-006 AC2): one
// parser per filter, read by the list's page (a loader) and written by the links that open it (a serializer), so a
// home row and its list always mean the same filter. Statuses read in any case and are written in lower case
// (/requests?status=returned), the way the table of §9.10 writes them.

/** A status of `values`, read in any case and written in lower case */
function caseless<const T extends string>(values: readonly T[]) {
  return createParser<T>({
    parse: (value) => values.find((v) => v === value.toUpperCase()) ?? null,
    serialize: (value) => value.toLowerCase(),
  })
}

/** /tasks: overdue — waiting for my decision past the due time · info — waiting for the requester's answer */
export const TASK_FILTERS = { due: parseAsStringLiteral(['overdue', 'info'] as const) }
export const loadTaskFilters = createLoader(TASK_FILTERS)
export const tasksHref = createSerializer(TASK_FILTERS)

/** /requests: mine — I am the requester · following — mine and followed, not drafts · info=open — a question waits for its answer */
export const REQUEST_FILTERS = {
  q: parseAsString,
  status: caseless(REQUEST_STATUSES),
  scope: parseAsStringLiteral(['mine', 'following'] as const),
  info: parseAsStringLiteral(['open'] as const),
}
export const loadRequestFilters = createLoader(REQUEST_FILTERS)
export const requestsHref = createSerializer(REQUEST_FILTERS)

/** /procurement/pos */
export const PO_FILTERS = { q: parseAsString, status: caseless(PO_STATUSES) }
export const loadPoFilters = createLoader(PO_FILTERS)
export const posHref = createSerializer(PO_FILTERS)

/** /finance/invoices: gr=posted — only POs with goods received */
export const INVOICE_FILTERS = { q: parseAsString, gr: parseAsStringLiteral(['posted'] as const) }
export const loadInvoiceFilters = createLoader(INVOICE_FILTERS)
export const invoicesHref = createSerializer(INVOICE_FILTERS)
