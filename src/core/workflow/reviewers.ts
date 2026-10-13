import { delegateFor } from '../delegation'
import { resolveRoute, type RoutePolicy } from '../doa'
import { departmentPath, holderAt } from '../doa/approvers'
import type { DelegationSnapshot, OrgSnapshot, RouteInput, RouteResult } from '../doa/types'
import { evaluateCondition, type Condition as FormCondition, type FormInput } from '../forms'
import type { Satang } from '../money/math'
import { err, ok, type Result } from '../result'
import type { Quorum } from './outcome'

// Parallel reviewers (spec §7.17 BR-WF-06 to BR-WF-11, FR-WF-101): the rules of the workflow version in effect that
// match a request make one REVIEW step before the DOA steps. Pure: the version, the organization and the delegations
// are snapshots, the time a parameter.

export type ReviewerSpec = { readonly kind: 'POSITION_AT'; readonly position: string; readonly department: string } | { readonly kind: 'MEMBER'; readonly memberId: string }

/** A condition of §7.9 with the set variables of BR-WF-07 ($lineCategories, $budgetAccountCodes) and the op anyIn */
export type WorkflowCondition =
  | { readonly all: readonly WorkflowCondition[] }
  | { readonly any: readonly WorkflowCondition[] }
  | { readonly field: string; readonly op: string; readonly value?: unknown; readonly money?: boolean }
  /** {} = every request of the rule's types */
  | Record<string, never>

export interface WorkflowRuleSnapshot {
  readonly code: string
  readonly requestTypeCodes: readonly string[]
  readonly when: WorkflowCondition
  /** ALL and ANY name one reviewer, COUNT two or more */
  readonly reviewers: readonly ReviewerSpec[]
  readonly fallback: ReviewerSpec | null
  readonly mode: Quorum
  readonly quorumCount: number | null
  readonly slaBusinessMinutes: number
  readonly sortOrder: number
}

export interface WorkflowVersionSnapshot {
  readonly id: string
  readonly code: string
  readonly versionNo: number
  readonly status: 'DRAFT' | 'PENDING_APPROVAL' | 'PUBLISHED' | 'SUPERSEDED' | 'REJECTED' | 'WITHDRAWN'
  readonly effectiveFrom: Date
  readonly effectiveTo: Date | null
  readonly rules: readonly WorkflowRuleSnapshot[]
}

/** What a request is, for the conditions of the rules (BR-WF-07) */
export interface ReviewInput {
  readonly requestType: string
  /** Satang, VAT included: $amountGross whatever the DOA's basis */
  readonly amountGross: Satang
  readonly amountNet: Satang
  readonly lineCategories: readonly string[]
  readonly budgetAccountCodes: readonly string[]
  /** The answers of the request's form */
  readonly fields: Readonly<Record<string, unknown>>
  readonly requesterMemberId: string
  readonly conflictMemberIds: readonly string[]
  readonly at: Date
  /** For the delegation of a slot (BR-DLG-01 to 05) */
  readonly basisAmountSatang: bigint | null
}

export interface ReviewAssignee {
  readonly assigneeMemberId: string
  readonly principalMemberId: string | null
  /** e.g. "POSITION:DM@LEG" */
  readonly resolvedFrom: string
  readonly notifyOrgAdmin: boolean
}

export interface ReviewSlot {
  readonly slotNo: number
  /** Every rule the slot answers for (a merged slot keeps them all, BR-WF-02) */
  readonly ruleCodes: readonly string[]
  /** One, or the reviewers of the ANY rules: whoever decides first decides the slot */
  readonly assignees: readonly ReviewAssignee[]
  /** The reviewer was vacant or conflicted, so the fallback holds the slot */
  readonly fallback: 'VACANT' | 'CONFLICT' | null
  /** The least of its rules' (BR-WF-15) */
  readonly slaBusinessMinutes: number
}

export interface ReviewGroup {
  readonly ruleCodes: readonly string[]
  readonly quorum: Quorum
  readonly quorumCount: number | null
  readonly slotNos: readonly number[]
}

