import { resolveRoute, type RoutePolicy } from '../doa'
import type { DoaVersionSnapshot, RouteInput, RouteResult } from '../doa/types'
import { resolveRequestRoute, type ReviewInput, type ReviewStep, type WorkflowVersionSnapshot } from './reviewers'

// The 90-day backtest of a draft (spec §7.17 BR-WF-13 · FR-DOA-103, and a workflow draft): every document sent in the
// window is routed twice with the real engine, on its own input and the organization as it is — by the version that
// was in effect when it was sent ("current"), and by the draft as if it had been in effect then ("draft"). Each row
// says whether the rule, the approvers or the reviewers change; the summary counts the documents, the changed ones and
// what each person would get more or fewer. Pure and read only: the caller picks the documents and the policy.

export interface BacktestSide {
  /** The rule the route runs under; null when the engine refused it */
  readonly rule: string | null
  /** Every approver of the DOA steps, a committee's slot holders included, in order */
  readonly approvers: readonly string[]
  /** The reviewers of the REVIEW step (a workflow backtest); empty without one */
  readonly reviewers: readonly string[]
  /** The engine's refusal (APPROVER_NOT_FOUND, REVIEWER_NOT_FOUND, …), or null */
  readonly error: string | null
}

export interface BacktestRow {
  readonly ref: string
  readonly current: BacktestSide
  readonly draft: BacktestSide
  readonly changed: boolean
}

export interface BacktestSummary {
  readonly total: number
  readonly changed: number
  /** Tasks per member the draft gives minus what the version in effect gave, for the members whose count changes */
  readonly load: Readonly<Record<string, number>>
}

export interface BacktestResult {
  readonly rows: readonly BacktestRow[]
  readonly summary: BacktestSummary
}

export interface BacktestDocument {
  readonly ref: string
  /** The document's route input; `at` is when it was sent */
  readonly route: RouteInput
}

const approversOf = (route: RouteResult): string[] => route.steps.flatMap((s) => (s.committee ? s.committee.slots.map((x) => x.assigneeMemberId) : [s.assigneeMemberId]))
const reviewersOf = (review: ReviewStep | null): string[] => review?.slots.flatMap((s) => s.assignees.map((a) => a.assigneeMemberId)) ?? []
const refused = (code: string): BacktestSide => ({ rule: null, approvers: [], reviewers: [], error: code })

/** A draft as if it had been in effect at any time: the only version of its kind the engine sees */
const asInEffect = <V extends { readonly status: string; readonly effectiveFrom: Date; readonly effectiveTo: Date | null }>(draft: V): V => ({ ...draft, status: 'PUBLISHED', effectiveFrom: new Date(0), effectiveTo: null })

function sameSide(a: BacktestSide, b: BacktestSide): boolean {
  return a.rule === b.rule && a.error === b.error && a.approvers.join(',') === b.approvers.join(',') && a.reviewers.join(',') === b.reviewers.join(',')
}

export function summarizeBacktest(rows: readonly BacktestRow[]): BacktestSummary {
  const load = new Map<string, number>()
  const add = (side: BacktestSide, by: number) => {
    for (const m of [...side.reviewers, ...side.approvers]) load.set(m, (load.get(m) ?? 0) + by)
  }
  for (const row of rows) {
    if (!row.changed) continue
    add(row.current, -1)
    add(row.draft, 1)
  }
  return { total: rows.length, changed: rows.filter((r) => r.changed).length, load: Object.fromEntries([...load].filter(([, n]) => n !== 0).sort(([a], [b]) => a.localeCompare(b))) }
}

function result(rows: BacktestRow[]): BacktestResult {
  return { rows, summary: summarizeBacktest(rows) }
}

/** A DOA draft against the versions that were in effect (FR-DOA-103) */
export function backtestPolicy(documents: readonly BacktestDocument[], policy: RoutePolicy, draft: DoaVersionSnapshot): BacktestResult {
  const drafted: RoutePolicy = { ...policy, versions: [asInEffect(draft)] }
  const side = (input: RouteInput, p: RoutePolicy): BacktestSide => {
    const route = resolveRoute(input, p)
    return route.ok ? { rule: route.data.ruleCode, approvers: approversOf(route.data), reviewers: [], error: null } : refused(route.error.code)
  }
  return result(
    documents.map((d) => {
      const current = side(d.route, policy)
      const next = side(d.route, drafted)
      return { ref: d.ref, current, draft: next, changed: !sameSide(current, next) }
    }),
  )
}

export interface WorkflowBacktestDocument extends BacktestDocument {
  /** What the reviewer rules read of the request (BR-WF-07) */
  readonly review: Omit<ReviewInput, 'requesterMemberId' | 'conflictMemberIds' | 'at' | 'basisAmountSatang'>
}

/** A workflow draft against the workflow versions that were in effect, with the DOA as it was (FR-WF-103) */
export function backtestWorkflow(documents: readonly WorkflowBacktestDocument[], policy: RoutePolicy & { readonly workflows: readonly WorkflowVersionSnapshot[] }, draft: WorkflowVersionSnapshot): BacktestResult {
  const drafted = { ...policy, workflows: [asInEffect(draft)] }
  const side = (d: WorkflowBacktestDocument, p: typeof policy): BacktestSide => {
    const route = resolveRequestRoute(d.route, d.review, p)
    return route.ok ? { rule: route.data.approval.ruleCode, approvers: approversOf(route.data.approval), reviewers: reviewersOf(route.data.review), error: null } : refused(route.error.code)
  }
  return result(
    documents.map((d) => {
      const current = side(d, policy)
      const next = side(d, drafted)
      return { ref: d.ref, current, draft: next, changed: !sameSide(current, next) }
    }),
  )
}
