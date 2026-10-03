import { addBusinessMinutes, businessMinutesBetween, type BusinessCalendar } from '@/core/sla'
import { remindShareOf } from '../approvals/route'

// The timers of an approval task (spec §7.8, BR-SLA-02 to BR-SLA-04): reminded part-way through its SLA, overdue at
// dueAt, escalated escalateAfter business minutes later. The DOA version keeps the policy (DoaVersion.escalationPolicy:
// remindPct as a share of the SLA, escalateAfterBusinessHours from the DOA_Policy sheet), so no time is written here
// except the defaults of BR-SLA-02 for a version that names none. Pure: the caller gives every instant.

/** BR-SLA-02: escalateAt is 480 business minutes after dueAt unless the version says otherwise */
export const DEFAULT_ESCALATE_AFTER_MINUTES = 480
const MINUTES_PER_HOUR = 60
const PERCENT = 100

export interface SlaPolicy {
  /** Share of the SLA after which the assignee is reminded (0..1) */
  readonly remindShare: number
  /** Business minutes from dueAt to escalateAt */
  readonly escalateAfterMinutes: number
}

const wholeMinutes = (value: unknown): number | null => {
  const n = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isInteger(n) && n >= 0 ? n : null
}

/** The SLA policy of a DOA version (escalationPolicy JSON); anything missing or malformed falls back to BR-SLA-02. */
export function slaPolicyOf(escalationPolicy: unknown): SlaPolicy {
  const p = (escalationPolicy && typeof escalationPolicy === 'object' ? escalationPolicy : {}) as { escalateAfterBusinessMinutes?: unknown; escalateAfterBusinessHours?: unknown }
  const minutes = wholeMinutes(p.escalateAfterBusinessMinutes)
  const hours = wholeMinutes(p.escalateAfterBusinessHours)
  return {
    remindShare: remindShareOf(escalationPolicy),
    escalateAfterMinutes: minutes ?? (hours !== null ? hours * MINUTES_PER_HOUR : DEFAULT_ESCALATE_AFTER_MINUTES),
  }
}

/** Business minutes into the SLA at which the assignee is reminded: the share as a whole percent, half up (as core remindAt) */
export function remindMinutesOf(slaMinutes: number, remindShare: number): number {
  return Math.floor((slaMinutes * Math.round(remindShare * PERCENT) + PERCENT / 2) / PERCENT)
}

export interface SlaTaskState {
  readonly assignedAt: Date
  readonly dueAt: Date | null
  readonly remindAt: Date | null
  readonly slaMinutes: number
  /** When the requester last answered a question on this task (BR-SLA-03); null if the SLA never paused */
  readonly lastResumedAt: Date | null
  /** The SLA reminder of this task was sent already */
  readonly reminded: boolean
}

export interface SlaTimes {
  /** null: nothing to remind (sent already, its point passed before the task reached this assignee, or at or after dueAt) */
  readonly remindAt: Date | null
  readonly dueAt: Date
  readonly escalateAt: Date
}

/**
 * When the open task is reminded, due and escalated. dueAt is the task's own: set at assignment (BR-SLA-02) and counted
 * again from the time left when a question is answered (BR-SLA-03, request.provideInfo). After such an answer the
 * reminder moves too: it comes when the business time used before the pause plus the time since the answer reaches the
 * reminder share. A task moved to its holder after the reminder point (a delegation or a new position holder) is not
 * reminded for a moment it never held. escalateAt always follows dueAt by the version's escalation time (BR-SLA-02), so
 * a due time counted again after a question moves the escalation with it.
 */
export function slaTimes(task: SlaTaskState, policy: SlaPolicy, calendar: BusinessCalendar): SlaTimes {
  const dueAt = task.dueAt ?? addBusinessMinutes(task.assignedAt, task.slaMinutes, calendar)
  const remindMinutes = remindMinutesOf(task.slaMinutes, policy.remindShare)
  let remindAt: Date | null
  if (task.lastResumedAt) {
    const used = Math.max(0, task.slaMinutes - businessMinutesBetween(task.lastResumedAt, dueAt, calendar))
    remindAt = used < remindMinutes ? addBusinessMinutes(task.lastResumedAt, remindMinutes - used, calendar) : null
  } else {
    remindAt = task.remindAt ?? addBusinessMinutes(task.assignedAt, remindMinutes, calendar)
  }
  if (task.reminded || (remindAt && (remindAt.getTime() < task.assignedAt.getTime() || remindAt.getTime() >= dueAt.getTime()))) remindAt = null
  return { remindAt, dueAt, escalateAt: addBusinessMinutes(dueAt, policy.escalateAfterMinutes, calendar) }
}
