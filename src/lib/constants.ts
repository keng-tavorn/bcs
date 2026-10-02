// Technical (non-money) constants ≥ 1000 live here — the only src/lib file exempt from bcs/no-money-literal.
// Never put approval limits, budget amounts or any other money value in this file (spec P-2).

export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60 * MS_PER_SECOND

/** Outbox rows older than this are re-sent by the outbox-sweeper job (spec §4.3 step 5). */
export const OUTBOX_SWEEP_AFTER_MS = 30 * MS_PER_SECOND

/** Interactive transaction limits for runCommand (Prisma). */
export const COMMAND_TX_MAX_WAIT_MS = 10 * MS_PER_SECOND
export const COMMAND_TX_TIMEOUT_MS = 20 * MS_PER_SECOND

/** Transaction errors that are safe to retry (spec §4.3 step 6): Prisma write conflict, Postgres
 *  serialization_failure and deadlock_detected. */
export const RETRYABLE_TX_ERROR_CODES: ReadonlySet<string> = new Set(['P2034', '40001', '40P01'])
