import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'

// The DOA editor's table as data (FR-DOA-001 AC1): rules per document type with their amount band, approver and time
// under the SLA, edited one row at a time. Money is satang text throughout (never a float, §17.3) and is typed and shown
// in baht with thousands separators and two decimals. Bands of one document type join: moving a band's upper end moves
// the lower end of the band that started there (and the other way round), so a table without gaps stays without gaps.
// The server checks everything again (src/server/services/doa/editor.ts); this only keeps the screen honest. Pure.

/** DOA_DOCUMENT_TYPES of src/core/doa in the same order (screens may not import it; tests/unit/admin-doa-editor.test.tsx compares) */
export const DOC_TYPES = [
  'PURCHASE_REQUEST',
  'PURCHASE_ORDER',
  'GR_VARIANCE',
  'DOA_CHANGE',
  'ORG_AUTHORITY_CHANGE',
  'BUDGET_TRANSFER',
  'OVER_BUDGET',
  'INVOICE_EXCEPTION',
  'PO_CHANGE',
  'PAYMENT_RUN',
  'BANK_ACCOUNT_CHANGE',
] as const
export type DocType = (typeof DOC_TYPES)[number]
/** Policy changes (BR-DOA-08 (จ)) and types without an amount (BR-DOA-22) have no band: their rules hold for any document.
 * NO_AMOUNT_DOCUMENT_TYPES of src/core/doa */
export const NO_AMOUNT_TYPES: readonly DocType[] = ['DOA_CHANGE', 'ORG_AUTHORITY_CHANGE', 'BANK_ACCOUNT_CHANGE']

export type ApproverValue = { readonly kind: 'POSITION_OF_DEPARTMENT' | 'POSITION_OF_ORG'; readonly position: string } | { readonly kind: 'MEMBER'; readonly memberId: string }

export interface Band {
  readonly lowerKind: 'gt' | 'gte'
  /** satang text; null = from zero */
  readonly lower: string | null
  /** satang text; null = no limit */
  readonly upper: string | null
}

export const QUORUMS = ['MAJORITY', 'ALL', 'ANY', 'COUNT'] as const
export type Quorum = (typeof QUORUMS)[number]

/** A committee (S6 · FR-WF-102): two or more approvers and how many of them must approve (BR-WF-04, BR-WF-05) */
export interface EditorCommittee {
  readonly approvers: readonly ApproverValue[]
  readonly quorum: Quorum
  /** COUNT only */
  readonly quorumCount: number | null
}

/** One step: one approver, or a committee (then `approver` is its first approver) */
export interface EditorStep {
  readonly approver: ApproverValue
  readonly slaMinutes: number
  readonly committee?: EditorCommittee
}

export interface RuleState {
  readonly key: number
  readonly code: string
  readonly documentType: DocType
  /** null = no amount condition */
  readonly band: Band | null
  readonly steps: readonly EditorStep[]
  readonly isNew: boolean
}

/** What one row editor holds while it is open: text as typed */
export interface RowDraft {
  readonly code: string
  readonly lower: string
  readonly upper: string
  /** approverKey of the chosen approver */
  readonly approver: string
  readonly slaHours: string
  /** A committee instead of one approver (FR-WF-102) */
  readonly committee: boolean
  /** approverKey of each committee member, in order */
  readonly members: readonly string[]
  readonly quorum: Quorum
  /** COUNT only, as typed */
  readonly quorumCount: string
}

export type RowField = keyof RowDraft
export type RowError = 'CODE' | 'CODE_TAKEN' | 'MONEY' | 'BAND_ORDER' | 'APPROVER' | 'SLA' | 'MEMBERS' | 'QUORUM_COUNT'

export const MINUTES_PER_HOUR = 60
const CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/
const MONEY = /^\d{1,13}(\.\d{1,2})?$/
const HOURS = /^\d{1,3}$/

export const approverKey = (a: ApproverValue) => (a.kind === 'MEMBER' ? `MEMBER:${a.memberId}` : `${a.kind}:${a.position}`)

/** One step as a comparable key: its approver, or a committee's quorum and members in order */
export const stepKey = (s: EditorStep) => (s.committee ? `PARALLEL:${s.committee.quorum}:${s.committee.quorumCount ?? ''}:${s.committee.approvers.map(approverKey).join('+')}` : approverKey(s.approver))

export function approverFromKey(key: string): ApproverValue | null {
  const at = key.indexOf(':')
  if (at < 0) return null
  const kind = key.slice(0, at)
  const value = key.slice(at + 1)
  if (!value) return null
  if (kind === 'MEMBER') return { kind: 'MEMBER', memberId: value }
  if (kind === 'POSITION_OF_DEPARTMENT' || kind === 'POSITION_OF_ORG') return { kind, position: value }
  return null
}

