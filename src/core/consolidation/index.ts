// Grouping approved request lines into draft POs (spec §7.10, BR-CONS-01 to BR-CONS-05): lines with a supplier wait for
// the next round and are grouped by (supplier, delivery site, goods or service) — one draft PO per group; lines of an
// urgent request do not wait and make their own drafts at once, grouped the same way within the request; lines with no
// supplier yet stay in the pool, marked "choose a supplier". Groups and the lines in them follow the request number,
// then the line number, so the same pool always gives the same drafts.

export type LineKind = 'GOODS' | 'SERVICE'

export interface PoolLine {
  /** The request line as the pool shows it, e.g. "PR-2569-00012/1" */
  readonly ref: string
  readonly requestNo: string
  readonly lineNo: number
  readonly supplierId: string | null
  readonly siteId: string | null
  readonly kind: LineKind
  /** BR-CONS-02 */
  readonly urgent?: boolean
}

export interface Consolidation {
  /** Drafts of the next round, one per (supplier, site, kind) */
  readonly cycleGroups: readonly (readonly string[])[]
  /** Drafts made at once for urgent requests */
  readonly immediate: readonly (readonly string[])[]
  /** Lines that need a supplier first */
  readonly unassigned: readonly string[]
}

const byNumber = (a: PoolLine, b: PoolLine) => a.requestNo.localeCompare(b.requestNo, 'en', { numeric: true }) || a.lineNo - b.lineNo

function group(lines: readonly PoolLine[], key: (l: PoolLine) => string): string[][] {
  const groups = new Map<string, string[]>()
  for (const l of lines) groups.set(key(l), [...(groups.get(key(l)) ?? []), l.ref])
  // Map keeps the order groups were first seen in, and the lines arrive sorted, so groups follow their first line
  return [...groups.values()]
}

export function consolidate(pool: readonly PoolLine[]): Consolidation {
  const sorted = [...pool].sort(byNumber)
  const unassigned = sorted.filter((l) => l.supplierId === null).map((l) => l.ref)
  const ready = sorted.filter((l) => l.supplierId !== null)
  const groupKey = (l: PoolLine) => JSON.stringify([l.supplierId, l.siteId, l.kind])
  return {
    cycleGroups: group(
      ready.filter((l) => !l.urgent),
      groupKey,
    ),
    immediate: group(
      ready.filter((l) => l.urgent),
      (l) => JSON.stringify([l.requestNo, l.supplierId, l.siteId, l.kind]),
    ),
    unassigned,
  }
}
