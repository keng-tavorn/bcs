// What a server action of the tier-2 invoice list, inbox and upload screens returns to its form (spec §14.2, §9.9 rule
// 7): success with what the screen needs next, or the error code with the parts of `details` the screen needs to say
// what happened and how to fix it — never the raw message. NO_ANSWER is the form's own code when the call threw.

export type ApFailure = {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
}

export type ApDraftOutcome = { readonly ok: true; readonly invoiceId: string } | ApFailure
export type ApFileOutcome = { readonly ok: true; readonly fileId: string } | ApFailure
export type ApDoneOutcome = { readonly ok: true } | ApFailure
export type ApPollOutcome =
  | {
      readonly ok: true
      /** false: the organization has no inbox address yet, or the inbox reader is switched off */
      readonly configured: boolean
      readonly received: number
      readonly drafts: number
      readonly failed: number
    }
  | ApFailure

export const AP_NO_ANSWER: ApFailure = { ok: false, code: 'NO_ANSWER' }

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** Picks the screen-safe parts of a service error */
export function toApFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): ApFailure {
  const d = error.details ?? {}
  const reason = text(d.reason)
  const field = text(d.field)
  return { ok: false, code: error.code, ...(reason ? { reason } : {}), ...(field ? { field } : {}) }
}
