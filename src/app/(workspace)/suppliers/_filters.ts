import { createLoader, parseAsString, parseAsStringLiteral } from 'nuqs/server'

// The filters of the supplier register (/suppliers, S16-10), kept in the address with nuqs (spec §9.10): the search
// (name, code, tax id, and for readers of prices an item sold), the status, and — for readers who see the register in
// full — only the suppliers without an Express vendor code (BR-EXP-04). The names are the ones the page always used
// (?q=…&status=ACTIVE&missing=1), so older links and the home's chip keep working.
export const SUPPLIER_FILTERS = {
  q: parseAsString,
  status: parseAsStringLiteral(['ACTIVE', 'INACTIVE'] as const),
  missing: parseAsStringLiteral(['1'] as const),
}
export const loadSupplierFilters = createLoader(SUPPLIER_FILTERS)