/** "20,000.5" → "2000050"; empty → null; anything else → undefined */
export function satangFromText(text: string): string | null | undefined {
  const plain = text.replace(/[\s,]/g, '')
  if (plain === '') return null
  return MONEY.test(plain) ? amountToSatang(plain).toString() : undefined
}

/** "2000050" → "20,000.50"; null → empty */
export const textFromSatang = (satang: string | null) => (satang === null ? '' : formatSatang(BigInt(satang)))

/** Whole hours as typed; a time that is not whole hours (never made by a screen or the YAML) shows with two decimals */
export const hoursText = (minutes: number) => (minutes % MINUTES_PER_HOUR === 0 ? String(minutes / MINUTES_PER_HOUR) : (minutes / MINUTES_PER_HOUR).toFixed(2))

export const hasAmount = (documentType: DocType) => !NO_AMOUNT_TYPES.includes(documentType)

export function draftOf(rule: RuleState): RowDraft {
  const step = rule.steps[0]
  const committee = step?.committee
  return {
    code: rule.code,
    lower: rule.band ? textFromSatang(rule.band.lower) : '',
    upper: rule.band ? textFromSatang(rule.band.upper) : '',
    approver: step ? approverKey(step.approver) : '',
    slaHours: step ? hoursText(step.slaMinutes) : '',
    committee: committee !== undefined,
    members: committee ? committee.approvers.map(approverKey) : [],
    quorum: committee?.quorum ?? 'MAJORITY',
    quorumCount: committee?.quorumCount ? String(committee.quorumCount) : '',
  }
}

export function emptyDraft(rules: readonly RuleState[], documentType: DocType): RowDraft {
  // A new band usually starts where the last one ended; its upper end is left for the user to set
  const last = [...rules].reverse().find((r) => r.documentType === documentType && r.band && r.band.upper !== null)
  const sla = rules.find((r) => r.documentType === documentType)?.steps[0]?.slaMinutes
  return {
    code: '',
    lower: hasAmount(documentType) && last?.band ? textFromSatang(last.band.upper) : '',
    upper: '',
    approver: '',
    slaHours: sla ? hoursText(sla) : '',
    committee: false,
    members: [],
    quorum: 'MAJORITY',
    quorumCount: '',
  }
}

export interface FollowNote {
  readonly code: string
  /** The end that moved, and where to */
  readonly end: 'lower' | 'upper'
  readonly to: string
}

export type ApplyResult =
  | { readonly ok: true; readonly rules: RuleState[]; readonly followed: readonly FollowNote[]; readonly notFollowed: readonly string[] }
  | { readonly ok: false; readonly errors: Partial<Record<RowField, RowError>> }

const lessOrEqual = (kind: Band['lowerKind'], lower: bigint, upper: bigint) => (kind === 'gt' ? lower < upper : lower <= upper)
/** A band whose ends are both set must not end before it starts */
const validBand = (b: Band) => b.lower === null || b.upper === null || lessOrEqual(b.lowerKind, BigInt(b.lower), BigInt(b.upper))
/** The exclusive lower end the band really starts after (gte X starts after X − 1 satang) */
const startsAfter = (b: Band) => (b.lower === null ? null : b.lowerKind === 'gt' ? BigInt(b.lower) : BigInt(b.lower) - 1n)

/**
 * Saves the open row into the table (key 'new' adds one), or says what is wrong with each field. The edited band's
 * neighbours follow its ends when they joined before; a neighbour whose band would turn round is left as it was and
 * named in notFollowed, for the user to fix.
 */
