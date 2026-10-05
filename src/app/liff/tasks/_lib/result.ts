import { CLOSED_TASK_KEYS, PIN_FIELD_KEYS, taskErrorKey, type ActionOutcome, type TaskErrorKey } from '@/ui/tasks/outcome'
import type { LiffTaskResult } from '@/ui/liff/tasks/result'

// The answer of a LIFF decision page's server action (src/ui/liff/tasks/result.ts): the command's outcome, as the web
// decision page reads it (src/ui/tasks/outcome.ts taskErrorKey), in the member's words of tasks.errors, placed where the
// LIFF form shows it. Pure, apart from the translator and the time format the action hands it, so a unit test reads it
// with the real messages (tests/unit/liff-tasks-result.test.ts).

/** The two refusals of the boundary table's tick (FR-DOA-009 AC3), apart from the keys of taskErrorKey */
export type BoundaryErrorKey = 'BOUNDARY_NOT_CONFIRMED' | 'BOUNDARY_TABLE_CHANGED'

export interface ResultWords {
  /** tasks.errors.<key> with its values */
  readonly error: (key: TaskErrorKey | BoundaryErrorKey, values: { name: string; time: string; rule: string; requestId: string; attemptsLeft: number }) => string
  /** An ISO time as the page shows times (src/ui/format.ts formatDateTime in the member's language) */
  readonly time: (iso: string) => string
}

export function liffTaskResult(outcome: ActionOutcome, words: ResultWords): LiffTaskResult {
  if (outcome.ok) return { ok: true }
  const values = {
    name: outcome.name ?? '-',
    time: outcome.time ? words.time(outcome.time) : '-',
    rule: outcome.rule ?? '-',
    requestId: outcome.requestId ?? '-',
    attemptsLeft: outcome.attemptsLeft ?? 0,
  }
  // A DOA version approved without the tick of its boundary table, or with a tick of a table no longer compared
  if (outcome.code === 'VALIDATION_FAILED' && outcome.reason === 'BOUNDARY_NOT_CONFIRMED') return { ok: false, at: 'tick', text: words.error('BOUNDARY_NOT_CONFIRMED', values) }
  if (outcome.code === 'VALIDATION_FAILED' && outcome.reason === 'BOUNDARY_TABLE_CHANGED') return { ok: false, at: 'form', text: words.error('BOUNDARY_TABLE_CHANGED', values), untick: true }
  const key = taskErrorKey(outcome)
  const text = words.error(key, values)
  if (PIN_FIELD_KEYS.includes(key)) return { ok: false, at: 'pin', text }
  if (CLOSED_TASK_KEYS.includes(key)) return { ok: false, at: 'closed', text }
  if (key === 'PIN_NOT_SET') return { ok: false, at: 'form', text, pinNotSet: true }
  if (key === 'UNAUTHENTICATED') return { ok: false, at: 'form', text, signedOut: true }
  return { ok: false, at: 'form', text }
}
