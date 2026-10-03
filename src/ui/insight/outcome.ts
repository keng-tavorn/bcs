// What the insight screens' actions and export routes answer (spec §14.2, §9.9 rule 7): success, or the error code
// with the parts of `details` the screen needs to say what happened and how to fix it — never the raw message.

export type InsightFailure = {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** RATE_LIMITED reminder: when the document may be reminded again (ISO) */
  readonly nextAt?: string
  /** VALIDATION_FAILED of an export that is too big: the most rows a file holds */
  readonly max?: number
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
}

export type RemindOutcome = { readonly ok: true; readonly at: string; readonly nextAt: string } | InsightFailure
export type ScheduleOutcome = { readonly ok: true } | InsightFailure
export type ExportOutcome = { readonly ok: true; readonly exportJobId: string; readonly fileId: string; readonly rowCount: number; readonly checksum: string } | InsightFailure

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** Picks the screen-safe parts of a service error. */
export function toInsightFailure(error: { code: string; details?: Record<string, unknown> }): InsightFailure {
  const d = error.details ?? {}
  const max = typeof d.max === 'number' ? d.max : undefined
  const pick = { reason: text(d.reason), field: text(d.field), nextAt: text(d.nextAt), requestId: text(d.requestId) }
  return { ok: false, code: error.code, ...Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined)), ...(max !== undefined ? { max } : {}) }
}

// ---------- reminders (board.errors) ----------

export const REMIND_ERROR_KEYS = ['RECENT', 'BUSY', 'STATE', 'NOT_FOUND', 'READ_ONLY', 'FORBIDDEN', 'UNAUTHENTICATED', 'CONFLICT', 'INTERNAL', 'FAILED'] as const
export type RemindErrorKey = (typeof REMIND_ERROR_KEYS)[number]

export function remindErrorKey(failure: InsightFailure): RemindErrorKey {
  switch (failure.code) {
    case 'RATE_LIMITED':
      // the hour's rule says when it may go again; any other RATE_LIMITED is the database being busy (runCommand)
      return failure.reason === 'REMINDED_WITHIN_HOUR' ? 'RECENT' : 'BUSY'
    case 'INVALID_STATE_TRANSITION':
      return 'STATE'
    case 'FORBIDDEN':
      return failure.reason === 'READ_ONLY' ? 'READ_ONLY' : 'FORBIDDEN'
    case 'NOT_FOUND':
    case 'UNAUTHENTICATED':
    case 'INTERNAL':
      return failure.code
    case 'IDEMPOTENCY_CONFLICT':
      return 'CONFLICT'
    default:
      return 'FAILED'
  }
}

// ---------- exports (audit.export, reports.export) ----------

export const EXPORT_ERROR_KEYS = ['TOO_MANY', 'FILTER', 'FORBIDDEN', 'UNAUTHENTICATED', 'BUSY', 'CONFLICT', 'INTERNAL', 'FAILED'] as const
export type ExportErrorKey = (typeof EXPORT_ERROR_KEYS)[number]

export function exportErrorKey(failure: InsightFailure): ExportErrorKey {
  if (failure.code === 'VALIDATION_FAILED') return failure.reason === 'TOO_MANY_ROWS' ? 'TOO_MANY' : 'FILTER'
  if (failure.code === 'FORBIDDEN' || failure.code === 'UNAUTHENTICATED' || failure.code === 'INTERNAL') return failure.code
  if (failure.code === 'RATE_LIMITED') return 'BUSY'
  if (failure.code === 'IDEMPOTENCY_CONFLICT') return 'CONFLICT'
  return 'FAILED'
}

// ---------- schedules (reports.schedule.errors) ----------

export const SCHEDULE_ERROR_KEYS = ['RECIPIENTS', 'RECIPIENT_SCOPE', 'CADENCE', 'REPORT', 'FORBIDDEN', 'UNAUTHENTICATED', 'CONFLICT', 'BUSY', 'INTERNAL', 'FAILED'] as const
export type ScheduleErrorKey = (typeof SCHEDULE_ERROR_KEYS)[number]

export function scheduleErrorKey(failure: InsightFailure): ScheduleErrorKey {
  if (failure.code === 'VALIDATION_FAILED') {
    // a recipient who may not read the report themselves (FR-VIS-002 AC3), e.g. their role was taken away meanwhile
    if (failure.reason === 'RECIPIENT_SCOPE') return 'RECIPIENT_SCOPE'
    if (failure.field === 'recipientMemberIds' || failure.reason === 'RECIPIENT') return 'RECIPIENTS'
    if (failure.field === 'cron' || failure.field === 'cadence' || failure.reason === 'CRON') return 'CADENCE'
    if (failure.field === 'reportCode' || failure.reason === 'REPORT') return 'REPORT'
    return 'FAILED'
  }
  if (failure.code === 'FORBIDDEN' || failure.code === 'UNAUTHENTICATED' || failure.code === 'INTERNAL') return failure.code
  if (failure.code === 'IDEMPOTENCY_CONFLICT') return 'CONFLICT'
  if (failure.code === 'RATE_LIMITED') return 'BUSY'
  return 'FAILED'
}
