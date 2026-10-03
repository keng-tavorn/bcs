import type { AppError } from '@/core/result'

// What a timer job's step gets back from a handler (spec §4.6). A business answer — done, or refused because the task
// or the delegation is closed, paused, moved, handled already or not due yet — is returned, and the job decides what
// comes next. A busy database (RATE_LIMITED: a lock or statement timeout, no free connection) or an unexpected error
// (INTERNAL) is no answer: the handler throws RetryableStepError, so Inngest retries the step with backoff. Every
// command is idempotent (§4.6 rule 2), so a retry repeats nothing that was done; after the retries the step fails and
// the run shows as failed instead of ending as if the task had been refused.

const TRANSIENT: ReadonlySet<string> = new Set(['RATE_LIMITED', 'INTERNAL'])

export class RetryableStepError extends Error {
  readonly code: string
  /** The command's requestId, to find its log lines; never the error text, which can quote personal data */
  readonly requestId: string | null

  constructor(error: AppError) {
    const requestId = typeof error.details?.requestId === 'string' ? error.details.requestId : null
    super(`${error.code}: the command did not finish, so the step is retried${requestId ? ` (request ${requestId})` : ''}`)
    this.name = 'RetryableStepError'
    this.code = error.code
    this.requestId = requestId
  }
}

/** A busy database or an unexpected error is no answer: throws so that Inngest retries the step */
export function throwIfTransient(error: AppError): void {
  if (TRANSIENT.has(error.code)) throw new RetryableStepError(error)
}

export interface StepRefusal {
  readonly done: false
  readonly code: string
  readonly reason: string | null
  /** NOT_DUE only: when the step is due by the latest state (the calendar can move it after the job planned) */
  readonly notBefore: string | null
  /** NOT_DUE only: milliseconds from the handler's `now` to notBefore; the job waits this long and tries again */
  readonly waitMs: number | null
}

/**
 * A command's refusal as a step result. A transient failure throws instead (see above). A refusal NOT_DUE carries the
 * time it is due in details.at, so a job that woke early — its clock ahead of the application's, or the time moved by a
 * holiday imported meanwhile — waits again instead of ending.
 */
export function refusalOf(error: AppError, now: Date): StepRefusal {
  throwIfTransient(error)
  const reason = typeof error.details?.reason === 'string' ? error.details.reason : null
  const at = reason === 'NOT_DUE' && typeof error.details?.at === 'string' ? new Date(error.details.at) : null
  const due = at !== null && !Number.isNaN(at.getTime()) ? at : null
  return { done: false, code: error.code, reason, notBefore: due?.toISOString() ?? null, waitMs: due ? Math.max(0, due.getTime() - now.getTime()) : null }
}