export interface ReviewStep {
  readonly workflowVersionId: string
  readonly workflowCode: string
  readonly versionNo: number
  readonly slots: readonly ReviewSlot[]
  readonly groups: readonly ReviewGroup[]
  /** The most of its slots' (BR-WF-15) */
  readonly slaBusinessMinutes: number
}

/** BR-WF-12 as BR-DOA-01: the PUBLISHED or SUPERSEDED version with effectiveFrom ≤ at < effectiveTo; the latest start wins */
export function workflowVersionAt(versions: readonly WorkflowVersionSnapshot[], at: Date): WorkflowVersionSnapshot | null {
  const t = at.getTime()
  const live = versions.filter((v) => (v.status === 'PUBLISHED' || v.status === 'SUPERSEDED') && v.effectiveFrom.getTime() <= t && (v.effectiveTo === null || t < v.effectiveTo.getTime()))
  live.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.versionNo - a.versionNo)
  return live[0] ?? null
}

/** The set variables of BR-WF-07 */
export const SET_VARIABLES: readonly string[] = ['$lineCategories', '$budgetAccountCodes']
/** Every special variable a workflow condition may name */
export const WORKFLOW_VARIABLES: readonly string[] = ['$amountGross', '$amountNet', '$requestType', ...SET_VARIABLES]

/** BR-WF-07: a condition holds for the request; anyIn = the set and the list share a member; the ops of §7.9 keep their meaning */
export function workflowConditionHolds(when: WorkflowCondition, input: ReviewInput): boolean {
  if ('all' in when) return (when.all as readonly WorkflowCondition[]).every((c) => workflowConditionHolds(c, input))
  if ('any' in when) return (when.any as readonly WorkflowCondition[]).some((c) => workflowConditionHolds(c, input))
  if (!('field' in when)) return true
  const c = when as { field: string; op: string; value?: unknown; money?: boolean }
  if (c.op === 'anyIn') {
    const set = c.field === '$lineCategories' ? input.lineCategories : c.field === '$budgetAccountCodes' ? input.budgetAccountCodes : toList(input.fields[c.field])
    return Array.isArray(c.value) && c.value.some((v) => set.includes(String(v)))
  }
  const form: FormInput = { fields: input.fields, attachments: {}, variables: { $amountGross: input.amountGross, $amountNet: input.amountNet, $requestType: input.requestType } }
  return evaluateCondition(c as FormCondition, form)
}

const toList = (v: unknown): readonly string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)])

type Found = { readonly memberId: string; readonly resolvedFrom: string; readonly viaPosition: boolean }

/** BR-WF-08: POSITION_AT walks up from its department to the root and takes the first active holder; MEMBER names a person */
export function resolveReviewer(spec: ReviewerSpec, org: OrgSnapshot, at: Date): Found | null {
  const active = (id: string) => org.members.find((m) => m.id === id)?.active === true
  if (spec.kind === 'MEMBER') return active(spec.memberId) ? { memberId: spec.memberId, resolvedFrom: `MEMBER:${spec.memberId}`, viaPosition: false } : null
  const start = org.departments.find((d) => d.code === spec.department)
  if (!start) return null
  for (const department of departmentPath(org, start.id)) {
    const memberId = holderAt(org, spec.position, department.id, at)
    if (memberId) return { memberId, resolvedFrom: `POSITION:${spec.position}@${department.code}`, viaPosition: true }
  }
  return null
}

const reviewerText = (spec: ReviewerSpec) => (spec.kind === 'MEMBER' ? { position: `MEMBER:${spec.memberId}`, department: '' } : { position: spec.position, department: spec.department })

/** One reviewer of a rule, or its fallback when the reviewer is vacant or conflicts with the request (BR-WF-08) */
function reviewerOrFallback(rule: WorkflowRuleSnapshot, spec: ReviewerSpec, input: ReviewInput, org: OrgSnapshot): { found: Found; fallback: 'VACANT' | 'CONFLICT' | null } | null {
  const conflicts = (f: Found) => input.conflictMemberIds.includes(f.memberId)
  const own = resolveReviewer(spec, org, input.at)
  if (own && !conflicts(own)) return { found: own, fallback: null }
  const backup = rule.fallback ? resolveReviewer(rule.fallback, org, input.at) : null
  if (!backup || conflicts(backup)) return null
  return { found: backup, fallback: own ? 'CONFLICT' : 'VACANT' }
}

