import { createLoader, parseAsString } from 'nuqs/server'

// The audit search in the address, read with nuqs (spec §9.10, S16-10): document number, actor, period, event type,
// channel and the page to continue from, under the names the page always used. auditQuery (./_present) still checks
// each value — an id, a day, a known type and channel — so the service receives exactly what it did before.
export const AUDIT_FILTERS = {
  document: parseAsString,
  actor: parseAsString,
  from: parseAsString,
  to: parseAsString,
  type: parseAsString,
  channel: parseAsString,
  before: parseAsString,
}
export const loadAuditFilters = createLoader(AUDIT_FILTERS)

/** The loader's values as the plain address auditQuery reads: a missing value is left out */
export async function readAuditParams(searchParams: Promise<Record<string, string | string[] | undefined>>): Promise<Record<string, string | undefined>> {
  const f = await loadAuditFilters(searchParams)
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v ?? undefined]))
}
