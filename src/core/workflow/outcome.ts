import { err, ok, type Result } from '@/core/result'

// stepOutcome (spec §7.17 BR-WF-01, BR-WF-09): what a step of several slots comes to after a decision. A slot's result
// is the first decision of the slot (the server finds it); this only counts slots. Pure.
//   - a group: any RETURN → RETURNED at once · ALL: every slot APPROVE → APPROVED, any REJECT → REJECTED · ANY: the
//     first slot decided is the result · COUNT n: APPROVE ≥ n → APPROVED, REJECT > (slots − n) → REJECTED · else OPEN
//   - an APPROVAL step is one group of all its slots · a REVIEW step has groups (BR-WF-06): RETURNED when a group is,
//     APPROVED when every group is, else OPEN; a reviewer never rejects (REVIEW_CANNOT_REJECT)
//   - cancel: the open slots to close now. A group that is APPROVED closes its open slots that are in no group still
//     waiting; a step with a result closes every open slot.

export type SlotDecision = 'APPROVE' | 'REJECT' | 'RETURN'
export type Quorum = 'ALL' | 'ANY' | 'COUNT'
export type Outcome = 'OPEN' | 'APPROVED' | 'REJECTED' | 'RETURNED'

export interface SlotGroup {
  readonly quorum: Quorum
  /** COUNT only */
  readonly quorumCount?: number | null
  /** 1-based slot numbers of the step */
  readonly slots: readonly number[]
}

export interface StepOutcomeInput {
  readonly kind?: 'APPROVAL' | 'REVIEW'
  /** APPROVAL: the step's own quorum over all its slots */
  readonly quorum?: Quorum
  readonly quorumCount?: number | null
  /** REVIEW: the groups of the step */
  readonly groups?: readonly SlotGroup[]
  /** The result of each slot in slot order (slot 1 first); null = not decided yet */
  readonly slots: readonly (SlotDecision | null)[]
}

export interface StepOutcomeResult {
  readonly outcome: Outcome
  /** Slot numbers whose open tasks are cancelled now, ascending */
  readonly cancel: readonly number[]
}

function groupOutcome(group: SlotGroup, slots: readonly (SlotDecision | null)[]): Outcome {
  const decisions = group.slots.map((n) => slots[n - 1] ?? null)
  if (decisions.includes('RETURN')) return 'RETURNED'
  const approves = decisions.filter((d) => d === 'APPROVE').length
  const rejects = decisions.filter((d) => d === 'REJECT').length
  switch (group.quorum) {
    case 'ALL':
      if (rejects > 0) return 'REJECTED'
      return approves === decisions.length ? 'APPROVED' : 'OPEN'
    case 'ANY': {
      const first = decisions.find((d) => d !== null)
      return first === undefined ? 'OPEN' : first === 'APPROVE' ? 'APPROVED' : 'REJECTED'
    }
    case 'COUNT': {
      const need = group.quorumCount ?? decisions.length
      if (approves >= need) return 'APPROVED'
      return rejects > decisions.length - need ? 'REJECTED' : 'OPEN'
    }
  }
}

const openSlots = (slots: readonly (SlotDecision | null)[]) => slots.flatMap((d, i) => (d === null ? [i + 1] : []))

export function stepOutcome(input: StepOutcomeInput): Result<StepOutcomeResult> {
  const { slots } = input
  if (input.kind === 'REVIEW') {
    if (slots.includes('REJECT')) return err('VALIDATION_FAILED', 'a reviewer passes, returns or asks; never rejects', { reason: 'REVIEW_CANNOT_REJECT' })
    const groups = input.groups ?? []
    const outcomes = groups.map((g) => groupOutcome(g, slots))
    if (outcomes.includes('RETURNED')) return ok({ outcome: 'RETURNED', cancel: openSlots(slots) })
    if (outcomes.every((o) => o === 'APPROVED')) return ok({ outcome: 'APPROVED', cancel: openSlots(slots) })
    const waiting = new Set(groups.filter((_, i) => outcomes[i] !== 'APPROVED').flatMap((g) => g.slots))
    const decided = new Set(groups.filter((_, i) => outcomes[i] === 'APPROVED').flatMap((g) => g.slots))
    return ok({ outcome: 'OPEN', cancel: openSlots(slots).filter((n) => decided.has(n) && !waiting.has(n)) })
  }
  const all = slots.map((_, i) => i + 1)
  const outcome = groupOutcome({ quorum: input.quorum ?? 'ALL', quorumCount: input.quorumCount ?? null, slots: all }, slots)
  return ok({ outcome, cancel: outcome === 'OPEN' ? [] : openSlots(slots) })
}
