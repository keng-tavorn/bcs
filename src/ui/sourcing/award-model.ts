import { AWARD_REASON_CODES, type AwardReasonCode } from '@/core/sourcing/award'

// The shapes the award page (S10-10 · /sourcing/[id]/award) passes between its server actions and its form.

export interface AwardChoice {
  readonly rfxLineId: string
  readonly bidId: string
}

export interface AwardSaveInput {
  /** The award being changed; left out to make the first one */
  readonly awardDecisionId?: string
  readonly version?: number
  readonly lines: readonly AwardChoice[]
  readonly reason: string
  readonly contractRef: string
}

export type AwardOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: string
      /** VALIDATION_FAILED, INVALID_STATE_TRANSITION, SUPPLIER_FLAGGED: the reason the screen can say */
      readonly reason?: string
      /** AWARD_REASON_REQUIRED: every code that calls for the reason */
      readonly reasonCodes?: readonly string[]
    }

/** The keys of sourcing.award the screens pick by value (their messages exist in both languages) */
export const AWARD_STATUS_KEYS = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RETURNED', 'REJECTED', 'CANCELLED', 'NONE'] as const
export type AwardStatusKey = (typeof AWARD_STATUS_KEYS)[number]
/** The reason codes of BR-RFX-12, one list with the engine's */
export const AWARD_REASON_KEYS = AWARD_REASON_CODES
export type AwardReasonKey = AwardReasonCode
export const AWARD_FLAG_KEYS = ['HIGH', 'LOW', 'ABOVE_AGREEMENT'] as const
export type AwardFlagKey = (typeof AWARD_FLAG_KEYS)[number]
export const AWARD_ERROR_KEYS = [
  'MODULE_DISABLED',
  'AWARD_REASON_REQUIRED',
  'AWARD_OPEN',
  'NOT_REVEALED',
  'SUPPLIER_FLAGGED',
  'DOA_NOT_CONFIGURED',
  'APPROVER_NOT_FOUND',
  'NO_HIGHER_AUTHORITY',
  'CONFLICT_VERSION',
  'INVALID_STATE_TRANSITION',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'EMPTY',
  'UNCHANGED',
  'OTHER',
] as const
export type AwardErrorKey = (typeof AWARD_ERROR_KEYS)[number]

export const oneOf = <T extends string>(keys: readonly T[], value: string): value is T => (keys as readonly string[]).includes(value)
/** A status, reason or error code as its message key; an unknown value falls back to `fallback` */
export function keyOf<T extends string>(keys: readonly T[], value: string, fallback: T): T {
  return oneOf(keys, value) ? value : fallback
}