export function applyDraft(
  rules: readonly RuleState[],
  target: { readonly key: number | 'new'; readonly documentType: DocType; readonly newKey: number },
  draft: RowDraft,
): ApplyResult {
  const errors: Partial<Record<RowField, RowError>> = {}
  const before = target.key === 'new' ? null : (rules.find((r) => r.key === target.key) ?? null)
  const code = before && !before.isNew ? before.code : draft.code.trim().toUpperCase()
  if (!before || before.isNew) {
    if (!CODE.test(code)) errors.code = 'CODE'
    else if (rules.some((r) => r.key !== target.key && r.code === code)) errors.code = 'CODE_TAKEN'
  }

  let band: Band | null = null
  if (hasAmount(target.documentType)) {
    const lower = satangFromText(draft.lower)
    const upper = satangFromText(draft.upper)
    if (lower === undefined) errors.lower = 'MONEY'
    if (upper === undefined) errors.upper = 'MONEY'
    if (lower !== undefined && upper !== undefined && (lower !== null || upper !== null)) {
      band = { lowerKind: before?.band?.lowerKind ?? 'gt', lower, upper }
      if (!validBand(band)) errors.upper = 'BAND_ORDER'
    }
  }

  // Rules of more than one step keep their steps (the table edits one approver per rule, tier 1)
  let steps: readonly EditorStep[] = before?.steps ?? []
  if (!before || before.steps.length <= 1) {
    const original = before?.steps[0]
    let minutes: number | null = null
    if (original && draft.slaHours.trim() === hoursText(original.slaMinutes)) minutes = original.slaMinutes
    else if (HOURS.test(draft.slaHours.trim()) && Number(draft.slaHours.trim()) > 0) minutes = Number(draft.slaHours.trim()) * MINUTES_PER_HOUR
    else errors.slaHours = 'SLA'
    if (draft.committee) {
      // A committee of two or more different members (BR-WF-05); COUNT names how many of them, 1..N
      const members = [...new Set(draft.members)].map(approverFromKey).filter((a): a is ApproverValue => a !== null)
      if (members.length < 2) errors.members = 'MEMBERS'
      const count = draft.quorumCount.trim()
      let quorumCount: number | null = null
      if (draft.quorum === 'COUNT') {
        if (/^\d{1,2}$/.test(count) && Number(count) >= 1 && Number(count) <= Math.max(members.length, 1)) quorumCount = Number(count)
        else errors.quorumCount = 'QUORUM_COUNT'
      }
      if (members.length >= 2 && minutes !== null && !errors.quorumCount) steps = [{ approver: members[0]!, slaMinutes: minutes, committee: { approvers: members, quorum: draft.quorum, quorumCount } }]
    } else {
      const approver = approverFromKey(draft.approver)
      if (!approver) errors.approver = 'APPROVER'
      if (approver && minutes !== null) steps = [{ approver, slaMinutes: minutes }]
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors }

  const edited: RuleState = { key: before?.key ?? target.newKey, code, documentType: target.documentType, band, steps, isNew: before?.isNew ?? true }
  let next: RuleState[]
  if (before) next = rules.map((r) => (r.key === before.key ? edited : r))
  else {
    // A new rule goes after the last rule of its document type, so the table keeps its order
    const lastOfType = rules.map((r) => r.documentType).lastIndexOf(target.documentType)
    next = lastOfType < 0 ? [...rules, edited] : [...rules.slice(0, lastOfType + 1), edited, ...rules.slice(lastOfType + 1)]
  }

  const followed: FollowNote[] = []
  const notFollowed: string[] = []
  const oldBand = before?.band ?? null
  if (oldBand && band) {
    const moves: Array<{ match: (b: Band) => boolean; move: (b: Band) => Band; end: FollowNote['end']; to: (b: Band) => string | null }> = []
    // The band that started where this one ended now starts at the new end
    if (oldBand.upper !== null && band.upper !== null && band.upper !== oldBand.upper) {
      const oldUpper = BigInt(oldBand.upper)
      const newUpper = BigInt(band.upper)
      moves.push({
        match: (b) => startsAfter(b) === oldUpper,
        move: (b) => ({ ...b, lower: (b.lowerKind === 'gt' ? newUpper : newUpper + 1n).toString() }),
        end: 'lower',
        to: (b) => b.lower,
      })
    }
    // The band that ended where this one started now ends at the new start
    const oldStart = startsAfter(oldBand)
    const newStart = startsAfter(band)
    if (oldStart !== null && newStart !== null && oldStart !== newStart && oldStart > 0n) {
      moves.push({ match: (b) => b.upper !== null && BigInt(b.upper) === oldStart, move: (b) => ({ ...b, upper: newStart.toString() }), end: 'upper', to: (b) => b.upper })
    }
    for (const m of moves) {
      next = next.map((r) => {
        if (r.key === edited.key || r.documentType !== target.documentType || !r.band || !m.match(r.band)) return r
        const moved = m.move(r.band)
        if (!validBand(moved)) {
          notFollowed.push(r.code)
          return r
        }
        followed.push({ code: r.code, end: m.end, to: m.to(moved) ?? '' })
        return { ...r, band: moved }
      })
    }
  }
  return { ok: true, rules: next, followed, notFollowed }
}

export function removeRule(rules: readonly RuleState[], key: number): RuleState[] {
  return rules.filter((r) => r.key !== key)
}

/** Puts a removed rule back where it stood (the undo of removeRule); the table as it is when the rule or its code is there again */
export function restoreRule(rules: readonly RuleState[], rule: RuleState, index: number): RuleState[] {
  if (rules.some((r) => r.key === rule.key || r.code === rule.code)) return [...rules]
  const at = Math.max(0, Math.min(index, rules.length))
  return [...rules.slice(0, at), rule, ...rules.slice(at)]
}

/** What differs between a rule and the source rule of the same code: band, approver, SLA */
export function changedParts(source: RuleState | undefined, rule: RuleState): Array<'band' | 'approver' | 'sla'> {
  if (!source) return []
  const parts: Array<'band' | 'approver' | 'sla'> = []
  const bandKey = (b: Band | null) => (b ? `${startsAfter(b) ?? '-'}:${b.upper ?? '-'}` : 'none')
  if (bandKey(source.band) !== bandKey(rule.band)) parts.push('band')
  if (source.steps.map(stepKey).join('|') !== rule.steps.map(stepKey).join('|')) parts.push('approver')
  if (source.steps.map((s) => s.slaMinutes).join('|') !== rule.steps.map((s) => s.slaMinutes).join('|')) parts.push('sla')
  return parts
}

export interface PolicyState {
  readonly amountBasis: 'GROSS' | 'NET'
  readonly selfApprovalPolicy: 'ESCALATE_NEXT_BAND' | 'BLOCK'
  readonly collapseDuplicateApprovers: boolean
  /** As typed, in baht */
  readonly stepUpThreshold: string
  readonly approverMayReceive: boolean
  readonly requesterMayReceive: boolean
  /** S6-09 (BR-WF-17): only DOA_ADMIN drafts the DOA and the workflow once the version is in effect */
  readonly doaAdminSeparated: boolean
}

export const POLICY_KEYS = ['amountBasis', 'stepUpThreshold', 'approverMayReceive', 'requesterMayReceive', 'selfApprovalPolicy', 'collapseDuplicateApprovers', 'doaAdminSeparated'] as const
export type PolicyKey = (typeof POLICY_KEYS)[number]

/** Policies whose value differs from the source's (the step-up amount compared in satang) */
export function changedPolicies(source: PolicyState, policy: PolicyState): PolicyKey[] {
  return POLICY_KEYS.filter((k) => (k === 'stepUpThreshold' ? satangFromText(source[k]) !== satangFromText(policy[k]) : source[k] !== policy[k]))
}

/** What the server action takes (src/server/services/doa/editor.ts DraftCopyInput) */
export interface DraftInput {
  sourceVersionId: string
  effectiveDate: string
  changeReason: string
  policy: {
    amountBasis: 'GROSS' | 'NET'
    selfApprovalPolicy: 'ESCALATE_NEXT_BAND' | 'BLOCK'
    collapseDuplicateApprovers: boolean
    stepUpThreshold: string | null
    approverMayReceive: boolean
    requesterMayReceive: boolean
    doaAdminSeparated: boolean
  }
  rules: Array<{
    code: string
    documentType: DocType
    band: { lowerKind: 'gt' | 'gte'; lower: string | null; upper: string | null } | null
    steps: Array<{ approver: ApproverValue; slaMinutes: number; committee?: { approvers: ApproverValue[]; quorum: Quorum; quorumCount: number | null } }>
  }>
}

export function draftInput(sourceVersionId: string, rules: readonly RuleState[], policy: PolicyState, effectiveDate: string, changeReason: string): DraftInput | { readonly error: 'STEP_UP' } {
  const stepUp = satangFromText(policy.stepUpThreshold)
  if (stepUp === undefined) return { error: 'STEP_UP' }
  return {
    sourceVersionId,
    effectiveDate,
    changeReason: changeReason.trim(),
    policy: {
      amountBasis: policy.amountBasis,
      selfApprovalPolicy: policy.selfApprovalPolicy,
      collapseDuplicateApprovers: policy.collapseDuplicateApprovers,
      stepUpThreshold: stepUp,
      approverMayReceive: policy.approverMayReceive,
      requesterMayReceive: policy.requesterMayReceive,
      doaAdminSeparated: policy.doaAdminSeparated,
    },
    rules: rules.map((r) => ({
      code: r.code,
      documentType: r.documentType,
      band: r.band ? { lowerKind: r.band.lowerKind, lower: r.band.lower, upper: r.band.upper } : null,
      steps: r.steps.map((s) => ({
        approver: s.approver,
        slaMinutes: s.slaMinutes,
        ...(s.committee ? { committee: { approvers: [...s.committee.approvers], quorum: s.committee.quorum, quorumCount: s.committee.quorumCount } } : {}),
      })),
    })),
  }
}
