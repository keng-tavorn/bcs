import { requestErrorKey, type ActionFailure, type RequestErrorKey } from '../tasks/outcome'

// When the request page offers "ขอซ้ำ" and "สร้างคำขอต่ออายุ" (S6-12 · FR-INT-101, BR-FORM-07, BR-FORM-08), and what a
// refusal says. Only the requester asks again (request.reorder OWN): a follower, a department head or PROCUREMENT sees
// neither button. A draft is edited, not reordered. A service line is renewed once the request was ordered at least in
// part, or done — the requests whose service lines the daily reminder names. The page decides only what it shows: the
// service checks the requester, the state and the line again (BR-AUTH-05), and its refusal is said beside the button.

/** The request statuses whose service lines are renewed (the reminder's, src/server/services/requests/repeat.ts) */
export const RENEWABLE_STATUSES: readonly string[] = ['PARTIALLY_ORDERED', 'ORDERED', 'COMPLETED']

/** "ขอซ้ำ": the requester's own request, sent at least once (any status but DRAFT) */
export function canReorder(mine: boolean, status: string): boolean {
  return mine && status !== 'DRAFT'
}

/** "สร้างคำขอต่ออายุ" on its service lines: the requester's own request, ordered at least in part or done */
export function canRenew(mine: boolean, status: string): boolean {
  return mine && RENEWABLE_STATUSES.includes(status)
}

/** What a reorder or a renewal answers its button: the new draft, or why not */
export type RepeatOutcome = { readonly ok: true; readonly requestId: string } | ActionFailure

export type RepeatErrorKey = RequestErrorKey | 'TYPE_INACTIVE' | 'NOT_A_SERVICE_LINE'

/**
 * Message key under requestView.errors for a refused reorder or renewal: the request type is no longer offered, the line
 * is not a service line, or what the requester actions say for the rest (a draft: STATE; not the requester: FORBIDDEN)
 */
export function repeatErrorKey(failure: ActionFailure): RepeatErrorKey {
  if (failure.code === 'VALIDATION_FAILED' && failure.reason === 'TYPE_INACTIVE') return 'TYPE_INACTIVE'
  if (failure.code === 'VALIDATION_FAILED' && failure.reason === 'NOT_A_SERVICE_LINE') return 'NOT_A_SERVICE_LINE'
  return requestErrorKey(failure)
}
