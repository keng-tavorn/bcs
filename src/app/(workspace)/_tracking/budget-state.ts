import type { RequestViewDto } from '@/server/queries/requests'
import type { StateKind } from '@/ui/request-view/status'

/**
 * The state of a request's budget (§7.7) with its mark, as the request page and the decision pages show it, on the web
 * and in LIFF: held — reserved while the request waits for approval, or committed in a purchase order — as a padlock in
 * --info (`held`), never the approved mark of --primary, since holding is not approving (§9.9 tokens: --primary is
 * "approved"); given back once rejected or cancelled; nothing held yet. The words are requestView.budget.state*.
 */
export function requestBudgetState(view: Pick<RequestViewDto, 'budget' | 'status'>): { kind: StateKind; key: 'stateReserved' | 'stateCommitted' | 'stateReleased' | 'stateNone' } {
  const b = view.budget
  if (b && b.committedSatang > 0n) return { kind: 'held', key: 'stateCommitted' }
  if (b && b.reservedSatang > 0n) return { kind: 'held', key: 'stateReserved' }
  if (view.status === 'REJECTED' || view.status === 'CANCELLED') return { kind: 'closed', key: 'stateReleased' }
  return { kind: 'draft', key: 'stateNone' }
}
