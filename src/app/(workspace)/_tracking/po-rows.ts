import type { TaskRow } from '@/ui/tasks/task-list'
import type { HomeT } from './pool-row'

// The POs that wait on procurement, as rows of the home's work (§9.9 principle 1; §9.1 "/": งานของฉัน), beside the pool
// (./pool-row.ts): a draft PO waits for procurement to check it and send it for approval, an approved PO for procurement to
// send it to its supplier — the PO page says each wait (purchaseOrder.waiting EDIT and SEND). Once the round drafted the
// lines they leave the pool, so without these rows procurement's home would say nothing waits for them. One row per state
// with POs in it, each with its count and a link to the PO list filtered to that state, where every one of them is
// listed (§9.9: every number leads to its list).

/** The PO list filtered to one state */
export const posHref = (status: 'DRAFT' | 'APPROVED'): string => `/procurement/pos?status=${status}`

/** The home rows of the POs waiting on procurement, from their counts; none when nothing waits */
export function poRows(t: HomeT, counts: { readonly DRAFT: number; readonly APPROVED: number }): TaskRow[] {
  const rows: TaskRow[] = []
  if (counts.DRAFT > 0) rows.push({ id: 'pos-draft', href: posHref('DRAFT'), title: t('po.drafts', { count: counts.DRAFT }), states: [], tags: [] })
  if (counts.APPROVED > 0) rows.push({ id: 'pos-approved', href: posHref('APPROVED'), title: t('po.approved', { count: counts.APPROVED }), states: [], tags: [] })
  return rows
}
