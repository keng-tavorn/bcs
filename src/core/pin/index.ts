import { MS_PER_MINUTE } from '../money/constants'
import { COMMON_PINS } from './common'

// The transaction PIN (spec FR-AUTH-005, BR-TOK-05, BR-DOA-15): which PINs a member may choose, when five wrong PINs
// lock it, and which decisions need a step-up. Pure: no I/O and no clock; the caller passes `now`.

export { COMMON_PINS, COMMON_PIN_GROUPS } from './common'

/** A PIN is exactly six ASCII digits (FR-AUTH-005 AC1) */
export const PIN_LENGTH = 6
const PIN_PATTERN = /^[0-9]{6}$/

/** Why a PIN may not be chosen: not six digits, one digit six times, a run, or a common choice */
export type PinProblem = 'FORMAT' | 'ALL_SAME' | 'SEQUENCE' | 'COMMON'

/** Six ASCII digits, nothing else (no spaces, no other scripts' digits) */
export function isPinFormat(value: string): boolean {
  return PIN_PATTERN.test(value)
}

/** Each digit `step` (1 or -1) from the one before, counting 9 → 0 and 0 → 9 as a step (the top row of a keyboard) */
function isRun(digits: readonly number[], step: 1 | -1): boolean {
  return digits.every((d, i) => i === 0 || (digits[i - 1]! + step + 10) % 10 === d)
}

/**
 * FR-AUTH-005 AC1: why this PIN may not be chosen, or null when it may. Refused: anything but six digits (FORMAT), one
 * digit six times such as 000000 (ALL_SAME), digits going up or down by one such as 123456, 654321 or 890123
 * (SEQUENCE), and the common choices of ./common.ts such as 121212 or 147258 (COMMON). The answer never repeats the PIN.
 */
export function pinProblem(pin: string): PinProblem | null {
  if (!isPinFormat(pin)) return 'FORMAT'
  const digits = [...pin].map(Number)
  if (digits.every((d) => d === digits[0])) return 'ALL_SAME'
  if (isRun(digits, 1) || isRun(digits, -1)) return 'SEQUENCE'
  if (COMMON_PINS.has(pin)) return 'COMMON'
  return null
}

// ---------- wrong PINs (FR-AUTH-005 AC3) ----------

/** Wrong PINs in a row that lock the PIN */
export const PIN_FAILURE_LIMIT = 5
/** How long the lock lasts */
export const PIN_LOCK_MINUTES = 15

/** The PIN is locked at `now`; the lock ends at lockedUntil exactly */
export function isPinLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime()
}

export interface WrongPinOutcome {
  /** Wrong PINs in a row after this one; 0 once it locked, so the member has five tries again after the lock */
  readonly failedCount: number
  /** Set when this wrong PIN locked the PIN */
  readonly lockedUntil: Date | null
  readonly locked: boolean
}

/** When a lock that starts at `now` ends: 15 minutes later */
export function pinLockEndsAt(now: Date): Date {
  return new Date(now.getTime() + PIN_LOCK_MINUTES * MS_PER_MINUTE)
}

/**
 * After a wrong PIN: one more failure in a row (a correct PIN starts the count again). The fifth in a row locks the PIN
 * for 15 minutes from `now` and starts the count again.
 */
export function afterWrongPin(failedCountBefore: number, now: Date): WrongPinOutcome {
  const failed = Math.max(0, Math.trunc(failedCountBefore)) + 1
  if (failed < PIN_FAILURE_LIMIT) return { failedCount: failed, lockedUntil: null, locked: false }
  return { failedCount: 0, lockedUntil: pinLockEndsAt(now), locked: true }
}

/** Wrong PINs still allowed before the lock */
export function pinAttemptsLeft(failedCount: number): number {
  return Math.max(0, PIN_FAILURE_LIMIT - Math.max(0, Math.trunc(failedCount)))
}

// ---------- which decisions need a step-up (FR-AUTH-005 AC2) ----------

/** BR-DOA-15: every decision on these subjects needs a step-up, whatever the amount (an initial package is a DOA version) */
export const ALWAYS_STEP_UP_SUBJECTS: readonly string[] = ['DOA_VERSION', 'ORG_AUTHORITY_CHANGE']

/** What the rule reads from an approval route and its DOA version */
export interface StepUpRoute {
  readonly subjectType: string
  /** The amount the DOA counted (the version's amountBasis), in satang; null for a subject without one */
  readonly amountSatang: bigint | null
  /** The version's stepUpThreshold in satang; null when the version sets none */
  readonly stepUpThresholdSatang: bigint | null
}

/**
 * FR-AUTH-005 AC2, BR-TOK-05, BR-DOA-15: deciding a task of this route needs a step-up — always for a DOA version or an
 * authority change, otherwise when the amount the DOA counted is at or above the version's stepUpThreshold. The
 * threshold comes from the DOA version (the customer's figure, OQ-07), never from code (P-2).
 */
export function stepUpNeeded(route: StepUpRoute): boolean {
  if (ALWAYS_STEP_UP_SUBJECTS.includes(route.subjectType)) return true
  return route.amountSatang !== null && route.stepUpThresholdSatang !== null && route.amountSatang >= route.stepUpThresholdSatang
}