interface Draft {
  ruleCodes: string[]
  found: Array<{ found: Found; fallback: 'VACANT' | 'CONFLICT' | null }>
  sla: number
  /** The groups that count this slot, by index */
  groups: Set<number>
}

/**
 * The REVIEW step of a request (BR-WF-06): null when no rule of the version in effect matches. Slots: each ALL rule
 * one slot (sortOrder), the ANY rules together one slot of several reviewers, each reviewer of a COUNT rule a slot;
 * then slots of the same person merge into the first (BR-WF-02) and count in every group that had them.
 */
export function resolveReviewStep(versions: readonly WorkflowVersionSnapshot[], input: ReviewInput, org: OrgSnapshot, delegations: readonly DelegationSnapshot[]): Result<ReviewStep | null> {
  const version = workflowVersionAt(versions, input.at)
  if (!version) return ok(null)
  const matched = version.rules.filter((r) => r.requestTypeCodes.includes(input.requestType) && workflowConditionHolds(r.when, input))
  if (matched.length === 0) return ok(null)
  const bySort = (a: WorkflowRuleSnapshot, b: WorkflowRuleSnapshot) => a.sortOrder - b.sortOrder
  const notFound = (rule: WorkflowRuleSnapshot, spec: ReviewerSpec) => err('REVIEWER_NOT_FOUND', 'no reviewer or fallback for the rule', { rule: rule.code, ...reviewerText(spec) })

  const drafts: Draft[] = []
  const groups: Array<{ ruleCodes: string[]; quorum: Quorum; quorumCount: number | null }> = []
  for (const rule of matched.filter((r) => r.mode === 'ALL').sort(bySort)) {
    const one = reviewerOrFallback(rule, rule.reviewers[0]!, input, org)
    if (!one) return notFound(rule, rule.reviewers[0]!)
    groups.push({ ruleCodes: [rule.code], quorum: 'ALL', quorumCount: null })
    drafts.push({ ruleCodes: [rule.code], found: [one], sla: rule.slaBusinessMinutes, groups: new Set([groups.length - 1]) })
  }
  const anyRules = matched.filter((r) => r.mode === 'ANY').sort(bySort)
  if (anyRules.length > 0) {
    const found: Draft['found'] = []
    for (const rule of anyRules) {
      const one = reviewerOrFallback(rule, rule.reviewers[0]!, input, org)
      if (!one) return notFound(rule, rule.reviewers[0]!)
      if (!found.some((f) => f.found.memberId === one.found.memberId)) found.push(one)
    }
    groups.push({ ruleCodes: anyRules.map((r) => r.code), quorum: 'ANY', quorumCount: null })
    drafts.push({ ruleCodes: anyRules.map((r) => r.code), found, sla: Math.min(...anyRules.map((r) => r.slaBusinessMinutes)), groups: new Set([groups.length - 1]) })
  }
  for (const rule of matched.filter((r) => r.mode === 'COUNT').sort(bySort)) {
    const own: Draft[] = []
    for (const spec of rule.reviewers) {
      const one = reviewerOrFallback(rule, spec, input, org)
      if (one && !own.some((d) => d.found[0]!.found.memberId === one.found.memberId)) own.push({ ruleCodes: [rule.code], found: [one], sla: rule.slaBusinessMinutes, groups: new Set() })
    }
    if (own.length < (rule.quorumCount ?? rule.reviewers.length)) return notFound(rule, rule.reviewers[0]!)
    groups.push({ ruleCodes: [rule.code], quorum: 'COUNT', quorumCount: rule.quorumCount })
    for (const d of own) d.groups.add(groups.length - 1)
    drafts.push(...own)
  }

  // BR-WF-02: one person holds one slot of the step. A slot of one person whose person already holds a slot merges into
  // it; a person in the slot of the ANY rules who holds a slot of their own leaves it, and their slot counts for the ANY
  // group too (an ANY group may then have several slots, decided by the first)
  const merged: Draft[] = []
  const holderOf = (person: string) => merged.find((m) => m.found.length === 1 && m.found[0]!.found.memberId === person)
  for (const d of drafts) {
    const own: Draft = { ...d, ruleCodes: [...d.ruleCodes], found: [...d.found], groups: new Set(d.groups) }
    for (const f of [...own.found]) {
      const holder = own.found.length > 1 || d.found.length > 1 ? holderOf(f.found.memberId) : undefined
      if (!holder) continue
      own.found = own.found.filter((x) => x !== f)
      for (const g of own.groups) holder.groups.add(g)
    }
    if (own.found.length === 0) continue
    const person = own.found.length === 1 && d.found.length === 1 ? own.found[0]!.found.memberId : null
    const into = person ? holderOf(person) : undefined
    if (into) {
      into.ruleCodes.push(...own.ruleCodes.filter((code) => !into.ruleCodes.includes(code)))
      for (const g of own.groups) into.groups.add(g)
      into.sla = Math.min(into.sla, own.sla)
      continue
    }
    if (person) {
      // A person in an earlier slot of several (the ANY rules) leaves it for this slot of their own
      for (const m of merged) {
        if (m.found.length > 1 && m.found.some((x) => x.found.memberId === person)) {
          m.found = m.found.filter((x) => x.found.memberId !== person)
          for (const g of m.groups) own.groups.add(g)
        }
      }
    }
    merged.push(own)
  }

  const context = { documentType: 'PURCHASE_REQUEST' as const, basisAmountSatang: input.basisAmountSatang, at: input.at, conflictMemberIds: input.conflictMemberIds }
  const active = (memberId: string) => org.members.find((m) => m.id === memberId)?.active === true
  const slots: ReviewSlot[] = merged.map((d, i) => ({
    slotNo: i + 1,
    ruleCodes: d.ruleCodes,
    assignees: d.found.map((f) => ({ ...delegateFor({ memberId: f.found.memberId, viaPosition: f.found.viaPosition }, context, delegations, active), resolvedFrom: f.found.resolvedFrom })),
    fallback: d.found.length === 1 ? d.found[0]!.fallback : null,
    slaBusinessMinutes: d.sla,
  }))
  const reviewGroups: ReviewGroup[] = groups.map((g, gi) => ({ ...g, slotNos: merged.flatMap((d, i) => (d.groups.has(gi) ? [i + 1] : [])) }))
  return ok({ workflowVersionId: version.id, workflowCode: version.code, versionNo: version.versionNo, slots, groups: reviewGroups, slaBusinessMinutes: Math.max(...slots.map((s) => s.slaBusinessMinutes)) })
}

export interface RequestRoute {
  readonly review: ReviewStep | null
  readonly approval: RouteResult
}

/**
 * The route of a purchase request (BR-WF-06): the REVIEW step of the workflow version in effect, then the DOA steps of
 * resolveRoute unchanged (INV-WF-01). Either refusal comes back as it is.
 */
export function resolveRequestRoute(
  route: RouteInput,
  review: Omit<ReviewInput, 'requesterMemberId' | 'conflictMemberIds' | 'at' | 'basisAmountSatang'>,
  policy: RoutePolicy & { readonly workflows: readonly WorkflowVersionSnapshot[] },
): Result<RequestRoute> {
  const approval = resolveRoute(route, policy)
  if (!approval.ok) return approval
  const step = resolveReviewStep(
    policy.workflows,
    { ...review, requesterMemberId: route.requesterMemberId, conflictMemberIds: route.conflictMemberIds, at: route.at, basisAmountSatang: approval.data.basisAmountSatang },
    policy.org,
    policy.delegations,
  )
  if (!step.ok) return step
  return ok({ review: step.data, approval: approval.data })
}
