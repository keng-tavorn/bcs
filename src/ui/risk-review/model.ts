import type { BadgeLook, StepBadgeKey } from '../document/badge-looks'

// The shapes the reviewer's pages of a supplier risk assessment pass between their server actions and their client
// parts (S11-06 · FR-RSK-202 AC3 AC4 · BR-RSK-08): plain data, no import of the server. A refusal comes back as its code
// and the screen-safe details only — who decided the task first and when, the field a return is missing — never the
// service's message (§14.2).

export type ReviewTaskStatus = 'OPEN' | 'PASSED' | 'RETURNED' | 'CANCELLED'
export type ReviewDecisionUi = 'PASS' | 'RETURN'
/** Where the assessment stands after the decision: still with other slots, every slot passed, or sent back */
export type ReviewAssessmentAfter = 'IN_REVIEW' | 'COMPLETED' | 'RETURNED'

/** What the decision panel sends: a return needs a reason; only a return may share it with the supplier (BR-RSK-08) */
export interface ReviewDecisionInput {
  readonly decision: ReviewDecisionUi
  readonly reason?: string
  readonly shareWithSupplier?: boolean
}

export type ReviewOutcome =
  | { readonly ok: true; readonly decision: ReviewDecisionUi; readonly assessment: ReviewAssessmentAfter }
  | {
      readonly ok: false
      readonly code: string
      /** VALIDATION_FAILED: the field the service refused (reason: a return without one) */
      readonly field?: string
      /** INVALID_STATE_TRANSITION: who decided the task first and when (ISO time) */
      readonly name?: string
      readonly nameEn?: string
      readonly time?: string
    }

/** The words of a refusal under riskReview.errors; anything the screen does not know reads as FAILED (§9.9 rule 7) */
export type ReviewFailureKey =
  | 'FAILED'
  | 'NO_ANSWER'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'MODULE_DISABLED'
  | 'SOD_VIOLATION'
  | 'INVALID_STATE_TRANSITION'
  | 'DECIDED_BY'
  | 'REASON'
  | 'VALIDATION_FAILED'
  | 'CONFLICT_VERSION'

const KNOWN: readonly string[] = ['NO_ANSWER', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'MODULE_DISABLED', 'SOD_VIOLATION', 'CONFLICT_VERSION', 'VALIDATION_FAILED', 'INVALID_STATE_TRANSITION']

export function reviewFailureKey(o: Extract<ReviewOutcome, { ok: false }>): ReviewFailureKey {
  if (o.code === 'INVALID_STATE_TRANSITION' && o.name) return 'DECIDED_BY'
  if (o.code === 'VALIDATION_FAILED' && o.field === 'reason') return 'REASON'
  return KNOWN.includes(o.code) ? (o.code as ReviewFailureKey) : 'FAILED'
}

/** The task was decided or closed while the page was open: the page reloads to show it as it is now */
export const reviewClosed = (o: ReviewOutcome): boolean => !o.ok && o.code === 'INVALID_STATE_TRANSITION'

/**
 * An open task's due state as the step badge of §9.10 (งานอนุมัติ): waiting, warn once half of its time is used, danger
 * past dueAt. `now` comes from the page's context (the clock of the request), never from the component.
 */
export function reviewDueState(now: Date, assignedAt: Date, dueAt: Date): Extract<StepBadgeKey, 'OPEN' | 'OPEN_HALF' | 'OVERDUE'> {
  if (now.getTime() >= dueAt.getTime()) return 'OVERDUE'
  const whole = dueAt.getTime() - assignedAt.getTime()
  return whole > 0 && (now.getTime() - assignedAt.getTime()) * 2 >= whole ? 'OPEN_HALF' : 'OPEN'
}

/** A decided task's badge: passed, returned or cancelled, with its icon and word (NFR-A11Y-03) */
export const REVIEW_TASK_BADGES: Readonly<Record<Exclude<ReviewTaskStatus, 'OPEN'>, BadgeLook>> = {
  PASSED: { tone: 'ok', icon: 'CircleCheck' },
  RETURNED: { tone: 'warn', icon: 'Undo2' },
  CANCELLED: { tone: 'neutral', icon: 'Ban' },
}

/** The badge of another slot's state on the task page (BR-RSK-08: its state only) */
export const SLOT_BADGES: Readonly<Record<ReviewTaskStatus, BadgeLook>> = {
  OPEN: { tone: 'neutral', icon: 'Hourglass' },
  ...REVIEW_TASK_BADGES,
}

/** The domains a slot reviews as its words name them: a slot with none reviews the general part only */
export const slotDomains = <D extends string>(riskDomains: readonly D[]): readonly (D | 'GENERAL')[] => (riskDomains.length ? riskDomains : ['GENERAL'])
