import type { AppError } from '@/core/result'

// What the decision of a reviewer's task, sent from its LIFF page, answers the form (S11-06 · FR-RSK-202 AC4 · BR-RSK-08):
// the refusal of riskReview.decide (src/server/services/risk/reviews.ts) turned into the member's words of
// liffRisk.review.errors there and then by the server action (./actions.ts), so the phone's script carries no message
// catalogue: the form only places the words — at the reason, or by the button — and loads the page again when the task
// was decided, moved or closed meanwhile. Never the error's developer message (NFR-SEC-09). Pure, apart from the
// translator and the time format the action hands it.

export interface LiffRiskDecisionInput {
  readonly taskId: string
  readonly decision: 'PASS' | 'RETURN'
  /** A return's reason: what is missing or wrong */
  readonly reason?: string
  /** The reviewer allows the reason's words to reach the supplier (BR-RSK-08) */
  readonly shareWithSupplier?: boolean
}

export type LiffRiskResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      /** reason — at the reason's field · closed — decided, moved or closed meanwhile: the page shows it as it is now · form — by the button */
      readonly at: 'reason' | 'closed' | 'form'
      readonly text: string
      /** No session any more: nothing was sent, and the page is loaded again */
      readonly signedOut?: true
    }

export type LiffRiskFailure = Extract<LiffRiskResult, { ok: false }>

export type LiffRiskErrorKey = 'done' | 'closed' | 'sod' | 'notYours' | 'reason' | 'moduleOff' | 'signedOut' | 'other'

export interface LiffRiskWords {
  /** The member's language: an English page names who decided by their English name when they have one */
  readonly locale: 'th' | 'en'
  /** liffRisk.review.errors.<key> with its values */
  readonly error: (key: LiffRiskErrorKey, values: { name: string; time: string }) => string
  /** An ISO time as the page shows times */
  readonly time: (iso: string) => string
}

/** The refusal of riskReview.decide, where the LIFF form says it */
export function liffRiskResultOf(error: AppError, words: LiffRiskWords): LiffRiskFailure {
  const details = (error.details ?? {}) as Record<string, unknown>
  const say = (key: LiffRiskErrorKey, values: { name: string; time: string } = { name: '-', time: '-' }) => words.error(key, values)
  switch (error.code) {
    case 'INVALID_STATE_TRANSITION': {
      // Who decided this task and when, when it was decided; otherwise it was cancelled or the round is over
      const name = words.locale === 'en' && typeof details.nameEn === 'string' ? details.nameEn : typeof details.name === 'string' ? details.name : null
      const time = typeof details.time === 'string' && !Number.isNaN(Date.parse(details.time)) ? details.time : null
      return { ok: false, at: 'closed', text: name && time ? say('done', { name, time: words.time(time) }) : say('closed') }
    }
    case 'SOD_VIOLATION':
      return { ok: false, at: 'form', text: say('sod') }
    // Moved to someone else or gone since the page was drawn: the page, loaded again, shows it as it is now
    case 'FORBIDDEN':
    case 'NOT_FOUND':
      return { ok: false, at: 'closed', text: say('notYours') }
    case 'VALIDATION_FAILED':
      return details.field === 'reason' ? { ok: false, at: 'reason', text: say('reason') } : { ok: false, at: 'form', text: say('other') }
    case 'MODULE_DISABLED':
      return { ok: false, at: 'form', text: say('moduleOff') }
    case 'UNAUTHENTICATED':
      return { ok: false, at: 'form', text: say('signedOut'), signedOut: true }
    default:
      return { ok: false, at: 'form', text: say('other') }
  }
}
