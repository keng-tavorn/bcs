import { ASSISTANT_DUE_SOON_MS } from './assistant-suggestions'
import { FOLLOW_UP_MESSAGE_MAX_CHARS, FOLLOW_UP_QUIET_MS, FOLLOW_UPS_PER_TASK_PER_DAY } from './constants'

// What the follow-up assistant (NEW-124 · ADR-082) shares between its service and its screens: which tasks it lists,
// when a nudge may go, the anchors that open a row or its draft, and the longest nudge.

/** A task is listed once its due time is past, or within this long (the home card's measure) */
export const FOLLOW_UP_DUE_SOON_MS = ASSISTANT_DUE_SOON_MS
export const FOLLOW_UP_MAX = FOLLOW_UP_MESSAGE_MAX_CHARS
export const FOLLOW_UP_VIAS = ['LINE', 'EMAIL'] as const
export type FollowUpVia = (typeof FOLLOW_UP_VIAS)[number]
/** How the reader follows the document: asked for it, follows it (request.follow), or made the PO */
export type FollowUpRelation = 'REQUESTER' | 'FOLLOWER' | 'BUYER'

/** The row of a task on /follow-ups, and its draft (reached by a link, the draft opens) */
export const followUpRowAnchor = (taskId: string) => `follow-up-${taskId}`
export const followUpDraftAnchor = (taskId: string) => `follow-up-${taskId}-draft`
export const FOLLOW_UP_PATH = '/follow-ups'

/** Why a nudge may not go now, and when it may */
export type FollowUpHold = { readonly reason: 'SENT_TODAY' | 'TOLD_RECENTLY'; readonly nextAt: Date }

/**
 * Whether a task may be nudged at `now`: at most FOLLOW_UPS_PER_TASK_PER_DAY nudges in the organization's day
 * [dayStart, nextDayStart), whoever sent them; and none within FOLLOW_UP_QUIET_MS of the last time its assignee was told
 * of it (the SLA job's reminder, overdue or escalation notice, or a reminder from the board). Null: it may go now. When
 * both hold it back, the later time is when it may go.
 */
export function followUpHold(at: { readonly now: Date; readonly nextDayStart: Date; readonly sentToday: number; readonly lastToldAt: Date | null }): FollowUpHold | null {
  const holds: FollowUpHold[] = []
  if (at.sentToday >= FOLLOW_UPS_PER_TASK_PER_DAY) holds.push({ reason: 'SENT_TODAY', nextAt: at.nextDayStart })
  if (at.lastToldAt && at.now.getTime() < at.lastToldAt.getTime() + FOLLOW_UP_QUIET_MS) holds.push({ reason: 'TOLD_RECENTLY', nextAt: new Date(at.lastToldAt.getTime() + FOLLOW_UP_QUIET_MS) })
  return holds.sort((a, b) => b.nextAt.getTime() - a.nextAt.getTime())[0] ?? null
}

/** A task the assistant lists: open with a due time that is past, or comes within FOLLOW_UP_DUE_SOON_MS */
export const dueForFollowUp = (dueAt: Date | null, now: Date): dueAt is Date => dueAt !== null && dueAt.getTime() - now.getTime() <= FOLLOW_UP_DUE_SOON_MS
