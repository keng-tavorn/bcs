import { MS_PER_DAY } from '../money/constants'
import { parseQuantity } from '../money/math'
import { lineKey, type KeyedLine } from './line-key'

// Duplicate requests and split purchases (spec §7.17, BR-DUP-02 to BR-DUP-04 · ADR-107 · OQ-103). Pure: the caller gives
// the request being sent, the other requests of the organization and the rule the DOA version in effect gives an amount
// on its basis. A flag never blocks and never changes the route (BR-DUP-05); a DUPLICATE asks the requester for a reason.

export const DUPLICATE_STATUSES = ['PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'PARTIALLY_ORDERED', 'ORDERED', 'COMPLETED'] as const

export interface DupLine extends KeyedLine {
  /** Decimal text */
  readonly quantity: string
}

export interface DupCandidate {
  readonly id: string
  readonly requesterMemberId: string
  readonly chargedDepartmentId: string
  readonly suggestedSupplierId: string | null
  /** On the basis of the DOA version in effect (GROSS or NET) */
  readonly basisAmountSatang: bigint
  readonly lines: readonly DupLine[]
}

export interface DupRecent extends DupCandidate {
  readonly status: string
  readonly submittedAt: Date
}

export type RequestFlagResult =
  | { readonly kind: 'DUPLICATE'; readonly matchedRequestIds: readonly string[] }
  | {
      readonly kind: 'SPLIT'
      readonly matchedRequestIds: readonly string[]
      readonly combinedSatang: bigint
      readonly individualRule: string | null
      readonly combinedRule: string | null
    }

export interface DupSettings {
  readonly at: Date
  readonly windowDays: number
  /** The PURCHASE_REQUEST rule of the DOA version in effect for an amount on its basis; null when none or ambiguous */
  readonly ruleFor: (basisAmountSatang: bigint) => string | null
}

const keysOf = (r: DupCandidate) => new Set(r.lines.map((l) => lineKey(l)))
const keyQty = (r: DupCandidate) => new Set(r.lines.map((l) => `${lineKey(l)}#${parseQuantity(l.quantity)}`))

export function checkDuplicates(candidate: DupCandidate, others: readonly DupRecent[], settings: DupSettings): RequestFlagResult[] {
  // BR-DUP-02: within windowDays × 24 hours of `at` either way, in a status that counts, and never the request itself
  const window = settings.windowDays * MS_PER_DAY
  const recent = others
    .filter((r) => r.id !== candidate.id && (DUPLICATE_STATUSES as readonly string[]).includes(r.status) && Math.abs(r.submittedAt.getTime() - settings.at.getTime()) <= window)
    .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime() || (a.id < b.id ? -1 : 1))
  const flags: RequestFlagResult[] = []
  // BR-DUP-03: the same requester, and a line of the same key and quantity
  const mine = keyQty(candidate)
  const duplicates = recent.filter((r) => r.requesterMemberId === candidate.requesterMemberId && [...keyQty(r)].some((k) => mine.has(k)))
  if (duplicates.length) flags.push({ kind: 'DUPLICATE', matchedRequestIds: duplicates.map((r) => r.id) })
  // BR-DUP-04: the same paying department, and the same suggested supplier or a line key in common; together they reach
  // a higher rule than the largest of them alone
  const keys = keysOf(candidate)
  const split = recent.filter(
    (r) =>
      r.chargedDepartmentId === candidate.chargedDepartmentId &&
      ((candidate.suggestedSupplierId !== null && r.suggestedSupplierId === candidate.suggestedSupplierId) || [...keysOf(r)].some((k) => keys.has(k))),
  )
  if (split.length) {
    const combinedSatang = split.reduce((sum, r) => sum + r.basisAmountSatang, candidate.basisAmountSatang)
    const largest = split.reduce((max, r) => (r.basisAmountSatang > max ? r.basisAmountSatang : max), candidate.basisAmountSatang)
    const individualRule = settings.ruleFor(largest)
    const combinedRule = settings.ruleFor(combinedSatang)
    if (combinedRule !== null && combinedRule !== individualRule) flags.push({ kind: 'SPLIT', matchedRequestIds: split.map((r) => r.id), combinedSatang, individualRule, combinedRule })
  }
  return flags
}
