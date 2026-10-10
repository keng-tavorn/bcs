import { createLoader, parseAsNumberLiteral, parseAsString, parseAsStringLiteral } from 'nuqs/server'
import type { PoolFilter } from '@/server/services/procurement'

// The pool's filters in the address (spec §9.10 "ตัวกรอง", S16-10), read on the server with nuqs: ?supplier= a supplier's
// id or NONE (lines that still need one) · ?site= a delivery site's id · ?urgency=NORMAL|URGENT · ?age= whole days since
// approval (1, 3 or 7). The names are those the page has always used, so links and bookmarks keep working.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The age filter's choices, in whole days since approval */
export const POOL_AGES = [1, 3, 7] as const

export const loadPoolFilters = createLoader({
  supplier: parseAsString,
  site: parseAsString,
  urgency: parseAsStringLiteral(['NORMAL', 'URGENT'] as const),
  age: parseAsNumberLiteral(POOL_AGES),
})

/** What the service filters on: an id that is not one is ignored, as before */
export function poolFilterOf(params: Awaited<ReturnType<typeof loadPoolFilters>>): PoolFilter {
  const { supplier, site, urgency, age } = params
  return {
    ...(supplier && (supplier === 'NONE' || UUID.test(supplier)) ? { supplierId: supplier } : {}),
    ...(site && UUID.test(site) ? { deliverySiteId: site } : {}),
    ...(urgency ? { urgency } : {}),
    ...(age !== null ? { minAgeDays: age } : {}),
  }
}
