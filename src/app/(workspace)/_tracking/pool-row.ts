import type { getTranslations } from 'next-intl/server'
import type { PoolLineDto } from '@/server/services/procurement'
import type { StateKind } from '@/ui/request-view/status'
import type { TaskRow } from '@/ui/tasks/task-list'
import { poolCounts } from '../procurement/pool/present'

// The procurement pool as a row of the home's work (§9.9 principle 1; §9.1 "/": งานของฉัน): for PROCUREMENT the approved
// requests nobody has ordered yet are work waiting for them (FR-P2P-001 AC1), beside the approval tasks. The row says how
// many requests and lines wait and what each kind of line waits for, counted as the pool page counts them (poolCounts:
// a supplier to choose, BR-CONS-03; the next round; or nothing yet, NEW-50), and links to the pool, which lists them all.

export type HomeT = Awaited<ReturnType<typeof getTranslations<'home'>>>

/** The pool page, where every line of the row is listed */
export const POOL_HREF = '/procurement/pool'

/** The pool's row on the home page, or null when no line waits */
export function poolRow(t: HomeT, lines: readonly PoolLineDto[]): TaskRow | null {
  if (lines.length === 0) return null
  const counts = poolCounts(lines)
  const states: Array<{ kind: StateKind; text: string }> = []
  if (counts.needSupplier > 0) states.push({ kind: 'waiting', text: t('pool.needSupplier', { count: counts.needSupplier }) })
  if (counts.ready > 0) states.push({ kind: 'draft', text: t('pool.ready', { count: counts.ready }) })
  if (counts.blocked > 0) states.push({ kind: 'closed', text: t('pool.blocked', { count: counts.blocked }) })
  return {
    id: 'procurement-pool',
    href: POOL_HREF,
    title: t('pool.title', { requests: new Set(lines.map((l) => l.requestId)).size, lines: lines.length }),
    states,
    tags: [],
  }
}
