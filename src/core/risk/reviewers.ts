import type { DelegationSnapshot, OrgSnapshot } from '../doa/types'
import { ok, type Result } from '../result'
import { resolveReviewStep, stepOutcome, type ReviewGroup, type ReviewSlot, type StepOutcomeResult, type WorkflowVersionSnapshot } from '../workflow'
import { RISK_DOMAINS, type RiskDomain, type RiskTierCode, type Screening } from './types'

// The reviewers of a supplier risk assessment (spec §7.24 BR-RSK-07 · ADR-222 · FR-RSK-202): the rules of
// RISK_ASSESSMENT scope of the workflow version in effect, resolved by resolveReviewStep of S6 without changing the engine.
// The engine keeps a rule when its requestTypeCodes hold the input's request type, so the adapter hands it the RISK rules
// only, each standing for the sentinel request type RISK_ASSESSMENT, and a ReviewInput with every field: no money, the
// categories as the line categories, the screening answers and $tier $inherentTier $category $payeeType as the fields the
// conditions read (workflowConditionHolds reads fields[name] for a name outside WORKFLOW_VARIABLES).

/** The request type a RISK rule stands for inside the engine; no request type of an organization has this code */
export const RISK_REVIEW_REQUEST_TYPE = 'RISK_ASSESSMENT'

export interface RiskReviewInput {
  readonly screening: Screening
  /** The tier frozen at the send */
  readonly tier: RiskTierCode
  readonly inherentTier: RiskTierCode
  readonly categoryCodes: readonly string[]
  readonly payeeType: string | null
  readonly openedById: string
  /** Every member who answered for the supplier: with the opener, never a reviewer of the assessment (BR-SOD ข้อ 16) */
  readonly filledOnBehalfByIds: readonly string[]
  readonly at: Date
}

export interface RiskReviewSlot extends ReviewSlot {
  /** The parts of the assessment the slot's reviewer sees besides GENERAL (BR-RSK-08): every domain of its rules */
  readonly riskDomains: readonly RiskDomain[]
}

export interface RiskReviewStep {
  readonly workflowVersionId: string
  readonly workflowCode: string
  readonly versionNo: number
  readonly slots: readonly RiskReviewSlot[]
  readonly groups: readonly ReviewGroup[]
}

/**
 * A delegation counts for a reviewer's task only when it limits neither the document types nor the amount (BR-DLG-01:
 * a task of no DOA document type and no amount · GC-RSK-31 GC-RSK-32). The engine's own delegation context names
 * PURCHASE_REQUEST, so a limited delegation would otherwise be read as one for requests.
 */
export const delegationCoversReview = (d: DelegationSnapshot): boolean => (d.documentTypes === null || d.documentTypes.length === 0) && d.maxAmountSatang === null

/** BR-RSK-07: the slots of the RISK rules that match the assessment; null = no rule matches (the assessment completes) */
export function riskReviewers(versions: readonly WorkflowVersionSnapshot[], input: RiskReviewInput, org: OrgSnapshot, delegations: readonly DelegationSnapshot[]): Result<RiskReviewStep | null> {
  const riskOnly: WorkflowVersionSnapshot[] = versions.map((v) => ({
    ...v,
    rules: v.rules.filter((r) => r.scope === 'RISK_ASSESSMENT').map((r) => ({ ...r, requestTypeCodes: [RISK_REVIEW_REQUEST_TYPE] })),
  }))
  const step = resolveReviewStep(
    riskOnly,
    {
      requestType: RISK_REVIEW_REQUEST_TYPE,
      amountGross: 0n,
      amountNet: 0n,
      basisAmountSatang: null,
      lineCategories: [...input.categoryCodes],
      budgetAccountCodes: [],
      fields: { ...input.screening, $tier: input.tier, $inherentTier: input.inherentTier, $category: [...input.categoryCodes], $payeeType: input.payeeType },
      requesterMemberId: input.openedById,
      conflictMemberIds: [...new Set([input.openedById, ...input.filledOnBehalfByIds])],
      at: input.at,
    },
    org,
    delegations.filter(delegationCoversReview),
  )
  if (!step.ok) return step
  if (step.data === null) return ok(null)
  const { workflowVersionId, workflowCode, versionNo, slots, groups } = step.data
  const rules = riskOnly.find((v) => v.id === workflowVersionId)!.rules
  const domainsOf = (ruleCodes: readonly string[]): RiskDomain[] => RISK_DOMAINS.filter((d) => rules.some((r) => ruleCodes.includes(r.code) && r.riskDomains?.includes(d)))
  return ok({ workflowVersionId, workflowCode, versionNo, slots: slots.map((s) => ({ ...s, riskDomains: domainsOf(s.ruleCodes) })), groups })
}

export type ReviewDecision = 'PASS' | 'RETURN'

/**
 * The outcome of a round of reviewers (BR-RSK-07): stepOutcome kind REVIEW of S6 with each PASS as APPROVE. Every rule of
 * RISK scope is a group of quorum ALL (WF_LINT_RISK_QUORUM), so a rule's group is the slots that answer for it. The slots
 * are those of one round, numbered from 1.
 */
export function riskReviewOutcome(slots: ReadonlyArray<{ readonly slotNo: number; readonly ruleCodes: readonly string[]; readonly decision: ReviewDecision | null }>): 'OPEN' | 'COMPLETED' | 'RETURNED' {
  const ordered = [...slots].sort((a, b) => a.slotNo - b.slotNo)
  const ruleCodes = [...new Set(ordered.flatMap((s) => s.ruleCodes))]
  const groups = ruleCodes.map((code) => ({ quorum: 'ALL' as const, slots: ordered.filter((s) => s.ruleCodes.includes(code)).map((s) => s.slotNo) }))
  // a reviewer passes or returns and never rejects, so stepOutcome never refuses this input
  const result = stepOutcome({ kind: 'REVIEW', groups, slots: ordered.map((s) => (s.decision === 'PASS' ? 'APPROVE' : s.decision)) }) as { readonly ok: true; readonly data: StepOutcomeResult }
  const outcome = result.data.outcome
  return outcome === 'APPROVED' ? 'COMPLETED' : outcome === 'RETURNED' ? 'RETURNED' : 'OPEN'
}
